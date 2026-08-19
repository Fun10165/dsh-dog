import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DogEngine } from '../src/core.ts'
import { evaluateBoolExpr, parseBoolExpr } from '../src/logic.ts'
import type { DogConfig, DogGraphInput } from '../src/model.ts'
import { DogRepository } from '../src/storage.ts'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-dog-'))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function graph(nodes: DogGraphInput['nodes'], contains: DogGraphInput['contains']): DogGraphInput {
  return {
    schemaVersion: '0.1',
    id: 'demo',
    root: 'root',
    nodes,
    contains,
    dependsOn: [],
  }
}

function config(root: string, bindings: DogConfig['artifactBindings']): DogConfig {
  return {
    artifactRoots: [{ id: 'workspace', path: root }],
    artifactBindings: bindings,
    storageDirectory: 'dog',
    maxGraphNodes: 64,
    maxExpressionNodes: 128,
    maxExpressionDepth: 16,
    maxSnapshotBytes: 1024 * 1024,
    allowPartialRoot: false,
  }
}

function engine(root: string, bindings: DogConfig['artifactBindings']): DogEngine {
  return new DogEngine({
    config: config(root, bindings),
    repository: new DogRepository(join(root, '.dog-store')),
    now: () => new Date('2026-08-19T00:00:00.000Z'),
    nextRunId: () => 'run-1',
  })
}

describe('restricted Boolean AST', () => {
  it('rejects source expressions and evaluates only child references', () => {
    const rejected = parseBoolExpr({ op: 'eval', code: 'process.exit()' }, new Set(['a']), { maxNodes: 10, maxDepth: 4 })
    expect(rejected.errors).toContain('$.op: unsupported operator "eval"')
    const parsed = parseBoolExpr({ op: 'atLeast', count: 1, items: [{ op: 'ref', id: 'a' }, { op: 'ref', id: 'b' }] }, new Set(['a', 'b']), { maxNodes: 10, maxDepth: 4 })
    expect(parsed.errors).toEqual([])
    expect(evaluateBoolExpr(parsed.expression!, new Map([['a', false], ['b', true]]))).toBe(true)
  })
})

describe('graph validation', () => {
  it('rejects cycles across containment and dependency edges', async () => {
    const root = await temporaryRoot()
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: { kind: 'leaf', title: 'leaf', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    const cyclic = { ...candidate, dependsOn: [{ source: 'leaf', target: 'root' }] }
    const report = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }]).validate(cyclic)
    expect(report.valid).toBe(false)
    expect(report.errors.join('\n')).toContain('cycle')
  })

  it('rejects paths and custom verifiers supplied by a graph', async () => {
    const root = await temporaryRoot()
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf',
        title: 'leaf',
        constraint: 'hard',
        verifier: { id: './evil.mjs', version: '1' },
        verifierParams: { artifactId: 'artifact', path: '/etc/passwd' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    const report = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }]).validate(candidate)
    expect(report.valid).toBe(false)
    expect(report.errors[0]).toContain('unknown trusted verifier')
  })

  it('rejects a composite goal with no containment children', async () => {
    const root = await temporaryRoot()
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'missing' } },
    }, [])
    const report = engine(root, []).validate(candidate)
    expect(report.valid).toBe(false)
    expect(report.errors).toContain('$.nodes.root: composite requires at least one child')
  })

  it('requires the root goal to be a hard constraint', async () => {
    const root = await temporaryRoot()
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'soft', completion: { op: 'ref', id: 'leaf' } },
      leaf: { kind: 'leaf', title: 'leaf', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [{ parent: 'root', child: 'leaf', required: false, failure: 'tolerable', merge: 'none' }])
    const report = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }]).validate(candidate)
    expect(report.valid).toBe(false)
    expect(report.errors).toContain('$.root: root goal must be a hard constraint')
  })

  it('rejects self-degradation and duplicate dependency edges', async () => {
    const root = await temporaryRoot()
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'any', items: [{ op: 'ref', id: 'primary' }, { op: 'ref', id: 'fallback' }] } },
      primary: { kind: 'leaf', title: 'primary', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
      fallback: { kind: 'leaf', title: 'fallback', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [
      { parent: 'root', child: 'primary', required: true, failure: 'degrade', degradeTo: 'primary', merge: 'none' },
      { parent: 'root', child: 'fallback', required: false, failure: 'tolerable', merge: 'none' },
    ])
    const report = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }]).validate({
      ...candidate,
      dependsOn: [{ source: 'primary', target: 'fallback' }, { source: 'primary', target: 'fallback' }],
    })
    expect(report.valid).toBe(false)
    expect(report.errors).toContain('$.contains: degradeTo cannot equal child primary')
    expect(report.errors).toContain('$.dependsOn: duplicate edge primary->fallback')
  })
})

