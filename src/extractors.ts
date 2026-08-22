/** Host-registered grounding-material extractors: the only source of gmDigest. */

import { createHash } from 'node:crypto'
import type { ArtifactSnapshot, JsonValue } from './model.ts'
import type { SnapshotReader } from './verifiers.ts'

export interface GroundingExtractorSpec {
  readonly id: string
  readonly version: string
  readonly schema: string
  /** Deterministic extraction from the bound snapshot to normalized JSON. */
  readonly extract: (snapshot: ArtifactSnapshot, reader: SnapshotReader) => Promise<Record<string, JsonValue>>
}

export class GroundingExtractorRegistry {
  private readonly entries = new Map<string, GroundingExtractorSpec>()

  register(spec: GroundingExtractorSpec): void {
    const key = `${spec.id}@${spec.version}`
    if (this.entries.has(key)) throw new Error(`duplicate grounding extractor ${key}`)
    this.entries.set(key, spec)
  }

  get(id: string, version: string): GroundingExtractorSpec {
    const spec = this.entries.get(`${id}@${version}`)
    if (spec === undefined) throw new Error(`unknown grounding extractor ${id}@${version}`)
    return spec
  }
}

/** Create the v0.2 bundled extractors. */
export function createBuiltinExtractorRegistry(): GroundingExtractorRegistry {
  const registry = new GroundingExtractorRegistry()
  registry.register({
    id: 'file.content',
    version: '1',
    schema: 'file.content/v1',
    extract: async (snapshot, reader) => {
      if (!snapshot.exists) return { exists: false, sha256: snapshot.sha256, byteLength: 0 }
      const bytes = await reader.read(snapshot)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== snapshot.sha256 || bytes.byteLength !== snapshot.byteLength) {
        throw new Error(`grounding extractor file.content integrity mismatch for ${snapshot.snapshotId}`)
      }
      return { exists: true, sha256: digest, byteLength: bytes.byteLength }
    },
  })
  return registry
}

export function computeGmDigest(grounding: Record<string, JsonValue>, algo: string): string | undefined {
  if (algo.length === 0) throw new Error('gmDigestAlgo must not be empty')
  if (algo === 'sha256') {
    return `sha256:${createHash('sha256').update(JSON.stringify(grounding)).digest('hex')}`
  }
  throw new Error(`unsupported gmDigestAlgo ${algo}`)
}
