import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, apply, inject } from '../src/index.ts'
import { DogEngine } from '../src/core.ts'
import {
  DOG_BIND_AGENT_TOOL,
  DOG_CREATE_TOOL,
  DOG_DELEGATE_AGENT_TOOL,
  DOG_RUN_TOOL,
  DOG_STATUS_TOOL,
  DOG_VALIDATE_TOOL,
  createDogDelegateAgentTool,
} from '../src/tools.ts'
import type { DogGraphInput } from '../src/model.ts'
import { DogRepository } from '../src/storage.ts'
import { injectAgenticAudit } from './helpers.ts'

const temporaryRoots: string[] = []
const originalDshHome = process.env.DSH_HOME

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-dog-plugin-'))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)))
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function deploymentConfig(workspace: string) {
  return Config({
    artifactRoots: [{ id: 'workspace', path: workspace }],
    artifactBindings: [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }],
    storageDirectory: 'dog',
    maxGraphNodes: 256,
    maxExpressionNodes: 512,
    maxExpressionDepth: 64,
    maxSnapshotBytes: 67_108_864,
    allowPartialRoot: false,
    maxConcurrentVerifications: 1,
    revalidateThreshold: 1,
    gmDigestAlgo: 'sha256',
    subagentProvider: 'spawn',
    subagentMaxDepth: 3,
  })
}

