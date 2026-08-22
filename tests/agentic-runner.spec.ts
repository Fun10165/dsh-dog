import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DogEngine } from '../src/core.ts'
import type { DogConfig, DogGraphInput } from '../src/model.ts'
import { DogRepository } from '../src/storage.ts'
import { createBuiltinVerifierRegistry, type AgenticVerifierRunner, type Settlement } from '../src/verifiers.ts'
import { injectAgenticAudit } from './helpers.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; dog: DogEngine }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dog-agentic-'))
  temporaryRoots.push(root)
  await writeFile(join(root, 'artifact.txt'), 'verified artifact')
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
  const repository = new DogRepository(join(root, '.dog-store'))
  const dog = new DogEngine({
    config,
    repository,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
    nextRunId: () => `run-${Math.random().toString(36).slice(2)}`,
  })
  return { root, dog }
}

function agenticGraph(): DogGraphInput {
  return injectAgenticAudit({
    schemaVersion: '0.2',
    id: 'agentic-demo',
    root: 'root',
    nodes: {
      root: { kind: 'composite', title: 'agentic gate', constraint: 'hard', completion: { op: 'ref', id: 'audit' } },
      audit: {
        kind: 'leaf',
        title: 'agentic check',
        constraint: 'hard',
        verifier: { id: 'vision.overlap', version: '1' },
        verifierParams: { artifactId: 'artifact', target: 'smoke region', requirement: 'No text overlap in the smoke region' },
      },
    },
    contains: [{ parent: 'root', child: 'audit', required: true, failure: 'fatal' }],
    dependsOn: [],
  })
}

describe('agentic Verifier Agent execution', () => {
  it('routes the contract, plan, workspace, parent, and signal into the runner', async () => {
    const { dog } = await fixture()
    const parent = { id: 'parent-session' }
    const seen = new Map<string, unknown>()
    const registry = createBuiltinVerifierRegistry({
      agenticRunner: {
        async run(input): Promise<Settlement> {
          seen.set('contractId', input.contract.id)
          seen.set('goalId', input.plan.goalId)
          seen.set('artifactId', input.plan.artifactId)
          seen.set('parent', input.parent)
          seen.set('signalIsAbortSignal', input.signal instanceof AbortSignal)
          seen.set('runIdIsString', typeof input.runId === 'string' && input.runId.length > 0)
          seen.set('workspaceCreated', await import('node:fs/promises').then(fs => fs.stat(input.workspace.path).then(() => true, () => false)))
          return { state: 'pass', observation: { checked: true, region: String((input.plan.params.target ?? '')) } }
        },
      } satisfies AgenticVerifierRunner,
    })
    dog.setVerifierRegistry(registry)
    const compiled = await dog.create(agenticGraph())
    const run = await dog.run(compiled.input.id, { invocation: { callId: 'call-1' }, agent: parent })
    expect(run.rootState).toBe('success')
    expect(run.goals.audit?.state).toBe('success')
    expect(seen.get('contractId')).toBe('vision.overlap')
    expect(seen.get('goalId')).toBe('audit')
    expect(seen.get('artifactId')).toBe('artifact')
    expect(seen.get('parent')).toBe(parent)
    expect(seen.get('signalIsAbortSignal')).toBe(true)
    expect(seen.get('runIdIsString')).toBe(true)
    expect(seen.get('workspaceCreated')).toBe(true)
  })

  it('propagates an agentic failure as a fatal child result', async () => {
    const { dog } = await fixture()
    const registry = createBuiltinVerifierRegistry({
      agenticRunner: {
        async run(): Promise<Settlement> {
          return { state: 'fail', observation: { overlapRatio: 0.31, region: 'smoke region' } }
        },
      },
    })
    dog.setVerifierRegistry(registry)
    const compiled = await dog.create(agenticGraph())
    const run = await dog.run(compiled.input.id)
    expect(run.goals.audit?.state).toBe('failure')
    expect(run.goals.audit?.verification?.passed).toBe(false)
    expect(run.rootState).toBe('failure')
  })

  it('settles inconclusive as needs_human when no runner is installed', async () => {
    const { dog } = await fixture()
    const compiled = await dog.create(agenticGraph())
    const run = await dog.run(compiled.input.id)
    expect(run.goals.audit?.state).toBe('needs_human')
    expect(run.rootState).toBe('needs_replan')
  })

  it('marks prior running runs of the same graph as cancelled on a new run', async () => {
    const { dog } = await fixture()
    const repository = (dog as unknown as { repository: DogRepository }).repository
    const zombieAt = '2026-08-23T01:00:00.000Z'
    await repository.saveRun({
      runId: 'run-zombie',
      graphId: 'agentic-demo',
      graphDigest: '0000000000000000000000000000000000000000000000000000000000000000',
      state: 'running',
      gmDigests: {},
      goals: {},
      createdAt: zombieAt,
      updatedAt: zombieAt,
    })
    const compiled = await dog.create(agenticGraph())
    // The zombie is superseded by the new run even though its runId differs.
    const run = await dog.run(compiled.input.id)
    expect(run.runId).not.toBe('run-zombie')
    const zombie = await repository.loadRun('run-zombie')
    expect(zombie.state).toBe('cancelled')
    expect(zombie.rootState).toBe('cancelled')
  })
})
