/** Host-bound artifact snapshots and durable DoG records. */

import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AcceptancePlan,
  ArtifactBinding,
  ArtifactRootBinding,
  ArtifactSnapshot,
  CompiledGraph,
  DogGraphInput,
  DogRun,
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
    if (index.graphId !== graphId || !/^[a-f0-9]{64}$/u.test(index.graphDigest)) {
      throw new Error(`invalid graph index for ${graphId}`)
    }
    const record = await readJson<{
      schemaVersion: string
      graphDigest: string
      input: DogGraphInput
      acceptancePlans: Record<string, AcceptancePlan>
    }>(join(this.rootPath, 'graphs', `${index.graphDigest}.json`))
    const actualDigest = sha256Json({ input: record.input, acceptancePlans: record.acceptancePlans })
    if (record.schemaVersion !== '0.1' || record.graphDigest !== index.graphDigest || actualDigest !== index.graphDigest) {
      throw new Error(`invalid persisted graph record for ${graphId}`)
    }
    return {
      input: record.input,
      graphDigest: record.graphDigest,
      acceptancePlans: record.acceptancePlans,
    }
  }

  /** Persist a run snapshot. */
  async saveRun(run: DogRun): Promise<void> {
    await this.initialize()
    await atomicWriteJson(join(this.rootPath, 'runs', `${safeKey(run.runId)}.json`), run)
  }

  /** Load one run snapshot. */
  async loadRun(runId: string): Promise<DogRun> {
    return readJson<DogRun>(join(this.rootPath, 'runs', `${safeKey(runId)}.json`))
  }

  /** Append one verification record without rewriting prior records. */
  async appendVerification(record: VerificationRecord): Promise<void> {
    await this.initialize()
    const path = join(this.rootPath, 'verifications', `${safeKey(record.runId)}.jsonl`)
    await appendFile(path, `${canonicalJson(record)}\n`, { encoding: 'utf8', flag: 'a' })
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
