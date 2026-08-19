/** Runtime validation for trusted debugger RPC responses. */

import { parseGraph } from '../graph.ts'
import { isJsonValue } from '../model.ts'
import type {
  AcceptancePlan,
  ArtifactSnapshot,
  DogRun,
  GoalAgentRole,
  GoalAgentSessionRef,
  GoalResult,
  GoalRuntimeEvent,
  GoalRuntimeTrace,
  GoalState,
  JsonValue,
  RootTerminalState,
  RunInvocationContext,
  VerificationRecord,
} from '../model.ts'
import type { DogDebugGraphRevision, DogDebugSnapshot } from '../debug.ts'

const DIGEST = /^[a-f0-9]{64}$/u
const GOAL_STATES = new Set<GoalState>([
  'pending', 'running', 'success', 'failure', 'blocked', 'needs_human',
  'cancelled', 'invalidated', 'partial',
])
const ROOT_STATES = new Set<RootTerminalState>([
  'success', 'partial_success', 'failure', 'infeasible', 'needs_replan', 'cancelled',
])
const GOAL_AGENT_ROLES = new Set<GoalAgentRole>(['orchestrator', 'executor', 'verifier', 'reviewer'])
const RUNTIME_EVENT_KINDS = new Set<GoalRuntimeEvent['kind']>([
  'goal_started', 'dependency_blocked', 'verifier_started', 'verifier_passed',
  'verifier_failed', 'composite_evaluated', 'goal_error', 'goal_settled',
])
const RUNTIME_ERROR_KINDS = new Set(['acceptance_plan_missing', 'completion_expression_missing', 'verification_error'])
const RUNTIME_STAGES = new Set(['scheduling', 'verification', 'composition'])

/** Parse JSON from the debugger endpoint before it reaches render code. */
export function parseDogDebugSnapshot(value: unknown): DogDebugSnapshot {
  const root = requireRecord(value, '$')
  if (root.schemaVersion !== '0.1') throw new Error('debug snapshot schemaVersion must be 0.1')
  const graphs = requireArray(root.graphs, '$.graphs').map((item, index) => parseRevision(item, `$.graphs[${index}]`))
  return {
    schemaVersion: '0.1',
    generatedAt: requireString(root.generatedAt, '$.generatedAt'),
    graphs,
  }
}

/** Parse one lazy per-goal runtime trace before it reaches render code. */
export function parseGoalRuntimeTrace(value: unknown): GoalRuntimeTrace {
  const root = requireRecord(value, '$')
  if (root.schemaVersion !== '0.1') throw new Error('runtime trace schemaVersion must be 0.1')
  const runId = requireBoundedString(root.runId, '$.runId')
  const graphDigest = requireDigest(root.graphDigest, '$.graphDigest')
  const goalId = requireBoundedString(root.goalId, '$.goalId')
  const runState = parseRunState(root.runState, '$.runState')
  const result = parseGoalResult(root.result, '$.result')
  const rootState = root.rootState === undefined ? undefined : parseRootState(root.rootState, '$.rootState')
  const invocation = root.invocation === undefined ? undefined : parseInvocation(root.invocation, '$.invocation')
  const events = requireArray(root.events, '$.events').map((item, index) => (
    parseRuntimeEvent(item, `$.events[${index}]`, { runId, graphDigest, goalId })
  ))
  for (let index = 1; index < events.length; index++) {
    if ((events[index - 1]?.sequence ?? -1) >= (events[index]?.sequence ?? -1)) {
      throw new Error('$.events must be strictly ordered by sequence')
    }
  }
  if (typeof root.truncated !== 'boolean') throw new Error('$.truncated must be a boolean')
  const runtimeWarning = root.runtimeWarning === undefined
    ? undefined
    : requireBoundedString(root.runtimeWarning, '$.runtimeWarning')
  return {
    schemaVersion: '0.1',
    runId,
    graphId: requireBoundedString(root.graphId, '$.graphId'),
    graphDigest,
    runState,
    ...(rootState === undefined ? {} : { rootState }),
    goalId,
    result,
    ...(invocation === undefined ? {} : { invocation }),
    ...(runtimeWarning === undefined ? {} : { runtimeWarning }),
    events,
    truncated: root.truncated,
  }
}