describe('trusted snapshot execution', () => {
  it('binds verification to immutable bytes instead of the later live file', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'artifact.txt'), 'first version')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf', title: 'leaf', constraint: 'hard',
        verifier: { id: 'text.includes', version: '1' },
        verifierParams: { artifactId: 'artifact', expectedText: 'first' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    const compiled = await dog.create(candidate)
    await writeFile(join(root, 'artifact.txt'), 'second version')
    const run = await dog.run(compiled.input.id)
    expect(run.rootState).toBe('success')
    expect(run.goals.leaf?.verification?.snapshotId).toBe(compiled.acceptancePlans.leaf?.snapshot.snapshotId)
    expect(await readFile(join(root, 'artifact.txt'), 'utf8')).toBe('second version')
  })


  it('rejects a persisted acceptance plan whose content no longer matches its digest', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'artifact.txt'), 'verified')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf', title: 'leaf', constraint: 'hard',
        verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    const compiled = await dog.create(candidate)
    const graphFile = join(root, '.dog-store', 'graphs', `${compiled.graphDigest}.json`)
    const record = JSON.parse(await readFile(graphFile, 'utf8'))
    record.acceptancePlans.leaf.scope.artifactId = 'other'
    await writeFile(graphFile, JSON.stringify(record))
    await expect(dog.run('demo')).rejects.toThrow('invalid persisted graph record')
  })

  it('rejects an invalid digest in the persisted graph index before resolving a path', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'artifact.txt'), 'verified')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: { kind: 'leaf', title: 'leaf', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    await dog.create(candidate)
    const indexDirectory = join(root, '.dog-store', 'graph-index')
    const indexFile = (await readdir(indexDirectory))[0]
    if (indexFile === undefined) throw new Error('persisted graph index is missing')
    const index = JSON.parse(await readFile(join(indexDirectory, indexFile), 'utf8'))
    index.graphDigest = '../../outside'
    await writeFile(join(indexDirectory, indexFile), JSON.stringify(index))
    await expect(dog.run('demo')).rejects.toThrow('invalid graph index')
  })
  it('fails a missing file honestly and requires a readable snapshot for file.exists', async () => {
    const root = await temporaryRoot()
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'missing.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf', title: 'leaf', constraint: 'hard',
        verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    await dog.create(candidate)
    const run = await dog.run('demo')
    expect(run.rootState).toBe('failure')
    expect(run.goals.leaf?.verification?.observation).toEqual({ exists: false, readable: false, byteLength: 0 })
  })


  it('does not treat an empty file as a readable file.exists success', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'empty.txt'), '')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'empty.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf', title: 'leaf', constraint: 'hard',
        verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    await dog.create(candidate)
    const run = await dog.run('demo')
    expect(run.rootState).toBe('failure')
    expect(run.goals.leaf?.verification?.observation).toEqual({ exists: true, readable: true, byteLength: 0 })
  })

  it('fails closed when stored bytes disappear before any content verifier runs', async () => {
    for (const verifier of [
      { id: 'file.exists', params: { artifactId: 'artifact' } },
      { id: 'file.non_empty', params: { artifactId: 'artifact' } },
      {
        id: 'file.sha256',
        params: { artifactId: 'artifact', expectedSha256: createHash('sha256').update('verified').digest('hex') },
      },
      { id: 'text.includes', params: { artifactId: 'artifact', expectedText: 'verified' } },
    ]) {
      const root = await temporaryRoot()
      await writeFile(join(root, 'artifact.txt'), 'verified')
      const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
      const candidate = graph({
        root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
        leaf: {
          kind: 'leaf', title: 'leaf', constraint: 'hard',
          verifier: { id: verifier.id, version: '1' }, verifierParams: verifier.params,
        },
      }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
      const compiled = await dog.create(candidate)
      const snapshotId = compiled.acceptancePlans.leaf?.snapshot.snapshotId
      if (snapshotId === undefined) throw new Error('compiled leaf snapshot is missing')
      const snapshotFile = `${snapshotId.replaceAll(/[^a-zA-Z0-9_-]/gu, '_')}.bin`
      await rm(join(root, '.dog-store', 'artifacts', snapshotFile))
      const run = await dog.run('demo')
      expect(run.goals.leaf?.state).toBe('needs_human')
      expect(run.rootState).toBe('needs_replan')
    }
  })
  it('rejects an artifact binding that escapes through a symbolic link', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(root, 'escape'))
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'escape/secret.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: {
        kind: 'leaf', title: 'leaf', constraint: 'hard',
        verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' },
      },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    await expect(dog.create(candidate)).rejects.toThrow('escapes its configured root through a symbolic link')
  })
})

