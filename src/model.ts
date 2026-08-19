/** Core JSON-compatible types for the DoG v0.1 graph protocol. */

export const DOG_SCHEMA_VERSION = '0.1' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type GoalId = string
export type ConstraintKind = 'hard' | 'soft'
export type GoalKind = 'leaf' | 'composite'
export type FailurePolicy = 'fatal' | 'tolerable' | 'degrade'
export type MergePolicy = 'none' | 'parent' | 'human'
export type GoalState =
  | 'pending'
  | 'running'
  | 'success'
  | 'failure'
  | 'blocked'
  | 'needs_human'
  | 'cancelled'
  | 'invalidated'
  | 'partial'

export interface RefExpr {
  readonly op: 'ref'
  readonly id: GoalId
}

export interface AllExpr {
  readonly op: 'all'
  readonly items: readonly BoolExpr[]
}

export interface AnyExpr {
  readonly op: 'any'
  readonly items: readonly BoolExpr[]
}

export interface NotExpr {
  readonly op: 'not'
  readonly item: BoolExpr
}

export interface AtLeastExpr {
  readonly op: 'atLeast'
  readonly count: number
  readonly items: readonly BoolExpr[]
}

export type BoolExpr = RefExpr | AllExpr | AnyExpr | NotExpr | AtLeastExpr

export interface VerifierRef {
  readonly id: string
  readonly version: string
}

export interface GoalNodeInput {
  readonly kind: GoalKind
  readonly title: string
  readonly constraint: ConstraintKind
  readonly completion?: BoolExpr
  readonly verifier?: VerifierRef
  readonly verifierParams?: Record<string, JsonValue>
}

export interface ContainsEdge {
  readonly parent: GoalId
  readonly child: GoalId
  readonly required: boolean
  readonly failure: FailurePolicy
  readonly degradeTo?: GoalId
  readonly merge?: MergePolicy
}

export interface DependencyEdge {
  readonly source: GoalId
  readonly target: GoalId
  readonly data?: readonly string[]
}

export interface DogGraphInput {
  readonly schemaVersion: typeof DOG_SCHEMA_VERSION
  readonly id: string
  readonly root: GoalId
  readonly nodes: Record<GoalId, GoalNodeInput>
  readonly contains: readonly ContainsEdge[]
  readonly dependsOn: readonly DependencyEdge[]
}

export interface ArtifactRootBinding {
  readonly id: string
  readonly path: string
}

export interface ArtifactBinding {
  readonly id: string
  readonly rootId: string
  readonly relativePath: string
}

export interface DogConfig {
  readonly artifactRoots: readonly ArtifactRootBinding[]
  readonly artifactBindings: readonly ArtifactBinding[]
  readonly storageDirectory: string
  readonly maxGraphNodes: number
  readonly maxExpressionNodes: number
  readonly maxExpressionDepth: number
  readonly maxSnapshotBytes: number
  readonly allowPartialRoot: boolean
}

export interface GraphLimits {
  readonly maxGraphNodes: number
  readonly maxExpressionNodes: number
  readonly maxExpressionDepth: number
}

export interface ArtifactSnapshot {
  readonly artifactId: string
  readonly snapshotId: string
  readonly exists: boolean
  readonly byteLength: number
  readonly sha256: string
}

export interface ArtifactScope {
  readonly kind: 'file'
  readonly artifactId: string
}

export interface AcceptancePlan {
  readonly goalId: GoalId
  readonly verifierId: string
  readonly verifierVersion: string
  readonly artifactId: string
  readonly rootBindingId: string
  readonly relativePath: string
  readonly snapshot: ArtifactSnapshot
  readonly scope: ArtifactScope
  readonly params: Record<string, JsonValue>
  readonly evidenceSchemaId: string
}

export interface VerificationRecord {
  readonly goalId: GoalId
  readonly runId: string
  readonly graphDigest: string
  readonly verifierId: string
  readonly verifierVersion: string
  readonly artifactId: string
  readonly snapshotId: string
  readonly passed: boolean
  readonly observation: Record<string, JsonValue>
  readonly verifiedAt: string
}

export interface GoalResult {
  readonly state: GoalState
  readonly reason?: string
  readonly verification?: VerificationRecord
}

export type RootTerminalState =
  | 'success'
  | 'partial_success'
  | 'failure'
  | 'infeasible'
  | 'needs_replan'
  | 'cancelled'

export interface CompiledGraph {
  readonly input: DogGraphInput
  readonly graphDigest: string
  readonly acceptancePlans: Readonly<Record<GoalId, AcceptancePlan>>
}

export interface DogRun {
  readonly runId: string
  readonly graphId: string
  readonly graphDigest: string
  readonly state: 'created' | 'running' | 'completed'
  readonly rootState?: RootTerminalState
  readonly goals: Readonly<Record<GoalId, GoalResult>>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface GraphValidationReport {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
