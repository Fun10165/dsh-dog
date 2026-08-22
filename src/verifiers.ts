/** Trusted verifier contract registry for DoG v0.2 (deterministic + agentic). */

import type {
  AcceptancePlan,
  ArtifactSnapshot,
  JsonValue,
} from './model.ts'

export interface SnapshotReader {
  /** Read exactly the immutable bytes named by a snapshot ID. */
  read(snapshot: ArtifactSnapshot): Promise<Uint8Array>
}

/** A verification settlement. Assertions alone never pass; inconclusive is neither pass nor fail. */
export type Settlement =
  | { readonly state: 'pass'; readonly observation: Record<string, JsonValue> }
  | { readonly state: 'fail'; readonly observation: Record<string, JsonValue> }
  | { readonly state: 'inconclusive'; readonly observation: Record<string, JsonValue> }

export interface IsolatedWorkspace {
  /** Absolute path of the mutually exclusive workspace directory. */
  readonly path: string
}

/** Host-supplied execution environment for one verification turn. */
export interface VerifierExecutionEnv {
  readonly parent?: unknown
  readonly signal?: AbortSignal
  readonly runId?: string
  readonly goalId?: string
}

/** Runner that executes one agentic Verifier Contract with an isolated worker session. */
export interface AgenticVerifierRunner {
  run(input: {
    readonly contract: VerifierContract
    readonly plan: AcceptancePlan
    readonly workspace: IsolatedWorkspace
    readonly parent: unknown
    readonly signal: AbortSignal
    readonly runId: string | undefined
  }): Promise<Settlement>
}

export interface VerifierContract {
  readonly id: string
  readonly version: string
  readonly requirement: string
  readonly evidenceSchemaId: string
  readonly allowedTools: readonly string[]
  readonly grounding:
  | { readonly kind: 'programmatic'; readonly extractorId: string; readonly schema: string }
  | { readonly kind: 'non_programmatic' }
  readonly validateParams: (params: Record<string, JsonValue>) => Record<string, JsonValue>
  readonly execute: (
    workspace: IsolatedWorkspace,
    snapshot: ArtifactSnapshot,
    params: Record<string, JsonValue>,
    reader: SnapshotReader,
    env?: VerifierExecutionEnv,
  ) => Promise<Settlement>
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
export class VerifierContractRegistry {
  private readonly entries = new Map<string, VerifierContract>()

  register(spec: VerifierContract): void {
    const key = verifierKey(spec.id, spec.version)
    if (this.entries.has(key)) throw new Error(`duplicate trusted verifier ${key}`)
    this.entries.set(key, spec)
  }

  get(id: string, version: string): VerifierContract {
    const spec = this.entries.get(verifierKey(id, version))
    if (spec === undefined) throw new UnknownVerifierError(id, version)
    return spec
  }

  list(): readonly string[] {
    return [...this.entries.keys()].sort()
  }

