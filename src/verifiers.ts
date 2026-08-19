/** Trusted, built-in atomic verifier registry for DoG v0.1. */

import type { AcceptancePlan, ArtifactSnapshot, JsonValue } from './model.ts'

export interface SnapshotReader {
  /** Read exactly the immutable bytes named by a snapshot ID. */
  read(snapshot: ArtifactSnapshot): Promise<Uint8Array>
}

export interface AtomicResult {
  readonly passed: boolean
  readonly observation: Record<string, JsonValue>
}

export interface AtomicVerifierSpec {
  readonly id: string
  readonly version: string
  readonly evidenceSchemaId: string
  /** Validate declarative parameters and return a normalized JSON object. */
  readonly validateParams: (params: Record<string, JsonValue>) => Record<string, JsonValue>
  /** Verify only the system-bound snapshot and normalized parameters. */
  readonly verify: (
    snapshot: ArtifactSnapshot,
    params: Record<string, JsonValue>,
    reader: SnapshotReader,
  ) => Promise<AtomicResult>
}

/** Error raised when a graph names a verifier that is not trusted by the host. */
export class UnknownVerifierError extends Error {
  readonly verifierId: string
  readonly verifierVersion: string

  constructor(verifierId: string, verifierVersion: string) {
    super(`unknown trusted verifier ${verifierId}@${verifierVersion}`)
    this.name = 'UnknownVerifierError'
    this.verifierId = verifierId
    this.verifierVersion = verifierVersion
  }
}

/** Registry whose entries are installed by code, never by graph data. */
export class AtomicVerifierRegistry {
  private readonly entries = new Map<string, AtomicVerifierSpec>()

  /** Register one trusted implementation during host/plugin construction. */
  register(spec: AtomicVerifierSpec): void {
    const key = verifierKey(spec.id, spec.version)
    if (this.entries.has(key)) throw new Error(`duplicate trusted verifier ${key}`)
    this.entries.set(key, spec)
  }

  /** Resolve a trusted implementation by its stable public identifier. */
  get(id: string, version: string): AtomicVerifierSpec {
    const spec = this.entries.get(verifierKey(id, version))
    if (spec === undefined) throw new UnknownVerifierError(id, version)
    return spec
  }

  /** Return the IDs installed by the host, for bounded diagnostics. */
  list(): readonly string[] {
    return [...this.entries.keys()].sort()
  }
}

/** Create the v0.1 verifier registry. */
export function createBuiltinVerifierRegistry(): AtomicVerifierRegistry {
  const registry = new AtomicVerifierRegistry()
  registry.register({
    id: 'file.exists',
    version: '1',
    evidenceSchemaId: 'file.exists/v1',
    validateParams: paramsWithOnlyArtifactId,
    verify: async (snapshot, _params, reader) => {
      if (!snapshot.exists) return { passed: false, observation: { exists: false, readable: false, byteLength: 0 } }
      const bytes = await reader.read(snapshot)
      return {
        passed: bytes.byteLength > 0 && bytes.byteLength === snapshot.byteLength,
        observation: { exists: true, readable: true, byteLength: bytes.byteLength },
      }
    },
  })
  registry.register({
    id: 'file.non_empty',
    version: '1',
    evidenceSchemaId: 'file.non_empty/v1',
    validateParams: paramsWithOnlyArtifactId,
    verify: async (snapshot, _params, reader) => {
      if (!snapshot.exists) return { passed: false, observation: { exists: false, byteLength: 0 } }
      const bytes = await reader.read(snapshot)
      return {
        passed: bytes.byteLength > 0,
        observation: { exists: true, byteLength: bytes.byteLength },
      }
    },
  })
  registry.register({
    id: 'file.sha256',
    version: '1',
    evidenceSchemaId: 'file.sha256/v1',
    validateParams: paramsWithExpectedHash,
    verify: async (snapshot, params, reader) => {
      if (!snapshot.exists) return { passed: false, observation: { exists: false, actualSha256: '' } }
      await reader.read(snapshot)
      return {
        passed: snapshot.sha256 === params.expectedSha256,
        observation: { exists: true, actualSha256: snapshot.sha256 },
      }
    },
  })
  registry.register({
    id: 'text.includes',
    version: '1',
    evidenceSchemaId: 'text.includes/v1',
    validateParams: paramsWithExpectedText,
    verify: async (snapshot, params, reader) => {
      if (!snapshot.exists) return { passed: false, observation: { exists: false, matched: false } }
      const bytes = await reader.read(snapshot)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return { passed: false, observation: { exists: true, matched: false, validUtf8: false } }
      }
      const expectedText = params.expectedText
      if (typeof expectedText !== 'string') throw new Error('expectedText was not normalized')
      const matched = text.includes(expectedText)
      return { passed: matched, observation: { exists: true, matched } }
    },
  })
  return registry
}

/** Execute one trusted plan and enforce its evidence contract. */
export async function verifyAcceptancePlan(
  plan: AcceptancePlan,
  registry: AtomicVerifierRegistry,
  reader: SnapshotReader,
): Promise<AtomicResult> {
  const spec = registry.get(plan.verifierId, plan.verifierVersion)
  const params = spec.validateParams(plan.params)
  if (
    plan.scope.kind !== 'file'
    || plan.scope.artifactId !== plan.artifactId
    || plan.snapshot.artifactId !== plan.artifactId
    || params.artifactId !== plan.artifactId
  ) {
    throw new Error(`acceptance plan artifact scope mismatch for ${plan.goalId}`)
  }
  if (spec.evidenceSchemaId !== plan.evidenceSchemaId) {
    throw new Error(`acceptance plan evidence schema mismatch for ${plan.goalId}`)
  }
  const result = await spec.verify(plan.snapshot, params, reader)
  if (!isNonEmptyJsonObject(result.observation)) {
    throw new Error(`trusted verifier ${plan.verifierId}@${plan.verifierVersion} returned invalid evidence`)
  }
  return result
}

function paramsWithOnlyArtifactId(params: Record<string, JsonValue>): Record<string, JsonValue> {
  requireExactKeys(params, ['artifactId'])
  const artifactId = requireString(params, 'artifactId')
  return { artifactId }
}

function paramsWithExpectedHash(params: Record<string, JsonValue>): Record<string, JsonValue> {
  requireExactKeys(params, ['artifactId', 'expectedSha256'])
  const artifactId = requireString(params, 'artifactId')
  const expectedSha256 = requireString(params, 'expectedSha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('expectedSha256 must be a 64-character hexadecimal digest')
  return { artifactId, expectedSha256 }
}

function paramsWithExpectedText(params: Record<string, JsonValue>): Record<string, JsonValue> {
  requireExactKeys(params, ['artifactId', 'expectedText'])
  const artifactId = requireString(params, 'artifactId')
  const expectedText = requireString(params, 'expectedText')
  if (expectedText.length === 0) throw new Error('expectedText must not be empty')
  return { artifactId, expectedText }
}

function requireExactKeys(value: Record<string, JsonValue>, expected: readonly string[]): void {
  const allowed = new Set(expected)
  const actual = Object.keys(value)
  if (actual.length !== expected.length || actual.some(key => !allowed.has(key))) {
    throw new Error(`unexpected verifier parameters; expected exactly ${expected.join(', ')}`)
  }
}

function requireString(value: Record<string, JsonValue>, key: string): string {
  const candidate = value[key]
  if (typeof candidate !== 'string') throw new Error(`verifier parameter ${key} must be a string`)
  return candidate
}

function isNonEmptyJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([, item]) => isJsonValue(item))
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

function verifierKey(id: string, version: string): string {
  return `${id}@${version}`
}