function parseRuntimeEvent(
  value: unknown,
  path: string,
  expected: { readonly runId: string; readonly graphDigest: string; readonly goalId: string },
): GoalRuntimeEvent {
  const root = requireRecord(value, path)
  if (root.schemaVersion !== '0.1') throw new Error(`${path}.schemaVersion must be 0.1`)
  const runId = requireBoundedString(root.runId, `${path}.runId`)
  const graphDigest = requireDigest(root.graphDigest, `${path}.graphDigest`)
  const goalId = requireBoundedString(root.goalId, `${path}.goalId`)
  if (runId !== expected.runId || graphDigest !== expected.graphDigest || goalId !== expected.goalId) {
    throw new Error(`${path} does not belong to the requested goal trace`)
  }
  const sequence = requireNonNegativeInteger(root.sequence, `${path}.sequence`)
  const attempt = requireNonNegativeInteger(root.attempt, `${path}.attempt`)
  if (attempt < 1) throw new Error(`${path}.attempt must be positive`)
  const kind = requireString(root.kind, `${path}.kind`)
  if (!RUNTIME_EVENT_KINDS.has(kind as GoalRuntimeEvent['kind'])) throw new Error(`${path}.kind is invalid`)
  const state = root.state === undefined ? undefined : parseGoalState(root.state, `${path}.state`)
  const reason = root.reason === undefined ? undefined : requireBoundedString(root.reason, `${path}.reason`)
  const verifierRecord = root.verifier === undefined ? undefined : requireRecord(root.verifier, `${path}.verifier`)
  const verifier = verifierRecord === undefined ? undefined : {
    id: requireBoundedString(verifierRecord.id, `${path}.verifier.id`),
    version: requireBoundedString(verifierRecord.version, `${path}.verifier.version`),
    artifactId: requireBoundedString(verifierRecord.artifactId, `${path}.verifier.artifactId`),
  }
  const errorRecord = root.error === undefined ? undefined : requireRecord(root.error, `${path}.error`)
  const error = errorRecord === undefined ? undefined : {
    kind: requireString(errorRecord.kind, `${path}.error.kind`),
    stage: requireString(errorRecord.stage, `${path}.error.stage`),
    message: requireBoundedString(errorRecord.message, `${path}.error.message`),
  }
  if (error !== undefined && (!RUNTIME_ERROR_KINDS.has(error.kind) || !RUNTIME_STAGES.has(error.stage))) {
    throw new Error(`${path}.error is invalid`)
  }
  const durationMs = root.durationMs === undefined
    ? undefined
    : requireNonNegativeInteger(root.durationMs, `${path}.durationMs`)
  return {
    schemaVersion: '0.1',
    runId,
    graphDigest,
    goalId,
    sequence,
    attempt,
    kind: kind as GoalRuntimeEvent['kind'],
    at: requireString(root.at, `${path}.at`),
    ...(state === undefined ? {} : { state }),
    ...(reason === undefined ? {} : { reason }),
    ...(verifier === undefined ? {} : { verifier }),
    ...(error === undefined ? {} : { error: error as NonNullable<GoalRuntimeEvent['error']> }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function parseRevision(value: unknown, path: string): DogDebugGraphRevision {
  const root = requireRecord(value, path)
  const graphRecord = requireRecord(root.graph, `${path}.graph`)
  const graphDigest = requireDigest(graphRecord.graphDigest, `${path}.graph.graphDigest`)
  const input = parseGraph(graphRecord.input, {
    maxGraphNodes: 4096,
    maxExpressionNodes: 8192,
    maxExpressionDepth: 256,
  })
  const acceptancePlans = parseAcceptancePlans(graphRecord.acceptancePlans, `${path}.graph.acceptancePlans`)
  const runs = requireArray(root.runs, `${path}.runs`).map((item, index) => {
    const run = parseRun(item, `${path}.runs[${index}]`)
    if (run.graphDigest !== graphDigest) throw new Error(`${path}.runs[${index}]: graph digest mismatch`)
    return run
  })
  if (typeof root.current !== 'boolean') throw new Error(`${path}.current must be a boolean`)
  return {
    graph: { input, graphDigest, acceptancePlans },
    current: root.current,
    runs,
  }
}

function parseAcceptancePlans(value: unknown, path: string): Record<string, AcceptancePlan> {
  const root = requireRecord(value, path)
  const result: Record<string, AcceptancePlan> = {}
  for (const [key, item] of Object.entries(root)) {
    const plan = parseAcceptancePlan(item, `${path}.${key}`)
    if (plan.goalId !== key) throw new Error(`${path}.${key}: goalId mismatch`)
    result[key] = plan
  }
  return result
}

function parseAcceptancePlan(value: unknown, path: string): AcceptancePlan {
  const root = requireRecord(value, path)
  const artifactId = requireString(root.artifactId, `${path}.artifactId`)
  const scope = requireRecord(root.scope, `${path}.scope`)
  if (scope.kind !== 'file' || scope.artifactId !== artifactId) throw new Error(`${path}.scope is invalid`)
  const snapshot = parseSnapshot(root.snapshot, `${path}.snapshot`)
  if (snapshot.artifactId !== artifactId) throw new Error(`${path}.snapshot artifact mismatch`)
  return {
    goalId: requireString(root.goalId, `${path}.goalId`),
    verifierId: requireString(root.verifierId, `${path}.verifierId`),
    verifierVersion: requireString(root.verifierVersion, `${path}.verifierVersion`),
    artifactId,
    rootBindingId: requireString(root.rootBindingId, `${path}.rootBindingId`),
    relativePath: requireString(root.relativePath, `${path}.relativePath`),
    snapshot,
    scope: { kind: 'file', artifactId },
    params: requireJsonRecord(root.params, `${path}.params`),
    evidenceSchemaId: requireString(root.evidenceSchemaId, `${path}.evidenceSchemaId`),
  }
}

function parseSnapshot(value: unknown, path: string): ArtifactSnapshot {
  const root = requireRecord(value, path)
  const exists = root.exists
  const byteLength = root.byteLength
  if (typeof exists !== 'boolean') throw new Error(`${path}.exists must be a boolean`)
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error(`${path}.byteLength must be a non-negative safe integer`)
  }
  return {
    artifactId: requireString(root.artifactId, `${path}.artifactId`),
    snapshotId: requireString(root.snapshotId, `${path}.snapshotId`),
    exists,
    byteLength,
    sha256: requireString(root.sha256, `${path}.sha256`),
  }
}

function parseRun(value: unknown, path: string): DogRun {
  const root = requireRecord(value, path)
  const state = parseRunState(root.state, `${path}.state`)
  const goalsRecord = requireRecord(root.goals, `${path}.goals`)
  const goals: Record<string, GoalResult> = {}
  for (const [id, result] of Object.entries(goalsRecord)) goals[id] = parseGoalResult(result, `${path}.goals.${id}`)
  const rootState = root.rootState === undefined ? undefined : parseRootState(root.rootState, `${path}.rootState`)
  const invocation = root.invocation === undefined ? undefined : parseInvocation(root.invocation, `${path}.invocation`)
  const runtimeWarning = root.runtimeWarning === undefined
    ? undefined
    : requireBoundedString(root.runtimeWarning, `${path}.runtimeWarning`)
  return {
    runId: requireString(root.runId, `${path}.runId`),
    graphId: requireString(root.graphId, `${path}.graphId`),
    graphDigest: requireDigest(root.graphDigest, `${path}.graphDigest`),
    state,
    ...(rootState === undefined ? {} : { rootState }),
    goals,
    ...(invocation === undefined ? {} : { invocation }),
    ...(runtimeWarning === undefined ? {} : { runtimeWarning }),
    createdAt: requireString(root.createdAt, `${path}.createdAt`),
    updatedAt: requireString(root.updatedAt, `${path}.updatedAt`),
  }
}

function parseInvocation(value: unknown, path: string): RunInvocationContext {
  const root = requireRecord(value, path)
  const agentSessionId = root.agentSessionId === undefined
    ? undefined
    : requireBoundedString(root.agentSessionId, `${path}.agentSessionId`)
  const parentSessionId = root.parentSessionId === undefined
    ? undefined
    : requireBoundedString(root.parentSessionId, `${path}.parentSessionId`)
  if (parentSessionId !== undefined && agentSessionId === undefined) {
    throw new Error(`${path}.parentSessionId requires agentSessionId`)
  }
  return {
    callId: requireBoundedString(root.callId, `${path}.callId`),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    invokedAt: requireString(root.invokedAt, `${path}.invokedAt`),
  }
}

function parseGoalResult(value: unknown, path: string): GoalResult {
  const root = requireRecord(value, path)
  const state = parseGoalState(root.state, `${path}.state`)
  const reason = root.reason === undefined ? undefined : requireString(root.reason, `${path}.reason`)
  const verification = root.verification === undefined
    ? undefined
    : parseVerification(root.verification, `${path}.verification`)
  const agentSessions = root.agentSessions === undefined
    ? undefined
    : requireArray(root.agentSessions, `${path}.agentSessions`).map((agent, index) => (
      parseGoalAgentSession(agent, `${path}.agentSessions[${index}]`)
    ))
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    ...(verification === undefined ? {} : { verification }),
    ...(agentSessions === undefined ? {} : { agentSessions }),
  }
}

function parseGoalAgentSession(value: unknown, path: string): GoalAgentSessionRef {
  const root = requireRecord(value, path)
  const role = requireBoundedString(root.role, `${path}.role`) as GoalAgentRole
  if (!GOAL_AGENT_ROLES.has(role)) throw new Error(`${path}.role is invalid`)
  const parentSessionId = root.parentSessionId === undefined
    ? undefined
    : requireBoundedString(root.parentSessionId, `${path}.parentSessionId`)
  return {
    sessionId: requireBoundedString(root.sessionId, `${path}.sessionId`),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    role,
    boundAt: requireBoundedString(root.boundAt, `${path}.boundAt`),
  }
}

function parseVerification(value: unknown, path: string): VerificationRecord {
  const root = requireRecord(value, path)
  if (typeof root.passed !== 'boolean') throw new Error(`${path}.passed must be a boolean`)
  return {
    goalId: requireString(root.goalId, `${path}.goalId`),
    runId: requireString(root.runId, `${path}.runId`),
    graphDigest: requireDigest(root.graphDigest, `${path}.graphDigest`),
    verifierId: requireString(root.verifierId, `${path}.verifierId`),
    verifierVersion: requireString(root.verifierVersion, `${path}.verifierVersion`),
    artifactId: requireString(root.artifactId, `${path}.artifactId`),
    snapshotId: requireString(root.snapshotId, `${path}.snapshotId`),
    passed: root.passed,
    observation: requireJsonRecord(root.observation, `${path}.observation`),
    verifiedAt: requireString(root.verifiedAt, `${path}.verifiedAt`),
  }
}

function parseGoalState(value: unknown, path: string): GoalState {
  if (typeof value !== 'string' || !GOAL_STATES.has(value as GoalState)) throw new Error(`${path} is invalid`)
  return value as GoalState
}

function parseRootState(value: unknown, path: string): RootTerminalState {
  if (typeof value !== 'string' || !ROOT_STATES.has(value as RootTerminalState)) throw new Error(`${path} is invalid`)
  return value as RootTerminalState
}

function parseRunState(value: unknown, path: string): DogRun['state'] {
  if (value !== 'created' && value !== 'running' && value !== 'completed') throw new Error(`${path} is invalid`)
  return value
}

function requireDigest(value: unknown, path: string): string {
  const text = requireString(value, path)
  if (!DIGEST.test(text)) throw new Error(`${path} must be a SHA-256 digest`)
  return text
}

function requireJsonRecord(value: unknown, path: string): Record<string, JsonValue> {
  const root = requireRecord(value, path)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(root)) {
    if (!isJsonValue(item)) throw new Error(`${path}.${key} must be JSON-compatible`)
    result[key] = item
  }
  return result
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

function requireBoundedString(value: unknown, path: string): string {
  const text = requireString(value, path)
  if (text.length === 0 || text.length > 512) throw new Error(`${path} must contain 1-512 characters`)
  return text
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer`)
  }
  return value
}