function candidateGraph(): DogGraphInput {
  return injectAgenticAudit({
    schemaVersion: '0.2',
    id: 'plugin-smoke',
    root: 'root',
    nodes: {
      root: {
        kind: 'composite',
        title: 'verified artifact',
        constraint: 'hard',
        completion: { op: 'ref', id: 'leaf' },
      },
      leaf: {
        kind: 'leaf',
        title: 'artifact exists',
        constraint: 'hard',
        verifier: { id: 'file.exists', version: '1' },
        verifierParams: { artifactId: 'artifact' },
      },
    },
    contains: [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal' }],
    dependsOn: [],
  })
}

describe.sequential('DoG Cordis plugin', () => {
  it('registers exactly five model tools and removes them on fiber disposal', async () => {
    const home = await temporaryRoot()
    const workspace = await temporaryRoot()
    process.env.DSH_HOME = home
    const ctx = await setup()
    const config = deploymentConfig(workspace)
    const fiber = await ctx.plugin({ inject, apply }, config)
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
      DOG_BIND_AGENT_TOOL,
      DOG_CREATE_TOOL,
      DOG_RUN_TOOL,
      DOG_STATUS_TOOL,
      DOG_VALIDATE_TOOL,
    ])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('executes validate, create, run, and status through the real ToolRuntime boundary', async () => {
    const home = await temporaryRoot()
    const workspace = await temporaryRoot()
    process.env.DSH_HOME = home
    await writeFile(join(workspace, 'artifact.txt'), 'verified')
    const ctx = await setup()
    const config = deploymentConfig(workspace)
    const fiber = await ctx.plugin({ inject, apply }, config)
    const signal = new AbortController().signal
    const agent = { id: 'session-plugin-test', session: { header: { parentSession: 'parent-plugin-test' } } } as Agent

    const validate = await ctx.tools.execute({
      callId: CallId('validate'),
      name: DOG_VALIDATE_TOOL,
      arguments: { graph: candidateGraph() },
      signal,
    })
    expect(validate.isError).toBe(false)
    if (validate.isError) throw new Error(validate.error.message)
    expect(validate.value).toEqual({ valid: true, errors: [], warnings: [] })

    const create = await ctx.tools.execute({
      callId: CallId('create'),
      name: DOG_CREATE_TOOL,
      arguments: { graph: candidateGraph() },
      signal,
    })
    expect(create.isError).toBe(false)
    if (create.isError) throw new Error(create.error.message)
    expect(create.value).toMatchObject({ graphId: 'plugin-smoke' })

    const run = await ctx.tools.execute({
      callId: CallId('run'),
      name: DOG_RUN_TOOL,
      arguments: { graphId: 'plugin-smoke' },
      signal,
      agent,
    })
    expect(run.isError).toBe(false)
    if (run.isError) throw new Error(run.error.message)
    expect(run.value).toMatchObject({ graphId: 'plugin-smoke', state: 'running' })
    if (typeof run.value !== 'object' || run.value === null || Array.isArray(run.value)) throw new Error('run result is not an object')
    const runId = run.value.runId
    if (typeof runId !== 'string') throw new Error('run result has no runId')

    // dog_run is asynchronous: poll dog_status until the background run settles.
    let statusValue: { runId: string; graphId: string; rootState: string; goals: Array<{ goalId: string; state: string }> } | undefined
    for (let attempt = 0; attempt < 25; attempt++) {
      const poll = await ctx.tools.execute({
        callId: CallId(`status-${attempt}`),
        name: DOG_STATUS_TOOL,
        arguments: { runId },
        signal,
      })
      expect(poll.isError).toBe(false)
      if (poll.isError) throw new Error(poll.error.message)
      const value = poll.value as { runId: string; graphId: string; rootState: string; goals: Array<{ goalId: string; state: string }> }
      if (value.rootState !== 'running' && value.rootState !== undefined) {
        statusValue = value
        break
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(statusValue).toBeDefined()
    if (statusValue === undefined) throw new Error('run did not settle within the polling window')

    const bind = await ctx.tools.execute({
      callId: CallId('bind'),
      name: DOG_BIND_AGENT_TOOL,
      arguments: { runId, goalId: 'root', role: 'orchestrator' },
      signal,
      agent,
    })
    expect(bind.isError).toBe(false)
    if (bind.isError) throw new Error(bind.error.message)
    expect(bind.value).toMatchObject({
      runId,
      goalId: 'root',
      agent: {
        sessionId: 'session-plugin-test',
        parentSessionId: 'parent-plugin-test',
        role: 'orchestrator',
      },
    })

    expect(statusValue).toMatchObject({
      runId,
      graphId: 'plugin-smoke',
      rootState: 'success',
    })
    const rootReport = statusValue.goals.find(goal => goal.goalId === 'root')
    expect(rootReport).toMatchObject({ state: 'success' })
    const runFiles = await readdir(join(home, 'dog', 'runs'))
    expect(runFiles).toHaveLength(1)
    const runFile = runFiles[0]
    if (runFile === undefined) throw new Error('persisted run file is missing')
    expect(JSON.parse(await readFile(join(home, 'dog', 'runs', runFile), 'utf8')))
      .toMatchObject({
        runId,
        rootState: 'success',
        invocation: { callId: 'run', agentSessionId: 'session-plugin-test', parentSessionId: 'parent-plugin-test' },
        goals: {
          root: {
            agentSessions: [{
              sessionId: 'session-plugin-test',
              parentSessionId: 'parent-plugin-test',
              role: 'orchestrator',
            }],
          },
        },
      })
    await fiber.dispose()
  })

  it('starts a continuable child through the host launcher and persists its DoG binding', async () => {
    const home = await temporaryRoot()
    const workspace = await temporaryRoot()
    await writeFile(join(workspace, 'artifact.txt'), 'verified')
    const config = deploymentConfig(workspace)
    const engine = new DogEngine({ config, repository: new DogRepository(join(home, 'dog')) })
    await engine.create(candidateGraph())
    const run = await engine.run('plugin-smoke', {
      invocation: { callId: 'owner-run', agentSessionId: 'owner-session' },
    })
    const launched: { label: string; prompt: string; parent: unknown }[] = []
    const ctx = await setup()
    ctx.effect(() => ctx.tools.register(createDogDelegateAgentTool(engine, {
      async launch(input) {
        launched.push({ label: input.label, prompt: input.prompt, parent: input.parent })
        return { sessionId: 'continuable-child' }
      },
    })))
    const agent = { id: 'owner-session', session: { header: {} } } as Agent
    const delegated = await ctx.tools.execute({
      callId: CallId('delegate'),
      name: DOG_DELEGATE_AGENT_TOOL,
      arguments: {
        runId: run.runId,
        goalId: 'leaf',
        role: 'verifier',
        label: 'artifact worker',
        prompt: 'Inspect the artifact and report evidence.',
      },
      signal: new AbortController().signal,
      agent,
    })
    expect(delegated.isError).toBe(false)
    if (delegated.isError) throw new Error(delegated.error.message)
    expect(delegated.value).toMatchObject({
      runId: run.runId,
      goalId: 'leaf',
      lifecycle: 'continuable',
      agent: {
        sessionId: 'continuable-child',
        parentSessionId: 'owner-session',
        role: 'verifier',
      },
    })
    expect(launched).toEqual([{ label: 'artifact worker', prompt: 'Inspect the artifact and report evidence.', parent: agent }])
    await expect(engine.status(run.runId)).resolves.toMatchObject({
      goals: {
        leaf: {
          agentSessions: [{
            sessionId: 'continuable-child',
            parentSessionId: 'owner-session',
            role: 'verifier',
          }],
        },
      },
    })
  })
})