describe('parent-relation semantics', () => {
  it('recomputes a shared child independently for fatal and tolerable parents', async () => {
    const root = await temporaryRoot()
    const dog = engine(root, [{ id: 'missing', rootId: 'workspace', relativePath: 'missing.txt' }])
    const candidate: DogGraphInput = {
      schemaVersion: '0.1', id: 'shared', root: 'root',
      nodes: {
        root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'all', items: [{ op: 'ref', id: 'strict' }, { op: 'ref', id: 'lenient' }] } },
        strict: { kind: 'composite', title: 'strict', constraint: 'hard', completion: { op: 'ref', id: 'sharedLeaf' } },
        lenient: { kind: 'composite', title: 'lenient', constraint: 'soft', completion: { op: 'ref', id: 'sharedLeaf' } },
        sharedLeaf: { kind: 'leaf', title: 'shared', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'missing' } },
      },
      contains: [
        { parent: 'root', child: 'strict', required: true, failure: 'fatal', merge: 'none' },
        { parent: 'root', child: 'lenient', required: false, failure: 'tolerable', merge: 'none' },
        { parent: 'strict', child: 'sharedLeaf', required: true, failure: 'fatal', merge: 'none' },
        { parent: 'lenient', child: 'sharedLeaf', required: true, failure: 'tolerable', merge: 'none' },
      ],
      dependsOn: [],
    }
    await dog.create(candidate)
    const run = await dog.run('shared')
    expect(run.goals.sharedLeaf?.state).toBe('failure')
    expect(run.goals.strict?.state).toBe('failure')
    expect(run.goals.lenient?.state).toBe('partial')
    expect(run.rootState).toBe('failure')
  })

  it('allows a required failed child only when its declared degradation target succeeds', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'artifacts'))
    await writeFile(join(root, 'artifacts', 'fallback.txt'), 'fallback')
    const dog = engine(root, [
      { id: 'primary', rootId: 'workspace', relativePath: 'artifacts/primary.txt' },
      { id: 'fallback', rootId: 'workspace', relativePath: 'artifacts/fallback.txt' },
    ])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'primaryGoal' } },
      primaryGoal: { kind: 'leaf', title: 'primary', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'primary' } },
      fallbackGoal: { kind: 'leaf', title: 'fallback', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'fallback' } },
    }, [
      { parent: 'root', child: 'primaryGoal', required: true, failure: 'degrade', degradeTo: 'fallbackGoal', merge: 'none' },
      { parent: 'root', child: 'fallbackGoal', required: false, failure: 'tolerable', merge: 'none' },
    ])
    await dog.create(candidate)
    const run = await dog.run('demo')
    expect(run.goals.primaryGoal?.state).toBe('failure')
    expect(run.goals.fallbackGoal?.state).toBe('success')
    expect(run.rootState).toBe('success')
  })

  it('does not let an earlier tolerable failure hide a later fatal required failure', async () => {
    const root = await temporaryRoot()
    const dog = engine(root, [{ id: 'missing', rootId: 'workspace', relativePath: 'missing.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'all', items: [{ op: 'ref', id: 'lenient' }, { op: 'ref', id: 'strict' }] } },
      lenient: { kind: 'leaf', title: 'lenient', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'missing' } },
      strict: { kind: 'leaf', title: 'strict', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'missing' } },
    }, [
      { parent: 'root', child: 'lenient', required: true, failure: 'tolerable', merge: 'none' },
      { parent: 'root', child: 'strict', required: true, failure: 'fatal', merge: 'none' },
    ])
    await dog.create(candidate)
    const run = await dog.run('demo')
    expect(run.goals.root?.state).toBe('failure')
    expect(run.rootState).toBe('failure')
  })

  it('does not use degradation to mask a primary goal requiring human review', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'primary.txt'), 'primary')
    await writeFile(join(root, 'fallback.txt'), 'fallback')
    const dog = engine(root, [
      { id: 'primary', rootId: 'workspace', relativePath: 'primary.txt' },
      { id: 'fallback', rootId: 'workspace', relativePath: 'fallback.txt' },
    ])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'primaryGoal' } },
      primaryGoal: { kind: 'leaf', title: 'primary', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'primary' } },
      fallbackGoal: { kind: 'leaf', title: 'fallback', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'fallback' } },
    }, [
      { parent: 'root', child: 'primaryGoal', required: true, failure: 'degrade', degradeTo: 'fallbackGoal', merge: 'none' },
      { parent: 'root', child: 'fallbackGoal', required: false, failure: 'tolerable', merge: 'none' },
    ])
    const compiled = await dog.create(candidate)
    const snapshotId = compiled.acceptancePlans.primaryGoal?.snapshot.snapshotId
    if (snapshotId === undefined) throw new Error('primary snapshot is missing')
    await rm(join(root, '.dog-store', 'artifacts', `${snapshotId.replaceAll(/[^a-zA-Z0-9_-]/gu, '_')}.bin`))
    const run = await dog.run('demo')
    expect(run.goals.primaryGoal?.state).toBe('needs_human')
    expect(run.goals.fallbackGoal?.state).toBe('success')
    expect(run.rootState).toBe('needs_replan')
  })

  it('propagates human review required by a degradation target', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'fallback.txt'), 'fallback')
    const dog = engine(root, [
      { id: 'primary', rootId: 'workspace', relativePath: 'missing-primary.txt' },
      { id: 'fallback', rootId: 'workspace', relativePath: 'fallback.txt' },
    ])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'primaryGoal' } },
      primaryGoal: { kind: 'leaf', title: 'primary', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'primary' } },
      fallbackGoal: { kind: 'leaf', title: 'fallback', constraint: 'soft', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'fallback' } },
    }, [
      { parent: 'root', child: 'primaryGoal', required: true, failure: 'degrade', degradeTo: 'fallbackGoal', merge: 'none' },
      { parent: 'root', child: 'fallbackGoal', required: false, failure: 'tolerable', merge: 'none' },
    ])
    const compiled = await dog.create(candidate)
    const snapshotId = compiled.acceptancePlans.fallbackGoal?.snapshot.snapshotId
    if (snapshotId === undefined) throw new Error('fallback snapshot is missing')
    await rm(join(root, '.dog-store', 'artifacts', `${snapshotId.replaceAll(/[^a-zA-Z0-9_-]/gu, '_')}.bin`))
    const run = await dog.run('demo')
    expect(run.goals.primaryGoal?.state).toBe('failure')
    expect(run.goals.fallbackGoal?.state).toBe('needs_human')
    expect(run.rootState).toBe('needs_replan')
  })
})

