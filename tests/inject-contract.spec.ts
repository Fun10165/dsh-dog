/**
 * Inject-contract regression: the plugin must load under a REAL Cordis context.
 *
 * Cordis gates every typed service access on the caller's `inject` list — an
 * undeclared access throws `cannot get property "<name>" without inject` at the
 * first use, which unit tests with a fake ctx never observe. This test provides
 * the declared services from a SIBLING plugin (exactly as the real composition
 * does), loads the real plugin through `ctx.plugin`, and drives one agentic
 * leaf whose settlement only completes after the runner's liveness probe reads
 * `ctx.agents` — so dropping `agents` from `inject` (the v1.3.0-alpha.1 defect)
 * fails here instead of in production.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as dog from '../src/dsh/plugin.ts'
import { DOG_CREATE_TOOL, DOG_RUN_TOOL, DOG_STATUS_TOOL } from '../src/dsh/tools.ts'
import { compositeNode, ensureScripts, leafNode, mkConfig, temporaryRoot } from './helpers.ts'

const CHILD_ID = 'stub-child-1'

let savedHome: string | undefined
afterEach(() => {
 if (savedHome === undefined) delete process.env.DSH_HOME
 else process.env.DSH_HOME = savedHome
 savedHome = undefined
})

/** Minimal tool execution context; the agent id is all the tools read. */
function exec(agentId: string): { signal: AbortSignal; callId: string; agent: Agent } {
 return {
  signal: new AbortController().signal,
  callId: 'call-inject-1',
  agent: { id: agentId } as unknown as Agent,
 }
}

describe('Cordis inject contract', () => {
 it('loads under a real Context and settles an agentic leaf (ctx.agents is declared)', async () => {
  const root = await temporaryRoot()
  // Isolate the DoG store: without this the engine would inherit a verdict
  // from the developer's real ~/.dsh/dog and never invoke a kernel at all.
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-dog-home-'))
  await ensureScripts(root)
  const workspace = join(root, 'session-workspace')
  await writeFile(join(root, 'artifact.txt'), 'verified')

  const registered: ToolDefinition[] = []
  let settlementPath: string | undefined
  let startCalls = 0
  let probeCalls = 0
  const app = new Context()
  // Services are provided by a SIBLING plugin, exactly as the real composition
  // does (dsh-base owns tools/sessions/agents, dsh-tool-subagent owns
  // subagents). A root-level provide() would be reachable by every child
  // without declaring inject and would hide the defect under test.
  await app.plugin({
   name: 'stub-host-services',
   apply(host: Context): void {
    host.provide('tools', {
     register: (definition: ToolDefinition) => {
      registered.push(definition)
      return () => undefined
     },
    })
    host.provide('sessions', {
     get: (id: string) => id === CHILD_ID
      // The child's turn is still open, so the liveness probe answers
      // "not settled" and the file wait polls again.
      ? { snapshotEvents: () => [{ type: 'tool/result' }] }
      : { header: { cwd: workspace } },
    })
    // The liveness probe resolves through this service (declared in
    // inject) and writes the settlement file as a side effect, so the
    // wait loop's second poll succeeds — the probe drives the run forward.
    host.provide('agents', {
     get: () => {
      probeCalls += 1
      if (settlementPath !== undefined) {
       void writeFile(settlementPath, JSON.stringify({ verdict: 'pass', evidence: { stub: true } }))
      }
      return { id: CHILD_ID }
     },
    })
    host.provide('subagents', {
     async startContinuable(spec: { request: { prompt: { text: string }[] } }) {
      startCalls += 1
      const match = /exact absolute path: (\S+?)\.\s/u.exec(spec.request.prompt[0]?.text ?? '')
      settlementPath = match?.[1]
      return { childId: CHILD_ID, messageId: 'stub-message-1' }
     },
     interrupt: () => undefined,
     drainContinuableChildren: async () => undefined,
    })
   },
  })

  await app.plugin(
   { name: dog.name, inject: dog.inject, Config: dog.Config, apply: dog.apply },
   { ...mkConfig(root, join(root, 'scripts')), subagentProvider: 'spawn', subagentMaxDepth: 3 },
  )

  const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
   const tool = registered.find(candidate => candidate.name === name)
   if (tool === undefined) throw new Error(`tool ${name} was not registered`)
   const value = await tool.execute(args, exec('session-agent-1') as never)
   return value as Record<string, unknown>
  }

  const created = await call(DOG_CREATE_TOOL, {
   graph: {
    schemaVersion: '0.9',
    id: 'inject-contract',
    root: 'root',
    nodes: {
     root: compositeNode({ op: 'ref', id: 'audit' }),
     audit: leafNode({
      title: 'audit',
      verifier: { mode: 'agentic', instruction: 'Judge the artifact.' },
     }),
    },
    contains: [{ parent: 'root', child: 'audit', required: true, failure: 'fatal' }],
    dependsOn: [],
   },
  })
  expect(created.graphId).toBe('inject-contract')

  const started = await call(DOG_RUN_TOOL, { graphId: 'inject-contract' })
  const runId = started.runId as string
  expect(typeof runId).toBe('string')

  // The run executes in the background; poll the status tool until terminal.
  let state = 'running'
  for (let attempt = 0; attempt < 200 && state === 'running'; attempt += 1) {
   await new Promise(resolve => setTimeout(resolve, 50))
   const status = await call(DOG_STATUS_TOOL, { runId })
   state = String(status.rootState ?? status.state)
  }
  expect(state).toBe('success')
  // The agentic kernel really ran, and the liveness probe really read
  // ctx.agents — otherwise this test would pass for the wrong reason.
  expect(startCalls).toBe(1)
  expect(probeCalls).toBeGreaterThan(0)
 }, 30_000)
})
