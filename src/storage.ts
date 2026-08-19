/** Host-bound artifact snapshots and durable DoG records. */

import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AcceptancePlan,
  ArtifactBinding,
  ArtifactRootBinding,
  ArtifactSnapshot,
  CompiledGraph,
  DogGraphInput,
  DogRun,
  GoalRuntimeEvent,
  VerificationRecord,
} from './model.ts'
import { canonicalJson, sha256Json } from './json.ts'
import type { SnapshotReader } from './verifiers.ts'

export interface HostArtifactConfig {
  readonly roots: readonly ArtifactRootBinding[]
  readonly bindings: readonly ArtifactBinding[]
}

export interface ResolvedArtifact {
  readonly artifactId: string
  readonly rootBindingId: string
  readonly absolutePath: string
}

export interface CapturedArtifact {
  readonly snapshot: ArtifactSnapshot
  readonly rootBindingId: string
  readonly relativePath: string
}

/** File-backed snapshot and graph/run repository. */
export class DogRepository implements SnapshotReader {
  readonly rootPath: string
  private readonly runMutationTails = new Map<string, Promise<void>>()


  constructor(rootPath: string) {
    this.rootPath = rootPath
  }

  /** Create the repository directory layout. */
  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.rootPath, 'graphs'), { recursive: true }),
      mkdir(join(this.rootPath, 'graph-index'), { recursive: true }),
      mkdir(join(this.rootPath, 'runs'), { recursive: true }),
      mkdir(join(this.rootPath, 'verifications'), { recursive: true }),
      mkdir(join(this.rootPath, 'runtime-events'), { recursive: true }),
      mkdir(join(this.rootPath, 'artifacts'), { recursive: true }),
    ])
  }

  /** Persist one immutable compiled graph revision and its ID index. */
  async saveGraph(compiled: CompiledGraph): Promise<void> {
    await this.initialize()
    const record = {
      schemaVersion: '0.1',
      graphDigest: compiled.graphDigest,
      input: compiled.input,
      acceptancePlans: compiled.acceptancePlans,
    }
    await atomicWriteJson(join(this.rootPath, 'graphs', `${compiled.graphDigest}.json`), record)
    await atomicWriteJson(join(this.rootPath, 'graph-index', `${safeKey(compiled.input.id)}.json`), {
      graphId: compiled.input.id,
      graphDigest: compiled.graphDigest,
    })
  }

  /** Load the latest graph revision for a graph ID. */
  async loadGraph(graphId: string): Promise<CompiledGraph> {
    const index = await readJson<{ graphId: string; graphDigest: string }>(
      join(this.rootPath, 'graph-index', `${safeKey(graphId)}.json`),
    )
    if (index.graphId !== graphId || !isDigest(index.graphDigest)) {
      throw new Error(`invalid graph index for ${graphId}`)
    }
    return readCompiledGraph(this.rootPath, index.graphDigest)
  }

  /** Enumerate every immutable graph revision available to the debugger. */
  async listGraphs(): Promise<readonly CompiledGraph[]> {
    await this.initialize()
    const entries = await readdir(join(this.rootPath, 'graphs'), { withFileTypes: true })
    const graphs = await Promise.all(entries
      .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map(entry => readCompiledGraph(this.rootPath, entry.name.slice(0, -'.json'.length))))
    return graphs.sort((left, right) => {
      const byId = left.input.id.localeCompare(right.input.id)
      return byId === 0 ? left.graphDigest.localeCompare(right.graphDigest) : byId
    })
  }

  /** Persist a run snapshot. */
  async saveRun(run: DogRun): Promise<void> {
    await this.initialize()
    await atomicWriteJson(join(this.rootPath, 'runs', `${safeKey(run.runId)}.json`), run)
  }

  /** Atomically read, transform, and replace one run within this repository process. */
  async updateRun(runId: string, update: (run: DogRun) => DogRun): Promise<DogRun> {
    return this.withRunMutation(runId, async () => {
      const current = await this.loadRun(runId)
      const next = update(current)
      if (next.runId !== current.runId || next.graphId !== current.graphId || next.graphDigest !== current.graphDigest) {
        throw new Error(`run update cannot change identity for ${runId}`)
      }
      await this.saveRun(next)
      return next
    })
  }

  private async withRunMutation<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.runMutationTails.get(runId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate, () => gate)
    this.runMutationTails.set(runId, tail)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.runMutationTails.get(runId) === tail) this.runMutationTails.delete(runId)
    }
  }

  /** Load one run snapshot. */
  async loadRun(runId: string): Promise<DogRun> {
    return readJson<DogRun>(join(this.rootPath, 'runs', `${safeKey(runId)}.json`))
  }

  /** Enumerate persisted run snapshots, newest update first. */
  async listRuns(): Promise<readonly DogRun[]> {
    await this.initialize()
    const entries = await readdir(join(this.rootPath, 'runs'), { withFileTypes: true })
    const runs = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const run = await readJson<DogRun>(join(this.rootPath, 'runs', entry.name))
        if (
          typeof run.runId !== 'string'
          || run.runId.length === 0
          || typeof run.graphId !== 'string'
          || !isDigest(run.graphDigest)
          || entry.name !== `${safeKey(run.runId)}.json`
        ) {
          throw new Error(`invalid persisted run record ${entry.name}`)
        }
        return run
      }))
    return runs.sort((left, right) => {
      const byTime = right.updatedAt.localeCompare(left.updatedAt)
      return byTime === 0 ? left.runId.localeCompare(right.runId) : byTime
    })
  }

  /** Append one verification record without rewriting prior records. */
  async appendVerification(record: VerificationRecord): Promise<void> {
    await this.initialize()
    const path = join(this.rootPath, 'verifications', `${safeKey(record.runId)}.jsonl`)
    await appendFile(path, `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  /** Append diagnostic runtime context to the selected goal shard, separately from trusted verifier evidence. */
  async appendRuntimeEvent(event: GoalRuntimeEvent): Promise<void> {
    await this.initialize()
    const path = join(this.rootPath, 'runtime-events', `${safeKey(event.runId)}-${safeKey(event.goalId)}.jsonl`)
    await appendFile(path, `${canonicalJson(event)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  /** Load one goal's validated event shard. A torn final line is ignored. */
  async loadGoalRuntimeEvents(runId: string, goalId: string): Promise<readonly GoalRuntimeEvent[]> {
    const path = join(this.rootPath, 'runtime-events', `${safeKey(runId)}-${safeKey(goalId)}.jsonl`)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const complete = source.endsWith('\n') ? source : source.slice(0, source.lastIndexOf('\n') + 1)
    return complete.split('\n')
      .filter(line => line.length > 0)
      .map((line, index) => parseRuntimeEvent(JSON.parse(line) as unknown, runId, goalId, index))
  }

  /** Store immutable bytes and a metadata manifest under their content identity. */
  async putSnapshot(snapshot: ArtifactSnapshot, bytes: Uint8Array | undefined): Promise<void> {
    await this.initialize()
    const key = snapshotKey(snapshot.snapshotId)
    if (bytes !== undefined) {
      await atomicWrite(join(this.rootPath, 'artifacts', `${key}.bin`), bytes)
    }
    await atomicWriteJson(join(this.rootPath, 'artifacts', `${key}.json`), snapshot)
  }

  /** Read and re-hash an immutable snapshot named by a verification plan. */
  async read(snapshot: ArtifactSnapshot): Promise<Uint8Array> {
    if (!snapshot.exists) throw new Error(`snapshot ${snapshot.snapshotId} represents a missing artifact`)
    const bytes = await readFile(join(this.rootPath, 'artifacts', `${snapshotKey(snapshot.snapshotId)}.bin`))
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== snapshot.sha256 || bytes.byteLength !== snapshot.byteLength) {
      throw new Error(`snapshot integrity mismatch for ${snapshot.snapshotId}`)
    }
    return bytes
  }
}

/** Resolve a host-owned artifact binding without accepting a model path. */
export async function resolveHostArtifact(
  host: HostArtifactConfig,
  artifactId: string,
): Promise<ResolvedArtifact> {
  const binding = host.bindings.find(candidate => candidate.id === artifactId)
  if (binding === undefined) throw new Error(`unknown host artifact binding ${artifactId}`)
  const root = host.roots.find(candidate => candidate.id === binding.rootId)
  if (root === undefined) throw new Error(`artifact binding ${artifactId} references unknown root ${binding.rootId}`)
  if (!isAbsolute(root.path)) throw new Error(`artifact root ${root.id} must be absolute`)
  if (isAbsolute(binding.relativePath)) throw new Error(`artifact binding ${artifactId} path must be relative`)
  const rootPath = resolve(root.path)
  const lexicalCandidate = resolve(rootPath, binding.relativePath)
  const lexicalRelative = relative(rootPath, lexicalCandidate)
  if (!isWithinRoot(lexicalRelative)) throw new Error(`artifact binding ${artifactId} escapes its configured root`)
  const rootStat = await stat(rootPath)
  if (!rootStat.isDirectory()) throw new Error(`artifact root ${root.id} is not a directory`)
  const canonicalRoot = await realpath(rootPath)
  const absolutePath = await resolveBoundPath(canonicalRoot, lexicalRelative, artifactId)
  return { artifactId, rootBindingId: root.id, absolutePath }
}

/** Capture bytes from a host binding into a content-addressed immutable snapshot. */
export async function captureArtifactSnapshot(
  host: HostArtifactConfig,
  artifactId: string,
  maxBytes: number,
  repository: DogRepository,
): Promise<CapturedArtifact> {
  const resolved = await resolveHostArtifact(host, artifactId)
  const binding = host.bindings.find(candidate => candidate.id === artifactId)
  if (binding === undefined) throw new Error(`unknown host artifact binding ${artifactId}`)
  try {
    const metadata = await stat(resolved.absolutePath)
    if (!metadata.isFile()) throw new Error(`artifact ${artifactId} is not a regular file`)
    if (metadata.size > maxBytes) throw new Error(`artifact ${artifactId} exceeds ${maxBytes} bytes`)
    const bytes = await readFile(resolved.absolutePath)
    if (bytes.byteLength > maxBytes) throw new Error(`artifact ${artifactId} exceeds ${maxBytes} bytes`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const snapshot: ArtifactSnapshot = {
      artifactId,
      snapshotId: `sha256:${sha256}`,
      exists: true,
      byteLength: bytes.byteLength,
      sha256,
    }
    await repository.putSnapshot(snapshot, bytes)
    return { snapshot, rootBindingId: resolved.rootBindingId, relativePath: binding.relativePath }
  } catch (error) {
    if (!isMissing(error)) throw error
    const missingDigest = sha256Json({ artifactId, rootBindingId: resolved.rootBindingId, relativePath: binding.relativePath })
    const snapshot: ArtifactSnapshot = {
      artifactId,
      snapshotId: `missing:${missingDigest}`,
      exists: false,
      byteLength: 0,
      sha256: '',
    }
    await repository.putSnapshot(snapshot, undefined)
    return { snapshot, rootBindingId: resolved.rootBindingId, relativePath: binding.relativePath }
  }
}

function snapshotKey(snapshotId: string): string {
  return snapshotId.replaceAll(/[^a-zA-Z0-9_-]/gu, '_')
}

function safeKey(value: string): string {
  return sha256Json(value)
}

function isWithinRoot(relativePath: string): boolean {
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

async function resolveBoundPath(rootPath: string, relativePath: string, artifactId: string): Promise<string> {
  const segments = relativePath.length === 0 ? [] : relativePath.split(sep)
  let current = rootPath
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (segment === undefined) continue
    const candidate = join(current, segment)
    let metadata
    try {
      metadata = await lstat(candidate)
    } catch (error) {
      if (!isMissing(error)) throw error
      return join(current, ...segments.slice(index))
    }
    if (metadata.isSymbolicLink()) {
      try {
        current = await realpath(candidate)
      } catch (error) {
        if (isMissing(error)) throw new Error(`artifact binding ${artifactId} contains a dangling symbolic link`)
        throw error
      }
    } else {
      current = candidate
    }
    if (!isWithinRoot(relative(rootPath, current))) {
      throw new Error(`artifact binding ${artifactId} escapes its configured root through a symbolic link`)
    }
  }
  return current
}

async function readCompiledGraph(rootPath: string, graphDigest: string): Promise<CompiledGraph> {
  if (!isDigest(graphDigest)) throw new Error(`invalid graph digest ${graphDigest}`)
  const record = await readJson<{
    schemaVersion: string
    graphDigest: string
    input: DogGraphInput
    acceptancePlans: Record<string, AcceptancePlan>
  }>(join(rootPath, 'graphs', `${graphDigest}.json`))
  const actualDigest = sha256Json({ input: record.input, acceptancePlans: record.acceptancePlans })
  if (record.schemaVersion !== '0.1' || record.graphDigest !== graphDigest || actualDigest !== graphDigest) {
    throw new Error(`invalid persisted graph record ${graphDigest}`)
  }
  return {
    input: record.input,
    graphDigest: record.graphDigest,
    acceptancePlans: record.acceptancePlans,
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

const RUNTIME_EVENT_KINDS = new Set([
  'goal_started',
  'dependency_blocked',
  'verifier_started',
  'verifier_passed',
  'verifier_failed',
  'composite_evaluated',
  'goal_error',
  'goal_settled',
])
const GOAL_STATES = new Set([
  'pending', 'running', 'success', 'failure', 'blocked', 'needs_human',
  'cancelled', 'invalidated', 'partial',
])
const RUNTIME_STAGES = new Set(['scheduling', 'verification', 'composition'])
const RUNTIME_ERROR_KINDS = new Set(['acceptance_plan_missing', 'completion_expression_missing', 'verification_error'])

function parseRuntimeEvent(value: unknown, expectedRunId: string, expectedGoalId: string, index: number): GoalRuntimeEvent {
  const path = `runtime event ${index}`
  const record = requireRecord(value, path)
  const runId = requireString(record.runId, `${path}.runId`)
  const graphDigest = requireString(record.graphDigest, `${path}.graphDigest`)
  const goalId = requireString(record.goalId, `${path}.goalId`)
  const kind = requireString(record.kind, `${path}.kind`)
  const sequence = requireNonNegativeInteger(record.sequence, `${path}.sequence`)
  const attempt = requireNonNegativeInteger(record.attempt, `${path}.attempt`)
  if (runId !== expectedRunId) throw new Error(`${path}.runId does not match its event log`)
  if (goalId !== expectedGoalId) throw new Error(`${path}.goalId does not match its event log`)
  if (!isDigest(graphDigest)) throw new Error(`${path}.graphDigest is invalid`)
  if (!RUNTIME_EVENT_KINDS.has(kind)) throw new Error(`${path}.kind is invalid`)
  if (attempt < 1) throw new Error(`${path}.attempt must be positive`)

  const state = record.state === undefined ? undefined : requireString(record.state, `${path}.state`)
  if (state !== undefined && !GOAL_STATES.has(state)) throw new Error(`${path}.state is invalid`)
  const reason = record.reason === undefined ? undefined : requireBoundedString(record.reason, `${path}.reason`)
  const durationMs = record.durationMs === undefined
    ? undefined
    : requireNonNegativeInteger(record.durationMs, `${path}.durationMs`)
  const verifierRecord = record.verifier === undefined ? undefined : requireRecord(record.verifier, `${path}.verifier`)
  const verifier = verifierRecord === undefined ? undefined : {
    id: requireString(verifierRecord.id, `${path}.verifier.id`),
    version: requireString(verifierRecord.version, `${path}.verifier.version`),
    artifactId: requireString(verifierRecord.artifactId, `${path}.verifier.artifactId`),
  }
  const errorRecord = record.error === undefined ? undefined : requireRecord(record.error, `${path}.error`)
  const error = errorRecord === undefined ? undefined : {
    kind: requireString(errorRecord.kind, `${path}.error.kind`),
    stage: requireString(errorRecord.stage, `${path}.error.stage`),
    message: requireBoundedString(errorRecord.message, `${path}.error.message`),
  }
  if (error !== undefined && (!RUNTIME_ERROR_KINDS.has(error.kind) || !RUNTIME_STAGES.has(error.stage))) {
    throw new Error(`${path}.error is invalid`)
  }
  return {
    schemaVersion: record.schemaVersion === '0.1' ? '0.1' : fail(`${path}.schemaVersion must be 0.1`),
    runId,
    graphDigest,
    goalId,
    sequence,
    attempt,
    kind: kind as GoalRuntimeEvent['kind'],
    at: requireString(record.at, `${path}.at`),
    ...(state === undefined ? {} : { state: state as NonNullable<GoalRuntimeEvent['state']> }),
    ...(reason === undefined ? {} : { reason }),
    ...(verifier === undefined ? {} : { verifier }),
    ...(error === undefined ? {} : { error: error as NonNullable<GoalRuntimeEvent['error']> }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
  return value
}

function requireBoundedString(value: unknown, path: string): string {
  const text = requireString(value, path)
  if (text.length > 512) throw new Error(`${path} exceeds 512 characters`)
  return text
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`)
  }
  return value
}

function fail(message: string): never {
  throw new Error(message)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value)}\n`)
}

async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, value)
  await rename(temporary, path)
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
