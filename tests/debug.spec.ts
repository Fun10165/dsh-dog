import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DogEngine } from '../src/core.ts'
import {
 DOG_RUNTIME_TRACE_ENDPOINT,
 buildDogDebugSnapshot,
 buildGoalRuntimeTrace,
 createDogDebugRpcHandler,
} from '../src/debug.ts'
import { parseDogDebugSnapshot, parseGoalRuntimeTrace } from '../src/client/snapshot.ts'
import type { DogConfig, DogGraphInput } from '../src/model.ts'
import { DogRepository } from '../src/storage.ts'
import { createBuiltinVerifierRegistry } from '../src/verifiers.ts'
import { injectAgenticAudit } from './helpers.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
 await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('debugger snapshot', () => {
 it('never presents an old run against a newer graph revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dog-debug-'))
  temporaryRoots.push(root)
  await writeFile(join(root, 'artifact.txt'), 'verified artifact')
  const repository = new DogRepository(join(root, '.dog-store'))
  const runIds = ['run-old', 'run-current']
  const config: DogConfig = {
   artifactRoots: [{ id: 'workspace', path: root }],
   artifactBindings: [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }],
   storageDirectory: 'dog',
   maxGraphNodes: 32,
   maxExpressionNodes: 64,
   maxExpressionDepth: 16,
   maxSnapshotBytes: 1024 * 1024,
   allowPartialRoot: false,
   maxConcurrentVerifications: 1,
   revalidateThreshold: 1,
   gmDigestAlgo: 'sha256',
  }
  const engine = new DogEngine({
   config,
   repository,
   now: () => new Date('2026-08-19T12:00:00.000Z'),
   nextRunId: () => runIds.shift() ?? 'unexpected-run',
  })
  const first = await engine.create(graph('Verify the first revision'))
  const firstRun = await engine.run('debug-demo', { invocation: { callId: 'call-old', agentSessionId: 'session-old' } })
  const current = await engine.create(graph('Verify the current revision'))
  const currentRun = await engine.run('debug-demo', { invocation: { callId: 'call-current', agentSessionId: 'session-current', parentSessionId: 'session-parent' } })

  const snapshot = await buildDogDebugSnapshot(repository, () => new Date('2026-08-19T12:01:00.000Z'))
  expect(snapshot.graphs).toHaveLength(2)
  expect(snapshot.graphs.filter(revision => revision.current).map(revision => revision.graph.graphDigest)).toEqual([current.graphDigest])
  expect(snapshot.graphs.find(revision => revision.graph.graphDigest === first.graphDigest)?.runs.map(run => run.runId)).toEqual([firstRun.runId])
  expect(snapshot.graphs.find(revision => revision.graph.graphDigest === current.graphDigest)?.runs.map(run => run.runId)).toEqual([currentRun.runId])

  const transported: unknown = JSON.parse(JSON.stringify(snapshot))
  expect(parseDogDebugSnapshot(transported)).toEqual(snapshot)

  const trace = await buildGoalRuntimeTrace(repository, currentRun.runId, 'leaf')
  expect(trace.invocation).toEqual({
   callId: 'call-current',
   agentSessionId: 'session-current',
   invokedAt: '2026-08-19T12:00:00.000Z',
   parentSessionId: 'session-parent',
  })
  // GM + contract version unchanged from run-old: result is inherited, not re-verified.
  expect(trace.events.map(event => event.phase)).toEqual(['result_inherited'])
  expect(trace.result.state).toBe('inherited')
  expect(trace.result.inheritedFrom).toBe('run-old')
  expect(parseGoalRuntimeTrace(JSON.parse(JSON.stringify(trace)) as unknown)).toEqual(trace)

  const handler = createDogDebugRpcHandler(repository)
  const rpc = await handler(
   DOG_RUNTIME_TRACE_ENDPOINT,
   { runId: currentRun.runId, goalId: 'leaf' },
   new AbortController().signal,
  )
  expect(rpc).toEqual({ ok: true, value: trace })
 })

 it('exposes an in-flight verifier without mixing runtime context into trusted evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dog-runtime-'))
  temporaryRoots.push(root)
  await writeFile(join(root, 'artifact.txt'), 'verified artifact')
  const repository = new DogRepository(join(root, '.dog-store'))
  const verifiers = createBuiltinVerifierRegistry()
  let enteredVerifier: (() => void) | undefined
  let releaseVerifier: (() => void) | undefined
  const entered = new Promise<void>(resolve => { enteredVerifier = resolve })
  const release = new Promise<void>(resolve => { releaseVerifier = resolve })
  verifiers.register({
   id: 'test.deferred',
   version: '1',
   requirement: 'Deferred check before release',
   evidenceSchemaId: 'test.deferred/v1',
   allowedTools: [],
   grounding: { kind: 'programmatic', extractorId: 'file.content', schema: 'file.content/v1' },
   validateParams: params => params,
   execute: async () => {
    enteredVerifier?.()
    await release
    return { state: 'pass', observation: { checked: true } }
   },
  })
  const dog = new DogEngine({
   config: {
    artifactRoots: [{ id: 'workspace', path: root }],
    artifactBindings: [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }],
    storageDirectory: 'dog',
    maxGraphNodes: 32,
    maxExpressionNodes: 64,
    maxExpressionDepth: 16,
    maxSnapshotBytes: 1024 * 1024,
    allowPartialRoot: false,
    maxConcurrentVerifications: 1,
    revalidateThreshold: 1,
    gmDigestAlgo: 'sha256',
   },
   repository,
   verifiers,
   nextRunId: () => 'run-live',
  })
  const candidate = graph('Deferred verifier')
  candidate.nodes.leaf = {
   kind: 'leaf',
   title: 'Deferred verifier',
   constraint: 'hard',
   verifier: { id: 'test.deferred', version: '1' },
   verifierParams: { artifactId: 'artifact' },
  }
  await dog.create(candidate)
  const completion = dog.run('debug-demo', { invocation: { callId: 'call-live', agentSessionId: 'session-live' } })
  await entered

  const liveRun = await repository.loadRun('run-live')
  expect(liveRun).toMatchObject({
   state: 'running',
   invocation: { callId: 'call-live', agentSessionId: 'session-live' },
   goals: { leaf: { state: 'running' } },
  })
  const liveTrace = await buildGoalRuntimeTrace(repository, 'run-live', 'leaf')
  expect(liveTrace.events.map(event => event.phase)).toEqual(['goal_started', 'workspace_allocated', 'verifier_started'])
  expect(liveTrace.events.every(event => !('observation' in event))).toBe(true)

  releaseVerifier?.()
  const completed = await completion
  expect(completed.rootState).toBe('success')
  const completedTrace = await buildGoalRuntimeTrace(repository, 'run-live', 'leaf')
  expect(completedTrace.events.map(event => event.phase)).toEqual([
   'goal_started', 'workspace_allocated', 'verifier_started', 'verifier_passed', 'goal_settled',
  ])
  expect(completedTrace.result.verification?.observation).toEqual({ checked: true })
 })

 it('records a structured verifier error and preserves the honest node result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dog-runtime-error-'))
  temporaryRoots.push(root)
  await writeFile(join(root, 'artifact.txt'), 'verified artifact')
  const repository = new DogRepository(join(root, '.dog-store'))
  const dog = new DogEngine({
   config: {
    artifactRoots: [{ id: 'workspace', path: root }],
    artifactBindings: [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }],
    storageDirectory: 'dog',
    maxGraphNodes: 32,
    maxExpressionNodes: 64,
    maxExpressionDepth: 16,
    maxSnapshotBytes: 1024 * 1024,
    allowPartialRoot: false,
    maxConcurrentVerifications: 1,
    revalidateThreshold: 1,
    gmDigestAlgo: 'sha256',
   },
   repository,
   nextRunId: () => 'run-error',
  })
  const compiled = await dog.create(graph('Verifier error'))
  const snapshotId = compiled.acceptancePlans.leaf?.snapshot.snapshotId
  if (snapshotId === undefined) throw new Error('compiled leaf snapshot is missing')
  await rm(join(root, '.dog-store', 'artifacts', `${snapshotId.replaceAll(/[^a-zA-Z0-9_-]/gu, '_')}.bin`))

  const run = await dog.run('debug-demo', { invocation: { callId: 'call-error', agentSessionId: 'session-error' } })
  expect(run.rootState).toBe('needs_replan')
  const trace = await buildGoalRuntimeTrace(repository, 'run-error', 'leaf')
  expect(trace.result).toMatchObject({ state: 'needs_human' })
  expect(trace.events.map(event => event.phase)).toEqual([
   'goal_started', 'workspace_allocated', 'verifier_started', 'structured_error', 'goal_settled',
  ])
  expect(trace.events.find(event => event.phase === 'structured_error')?.reason).toBe('verification_error')
  expect(parseGoalRuntimeTrace(JSON.parse(JSON.stringify(trace)) as unknown)).toEqual(trace)
 })

 it('keeps verifier truth authoritative when diagnostic event storage fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dog-runtime-warning-'))
  temporaryRoots.push(root)
  await writeFile(join(root, 'artifact.txt'), 'verified artifact')
  const repository = new class extends DogRepository {
   override async appendRuntimeEvent(): Promise<void> {
    throw new Error('diagnostic store unavailable')
   }
  }(join(root, '.dog-store'))
  const dog = new DogEngine({
   config: {
    artifactRoots: [{ id: 'workspace', path: root }],
    artifactBindings: [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }],
    storageDirectory: 'dog',
    maxGraphNodes: 32,
    maxExpressionNodes: 64,
    maxExpressionDepth: 16,
    maxSnapshotBytes: 1024 * 1024,
    allowPartialRoot: false,
    maxConcurrentVerifications: 1,
    revalidateThreshold: 1,
    gmDigestAlgo: 'sha256',
   },
   repository,
   nextRunId: () => 'run-warning',
  })
  await dog.create(graph('Diagnostic failure'))

  const run = await dog.run('debug-demo')
  expect(run.rootState).toBe('success')
  expect(run.goals.leaf?.verification?.passed).toBe(true)
  expect(run.runtimeWarning).toContain('diagnostic store unavailable')
  const trace = await buildGoalRuntimeTrace(repository, 'run-warning', 'leaf')
  expect(trace.events).toEqual([])
  expect(trace.runtimeWarning).toBe(run.runtimeWarning)
 })
})

function graph(leafTitle: string): DogGraphInput {
 return injectAgenticAudit({
  schemaVersion: '0.2',
  id: 'debug-demo',
  root: 'root',
  nodes: {
   root: {
    kind: 'composite',
    title: 'Debugger contract',
    constraint: 'hard',
    completion: { op: 'ref', id: 'leaf' },
   },
   leaf: {
    kind: 'leaf',
    title: leafTitle,
    constraint: 'hard',
    verifier: { id: 'file.exists', version: '1' },
    verifierParams: { artifactId: 'artifact' },
   },
  },
  contains: [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal' }],
  dependsOn: [],
 })
}
