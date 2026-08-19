import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, apply, inject } from '../src/index.ts'
import { DOG_CREATE_TOOL, DOG_RUN_TOOL, DOG_STATUS_TOOL, DOG_VALIDATE_TOOL } from '../src/tools.ts'
import type { DogGraphInput } from '../src/model.ts'

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
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
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
  })
}

function candidateGraph(): DogGraphInput {
  return {
    schemaVersion: '0.1',
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
    contains: [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }],
    dependsOn: [],
  }
}

describe.sequential('DoG Cordis plugin', () => {
  it('registers exactly four model tools and removes them on fiber disposal', async () => {
    const home = await temporaryRoot()
    const workspace = await temporaryRoot()
    process.env.DSH_HOME = home
    const ctx = await setup()
    const config = deploymentConfig(workspace)
    const fiber = await ctx.plugin({ inject, apply }, config)
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
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
    })
    expect(run.isError).toBe(false)
    if (run.isError) throw new Error(run.error.message)
    expect(run.value).toMatchObject({ graphId: 'plugin-smoke', rootState: 'success' })
    if (typeof run.value !== 'object' || run.value === null || Array.isArray(run.value)) throw new Error('run result is not an object')
    const runId = run.value.runId
    if (typeof runId !== 'string') throw new Error('run result has no runId')

    const status = await ctx.tools.execute({
      callId: CallId('status'),
      name: DOG_STATUS_TOOL,
      arguments: { runId },
      signal,
    })
    expect(status.isError).toBe(false)
    if (status.isError) throw new Error(status.error.message)
    expect(status.value).toEqual(run.value)
    const runFiles = await readdir(join(home, 'dog', 'runs'))
    expect(runFiles).toHaveLength(1)
    const runFile = runFiles[0]
    if (runFile === undefined) throw new Error('persisted run file is missing')
    expect(JSON.parse(await readFile(join(home, 'dog', 'runs', runFile), 'utf8')))
      .toMatchObject({ runId, rootState: 'success' })
    await fiber.dispose()
  })
})
