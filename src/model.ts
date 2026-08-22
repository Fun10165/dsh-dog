/** Core JSON-compatible types for the DoG v0.2 Agentic CI protocol. */

export const DOG_SCHEMA_VERSION = '0.2' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type GoalId = string
export type ConstraintKind = 'hard' | 'soft'
export type GoalKind = 'leaf' | 'composite'
export type FailurePolicy = 'fatal' | 'tolerable' | 'degrade'
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
  | 'inherited'

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
  readonly maxConcurrentVerifications: number
  readonly revalidateThreshold: number
  readonly gmDigestAlgo: string
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

export type GroundingDeclaration =
  | { readonly kind: 'programmatic'; readonly extractorId: string; readonly schema: string }
  | { readonly kind: 'non_programmatic' }

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
  readonly grounding: GroundingDeclaration
  readonly evidenceSchemaId: string
  readonly gmDigest?: string
}

export interface VerificationRecord {
  readonly schemaVersion: '0.1'
  readonly runId: string
  readonly graphId: string
  readonly graphDigest: string
  readonly goalId: GoalId
  readonly verifierId: string
  readonly verifierVersion: string
  readonly artifactId: string
  readonly snapshotId: string
  readonly gmDigest?: string
  readonly passed: boolean
  readonly observation: Record<string, JsonValue>
  readonly at: string
}

export interface GoalRuntimeVerifier {
  readonly id: string
  readonly version: string
  readonly artifactId: string
}

export interface GoalRuntimeError {
  readonly kind: 'acceptance_plan_missing' | 'completion_expression_missing' | 'verification_error' | 'agentic_unavailable'
  readonly stage: 'scheduling' | 'verification' | 'composition'
  readonly message: string
}

export type GoalRuntimePhase =
  | 'goal_started'
  | 'dependency_blocked'
  | 'grounding_extracted'
  | 'workspace_allocated'
  | 'verifier_started'
  | 'verifier_passed'
  | 'verifier_failed'
  | 'verifier_inconclusive'
  | 'composite_evaluated'
  | 'result_inherited'
  | 'structured_error'
  | 'goal_settled'
  | 'run_warning'

/** One append-only diagnostic event. It is operational context, never verifier evidence. */
export interface GoalRuntimeEvent {
  readonly schemaVersion: '0.1'
  readonly runId: string
  readonly goalId: GoalId
  readonly phase: GoalRuntimePhase
  readonly state?: GoalState
  readonly at: string
  readonly reason?: string
  readonly verifier?: GoalRuntimeVerifier
  readonly gmDigest?: string
  readonly attempt?: number
  readonly durationMs?: number
}

export type GoalAgentRole = 'orchestrator' | 'verifier' | 'reviewer'

/** Trusted session identity captured when an Agent binds itself to one goal. */
export interface GoalAgentSessionRef {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly role: GoalAgentRole
  readonly boundAt: string
}

/** Host-derived identity for the DSH tool call that started a run. */
export interface RunInvocationContext {
  readonly callId: string
  readonly agentSessionId?: string
  readonly parentSessionId?: string
  readonly invokedAt: string
}

export interface GoalResult {
  readonly state: GoalState
  readonly reason?: string
  readonly verification?: VerificationRecord
  readonly inheritedFrom?: string
  readonly agentSessions?: readonly GoalAgentSessionRef[]
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
  readonly state: 'running' | 'completed' | 'cancelled' | 'failed'
  readonly rootState?: RootTerminalState
  readonly invocation?: RunInvocationContext
  readonly runtimeWarning?: string
  readonly gmDigests: Readonly<Record<GoalId, string>>
  readonly goals: Readonly<Record<GoalId, GoalResult>>
  readonly createdAt: string
  readonly updatedAt: string
}

/** Lazy, per-goal debugger payload. Raw session transcripts and artifact bytes are deliberately excluded. */
export interface GoalRuntimeTrace {
  readonly schemaVersion: '0.1'
  readonly runId: string
  readonly graphId: string
  readonly graphDigest: string
  readonly runState: DogRun['state']
  readonly rootState?: RootTerminalState
  readonly goalId: GoalId
  readonly result: GoalResult
  readonly invocation?: RunInvocationContext
  readonly runtimeWarning?: string
  readonly events: readonly GoalRuntimeEvent[]
  readonly truncated: boolean
}

export interface GraphValidationReport {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

export interface CiGoalReport {
  readonly goalId: GoalId
  readonly state: GoalState
  readonly verifier?: GoalRuntimeVerifier
  readonly evidence?: readonly Record<string, JsonValue>[]
  readonly defect?: string
  readonly settledAt?: string
}

export interface CiReport {
  readonly runId: string
  readonly graphId: string
  readonly graphDigest?: string
  readonly rootState: RootTerminalState | 'running' | 'cancelled'
  readonly goals: readonly CiGoalReport[]
  readonly revalidated?: readonly GoalId[]
  readonly inherited?: readonly { goalId: GoalId; fromRunId: string; state: 'inherited' }[]
  readonly warning?: string
  readonly generatedAt: string
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