describe('trusted Agent bindings', () => {
  it('persists concurrent descendant bindings without losing verifier results', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'artifact.txt'), 'verified')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
    const candidate = graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: { kind: 'leaf', title: 'leaf', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }])
    await dog.create(candidate)
    const run = await dog.run('demo', { invocation: { callId: 'run-call', agentSessionId: 'owner-session' } })

    await dog.bindAgent({
      runId: run.runId,
      goalId: 'root',
      role: 'orchestrator',
      sessionId: 'owner-session',
    })
    await Promise.all([
      dog.bindAgent({ runId: run.runId, goalId: 'leaf', role: 'executor', sessionId: 'child-a', parentSessionId: 'owner-session' }),
      dog.bindAgent({ runId: run.runId, goalId: 'leaf', role: 'verifier', sessionId: 'child-b', parentSessionId: 'owner-session' }),
    ])
    await dog.bindAgent({ runId: run.runId, goalId: 'leaf', role: 'reviewer', sessionId: 'child-a', parentSessionId: 'owner-session' })

    const status = await dog.status(run.runId)
    expect(status.rootState).toBe('success')
    expect(status.goals.leaf?.verification?.passed).toBe(true)
    expect(status.goals.root?.agentSessions).toMatchObject([
      { sessionId: 'owner-session', role: 'orchestrator' },
    ])
    expect(status.goals.leaf?.agentSessions).toHaveLength(2)
    expect(status.goals.leaf?.agentSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'child-a', parentSessionId: 'owner-session', role: 'reviewer' }),
      expect.objectContaining({ sessionId: 'child-b', parentSessionId: 'owner-session', role: 'verifier' }),
    ]))

    await expect(dog.bindAgent({
      runId: run.runId,
      goalId: 'leaf',
      role: 'executor',
      sessionId: 'rogue-child',
      parentSessionId: 'unrelated-session',
    })).rejects.toThrow('is not rooted in run')
    await expect(dog.bindAgent({
      runId: run.runId,
      goalId: 'missing',
      role: 'executor',
      sessionId: 'owner-session',
    })).rejects.toThrow('has no goal missing')
  })

  it('refuses Agent bindings when the run has no trusted invoking session', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'artifact.txt'), 'verified')
    const dog = engine(root, [{ id: 'artifact', rootId: 'workspace', relativePath: 'artifact.txt' }])
    await dog.create(graph({
      root: { kind: 'composite', title: 'root', constraint: 'hard', completion: { op: 'ref', id: 'leaf' } },
      leaf: { kind: 'leaf', title: 'leaf', constraint: 'hard', verifier: { id: 'file.exists', version: '1' }, verifierParams: { artifactId: 'artifact' } },
    }, [{ parent: 'root', child: 'leaf', required: true, failure: 'fatal', merge: 'none' }]))
    const run = await dog.run('demo')
    await expect(dog.bindAgent({
      runId: run.runId,
      goalId: 'root',
      role: 'orchestrator',
      sessionId: 'untrusted-session',
    })).rejects.toThrow('has no trusted invocation Agent session')
  })
})