  /** True when the settlement of this contract is fully computable (deterministic). */
  isProgrammatic(id: string, version: string): boolean {
    const spec = this.get(id, version)
    return spec.grounding.kind === 'programmatic' && spec.allowedTools.length === 0
  }
}

/** Create the v0.2 built-in registry: deterministic atomic contracts (programmatic) + agentic contracts. */
export function createBuiltinVerifierRegistry(options: {
  readonly agenticRunner?: AgenticVerifierRunner
} = {}): VerifierContractRegistry {
  const registry = new VerifierContractRegistry()
  const fileGrounding = {
    kind: 'programmatic' as const,
    extractorId: 'file.content',
    schema: 'file.content/v1',
  }
  registry.register({
    id: 'file.exists',
    version: '1',
    requirement: 'The bound artifact snapshot exists and reads back with its exact persisted byte length.',
    evidenceSchemaId: 'file.exists/v1',
    allowedTools: [],
    grounding: fileGrounding,
    validateParams: paramsWithOnlyArtifactId,
    execute: async (_workspace, snapshot, _params, reader) => {
      if (!snapshot.exists) return { state: 'fail', observation: { exists: false, readable: false, byteLength: 0 } }
      const bytes = await reader.read(snapshot)
      const readable = bytes.byteLength === snapshot.byteLength
      return readable && bytes.byteLength > 0
        ? { state: 'pass', observation: { exists: true, readable: true, byteLength: bytes.byteLength } }
        : { state: 'fail', observation: { exists: true, readable, byteLength: bytes.byteLength } }
    },
  })
  registry.register({
    id: 'file.non_empty',
    version: '1',
    requirement: 'The bound artifact snapshot is non-empty.',
    evidenceSchemaId: 'file.non_empty/v1',
    allowedTools: [],
    grounding: fileGrounding,
    validateParams: paramsWithOnlyArtifactId,
    execute: async (_workspace, snapshot, _params, reader) => {
      if (!snapshot.exists) return { state: 'fail', observation: { exists: false, byteLength: 0 } }
      const bytes = await reader.read(snapshot)
      return bytes.byteLength > 0
        ? { state: 'pass', observation: { exists: true, byteLength: bytes.byteLength } }
        : { state: 'fail', observation: { exists: true, byteLength: bytes.byteLength } }
    },
  })
  registry.register({
    id: 'file.sha256',
    version: '1',
    requirement: 'The bound artifact snapshot digest equals the fixed expected digest.',
    evidenceSchemaId: 'file.sha256/v1',
    allowedTools: [],
    grounding: fileGrounding,
    validateParams: paramsWithExpectedHash,
    execute: async (_workspace, snapshot, params, reader) => {
      if (!snapshot.exists) return { state: 'fail', observation: { exists: false, actualSha256: '' } }
      await reader.read(snapshot)
      return snapshot.sha256 === params.expectedSha256
        ? { state: 'pass', observation: { exists: true, actualSha256: snapshot.sha256 } }
        : { state: 'fail', observation: { exists: true, actualSha256: snapshot.sha256 } }
    },
  })
  registry.register({
    id: 'text.includes',
    version: '1',
    requirement: 'The bound artifact snapshot, decoded as UTF-8, contains the expected text.',
    evidenceSchemaId: 'text.includes/v1',
    allowedTools: [],
    grounding: fileGrounding,
    validateParams: paramsWithExpectedText,
    execute: async (_workspace, snapshot, params, reader) => {
      if (!snapshot.exists) return { state: 'fail', observation: { exists: false, matched: false } }
      const bytes = await reader.read(snapshot)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return { state: 'fail', observation: { exists: true, matched: false, validUtf8: false } }
      }
      const expectedText = params.expectedText
      if (typeof expectedText !== 'string') throw new Error('expectedText was not normalized')
      return text.includes(expectedText)
        ? { state: 'pass', observation: { exists: true, matched: true } }
        : { state: 'fail', observation: { exists: true, matched: false } }
    },
  })
  registry.register({
    id: 'vision.overlap',
    version: '1',
    requirement: 'Detect text blocks or shapes overlapping to illegibility within the target region.',
    evidenceSchemaId: 'vision.overlap/v1',
    allowedTools: ['render', 'ocr', 'geometry'],
    grounding: { kind: 'non_programmatic' },
    validateParams: paramsWithTargetRequirement,
    execute: async (workspace, snapshot, params, _reader, env) => {
      if (options.agenticRunner === undefined) return { state: 'inconclusive', observation: {} }
      const contract = registry.get('vision.overlap', '1')
      const plan: AcceptancePlan = {
        goalId: env?.goalId ?? 'verification',
        verifierId: contract.id,
        verifierVersion: contract.version,
        artifactId: params.artifactId as string,
        rootBindingId: '',
        relativePath: '',
        snapshot,
        scope: { kind: 'file', artifactId: params.artifactId as string },
        params,
        grounding: contract.grounding,
        evidenceSchemaId: contract.evidenceSchemaId,
      }
      return options.agenticRunner.run({
        contract,
        plan,
        workspace,
        parent: env?.parent,
        signal: env?.signal ?? new AbortController().signal,
        runId: env?.runId,
      })
    },
  })
  return registry
}

/** Execute one trusted acceptance plan and enforce its evidence contract. */
export async function verifyAcceptancePlan(
  plan: AcceptancePlan,
  registry: VerifierContractRegistry,
  reader: SnapshotReader,
  workspace: IsolatedWorkspace,
  env?: VerifierExecutionEnv,
): Promise<Settlement> {
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
  if (spec.grounding.kind === 'programmatic') {
    if (plan.grounding.kind !== 'programmatic' || plan.grounding.extractorId !== spec.grounding.extractorId) {
      throw new Error(`acceptance plan grounding mismatch for ${plan.goalId}`)
    }
  } else if (plan.grounding.kind !== 'non_programmatic') {
    throw new Error(`acceptance plan grounding mismatch for ${plan.goalId}`)
  }
  const result = await spec.execute(workspace, plan.snapshot, params, reader, env)
  if (result.state !== 'inconclusive' && !isNonEmptyJsonObject(result.observation)) {
    throw new Error(`trusted verifier ${plan.verifierId}@${plan.verifierVersion} returned invalid evidence`)
  }
  if (result.state !== 'inconclusive' && !result.observation) {
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

function paramsWithTargetRequirement(params: Record<string, JsonValue>): Record<string, JsonValue> {
  const allowed = new Set(['artifactId', 'target', 'requirement'])
  const actual = Object.keys(params)
  if (actual.length < 1 || actual.some(key => !allowed.has(key))) {
    throw new Error('unexpected verifier parameters; expected artifactId plus optional target/requirement')
  }
  const artifactId = requireString(params, 'artifactId')
  const result: Record<string, JsonValue> = { artifactId }
  if (params.target !== undefined) {
    if (typeof params.target !== 'string' || params.target.length === 0) throw new Error('verifier parameter target must be a non-empty string')
    result.target = params.target
  }
  if (params.requirement !== undefined) {
    if (typeof params.requirement !== 'string' || params.requirement.length === 0) throw new Error('verifier parameter requirement must be a non-empty string')
    result.requirement = params.requirement
  }
  return result
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
