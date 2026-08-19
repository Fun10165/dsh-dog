/** DoG compilation, trusted verification, and all-parent recomputation engine. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { evaluateBoolExpr } from './logic.ts'
import { DogValidationError, parseGraph } from './graph.ts'
import { sha256Json } from './json.ts'
import type {
  AcceptancePlan,
  CompiledGraph,
  DogConfig,
  DogGraphInput,
  DogRun,
  GoalRuntimeError,
  GoalRuntimeEvent,
  GoalState,
  GoalAgentRole,
  GoalAgentSessionRef,
  GoalResult,
  GraphValidationReport,
  JsonValue,
  RootTerminalState,
  VerificationRecord,
} from './model.ts'
import { DogRepository, captureArtifactSnapshot, type CapturedArtifact, type HostArtifactConfig } from './storage.ts'
import {
  AtomicVerifierRegistry,
  createBuiltinVerifierRegistry,
  verifyAcceptancePlan,
} from './verifiers.ts'

export interface DogEngineOptions {
  readonly config: DogConfig
  readonly repository: DogRepository
  readonly verifiers?: AtomicVerifierRegistry
  readonly now?: () => Date
  readonly nextRunId?: () => string
}

export interface DogRunOptions {
  readonly invocation?: {
    readonly callId: string
    readonly agentSessionId?: string
    readonly parentSessionId?: string
  }
}

export interface DogBindAgentOptions {
  readonly runId: string
  readonly goalId: string
  readonly role: GoalAgentRole
  readonly sessionId: string
  readonly parentSessionId?: string
}

export interface DogAgentDelegationOptions {
  readonly runId: string
  readonly goalId: string
  readonly parentSessionId: string
}


interface RuntimeEventDetails {
  readonly at?: string
  readonly state?: GoalState
  readonly reason?: string
  readonly verifier?: GoalRuntimeEvent['verifier']
  readonly error?: GoalRuntimeError
  readonly durationMs?: number
}

const GOAL_AGENT_ROLES = new Set<GoalAgentRole>(['orchestrator', 'executor', 'verifier', 'reviewer'])

/** Verification-first DoG service used by the DSH tools and tests. */
export class DogEngine {
  private readonly config: DogConfig
  private readonly repository: DogRepository
  private readonly verifiers: AtomicVerifierRegistry
  private readonly now: () => Date
  private readonly nextRunId: () => string
  private readonly hostArtifacts: HostArtifactConfig

  constructor(options: DogEngineOptions) {
    validateHostConfig(options.config)
    this.config = options.config
    this.repository = options.repository
    this.verifiers = options.verifiers ?? createBuiltinVerifierRegistry()
    this.now = options.now ?? (() => new Date())
    this.nextRunId = options.nextRunId ?? (() => randomUUID())
    this.hostArtifacts = {
      roots: options.config.artifactRoots,
      bindings: options.config.artifactBindings,
    }
  }

  /** Validate graph structure, trusted verifier bindings, and host artifact references without snapshotting. */
  validate(value: unknown): GraphValidationReport {
    try {
      const graph = this.parse(value)
      this.validateBindings(graph)
      return { valid: true, errors: [], warnings: graphWarnings(graph) }
    } catch (error) {
      const errors = error instanceof DogValidationError ? [...error.errors] : [messageOf(error)]
      return { valid: false, errors, warnings: [] }
    }
  }

  /** Compile and persist one graph revision against current host-bound artifact snapshots. */
  async create(value: unknown): Promise<CompiledGraph> {
    const graph = this.parse(value)
    this.validateBindings(graph)
    const acceptancePlans: Record<string, AcceptancePlan> = {}
    const snapshotCache = new Map<string, CapturedArtifact>()
    for (const [goalId, node] of Object.entries(graph.nodes)) {
      if (node.kind !== 'leaf' || node.verifier === undefined) continue
      const spec = this.verifiers.get(node.verifier.id, node.verifier.version)
      const params = spec.validateParams(node.verifierParams ?? {})
      const artifactId = requireArtifactId(params, goalId)
      let captured = snapshotCache.get(artifactId)
      if (captured === undefined) {
        captured = await captureArtifactSnapshot(
          this.hostArtifacts,
          artifactId,
          this.config.maxSnapshotBytes,
          this.repository,
        )
        snapshotCache.set(artifactId, captured)
      }
      acceptancePlans[goalId] = {
        goalId,
        verifierId: spec.id,
        verifierVersion: spec.version,
        artifactId,
        rootBindingId: captured.rootBindingId,
        relativePath: captured.relativePath,
        snapshot: captured.snapshot,
        scope: { kind: 'file', artifactId },
        params,
        evidenceSchemaId: spec.evidenceSchemaId,
      }
    }
    const graphDigest = sha256Json({ input: graph, acceptancePlans })
    const compiled = deepFreeze({ input: graph, graphDigest, acceptancePlans })
    await this.repository.saveGraph(compiled)
    return compiled
  }

  /** Run every trusted verifier, persist per-goal runtime context, and recompute all parents. */
  async run(graphId: string, options: DogRunOptions = {}): Promise<DogRun> {
    const compiled = await this.repository.loadGraph(graphId)
    const runId = this.nextRunId()
    const createdAt = this.now().toISOString()
    const invocation = options.invocation === undefined
      ? undefined
      : {
          callId: requireContextId(options.invocation.callId, 'invocation callId'),
          ...(options.invocation.agentSessionId === undefined ? {} : {
            agentSessionId: requireContextId(options.invocation.agentSessionId, 'invocation agentSessionId'),
          }),
          ...(options.invocation.parentSessionId === undefined ? {} : {
            parentSessionId: requireContextId(options.invocation.parentSessionId, 'invocation parentSessionId'),
          }),
          invokedAt: createdAt,
        }
    const goals: Record<string, GoalResult> = Object.fromEntries(
      Object.keys(compiled.input.nodes).map(id => [id, { state: 'pending' as const }]),
    )
    let run: DogRun = {
      runId,
      graphId: compiled.input.id,
      graphDigest: compiled.graphDigest,
      state: 'running',
      ...(invocation === undefined ? {} : { invocation }),
      goals,
      createdAt,
      updatedAt: createdAt,
    }
    await this.repository.saveRun(run)

    let eventSequence = 0
    const appendRuntimeEvent = async (
      goalId: string,
      kind: GoalRuntimeEvent['kind'],
      details: RuntimeEventDetails = {},
    ): Promise<void> => {
      const event: GoalRuntimeEvent = {
        schemaVersion: '0.1',
        runId,
        graphDigest: compiled.graphDigest,
        goalId,
        sequence: eventSequence++,
        attempt: 1,
        kind,
        at: details.at ?? this.now().toISOString(),
        ...(details.state === undefined ? {} : { state: details.state }),
        ...(details.reason === undefined ? {} : { reason: boundedMessage(details.reason) }),
        ...(details.verifier === undefined ? {} : { verifier: details.verifier }),
        ...(details.error === undefined ? {} : {
          error: { ...details.error, message: boundedMessage(details.error.message) },
        }),
        ...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
      }
      try {
        await this.repository.appendRuntimeEvent(event)
      } catch (error) {
        if (run.runtimeWarning === undefined) {
          run = { ...run, runtimeWarning: `runtime context write failed: ${boundedMessage(messageOf(error))}` }
        }
      }
    }
    const saveProgress = async (updatedAt: string): Promise<void> => {
      run = { ...run, goals: { ...goals }, updatedAt }
      await this.repository.saveRun(run)
    }

    const dependencies = dependenciesBySource(compiled.input)
    const children = childrenByParent(compiled.input)
    const relations = relationsByParent(compiled.input)
    const evaluateComposite = (goalId: string): GoalResult => {
      const node = compiled.input.nodes[goalId]
      const parentRelations = relations.get(goalId) ?? []
      const childIds = children.get(goalId) ?? []
      const values = relationTruthValues(parentRelations, goals)
      if (node?.completion === undefined) {
        return { state: 'needs_human', reason: 'validated composite lost its completion expression' }
      }
      const requiredFailures = parentRelations.filter(edge => edge.required && relationTruth(edge, goals) === false)
      const fatalRequiredFailure = requiredFailures.find(edge => edge.failure === 'fatal')
      const requiredUnknown = parentRelations.find(edge => edge.required && relationTruth(edge, goals) === undefined)
      if (fatalRequiredFailure !== undefined) {
        return { state: 'failure', reason: `required non-tolerable child ${fatalRequiredFailure.child} failed` }
      }
      if (requiredUnknown !== undefined) {
        return relationNeedsHuman(requiredUnknown, goals)
          ? { state: 'needs_human', reason: `required child relation ${requiredUnknown.child} requires human review` }
          : { state: 'blocked', reason: `required child ${requiredUnknown.child} is unresolved` }
      }
      if (requiredFailures.length > 0) {
        return { state: 'partial', reason: `required child ${requiredFailures[0]?.child ?? 'unknown'} failed under a tolerable policy` }
      }
      const completion = evaluateBoolExpr(node.completion, values)
      if (completion === true) return { state: 'success' }
      if (completion === 'unknown') {
        const humanChild = childIds.find(childId => dependencyNeedsHuman(goals[childId]))
        return humanChild === undefined
          ? { state: 'blocked', reason: 'one or more child outcomes are unresolved' }
          : { state: 'needs_human', reason: `child ${humanChild} requires human review` }
      }
      const failedRelations = parentRelations.filter(edge => relationTruth(edge, goals) === false)
      const fatal = failedRelations.find(edge => edge.failure === 'fatal')
      return fatal === undefined
        ? { state: 'partial', reason: 'completion rule is false, but every failed child relation is tolerable or optional' }
        : { state: 'failure', reason: `non-tolerable child ${fatal.child} failed` }
    }

    for (const goalId of postorder(compiled.input)) {
      const node = compiled.input.nodes[goalId]
      if (node === undefined) continue
      const startedAt = this.now().toISOString()
      goals[goalId] = { state: 'running' }
      await appendRuntimeEvent(goalId, 'goal_started', { at: startedAt, state: 'running' })
      await saveProgress(startedAt)

      let result: GoalResult
      const blockedDependency = (dependencies.get(goalId) ?? []).find(target => goals[target]?.state !== 'success')
      if (blockedDependency !== undefined) {
        const reason = `dependency ${blockedDependency} did not succeed`
        result = {
          state: dependencyNeedsHuman(goals[blockedDependency]) ? 'needs_human' : 'blocked',
          reason,
        }
        await appendRuntimeEvent(goalId, 'dependency_blocked', { state: result.state, reason })
      } else if (node.kind === 'leaf') {
        const plan = compiled.acceptancePlans[goalId]
        if (plan === undefined) {
          const error: GoalRuntimeError = {
            kind: 'acceptance_plan_missing',
            stage: 'scheduling',
            message: 'compiled acceptance plan is missing',
          }
          result = { state: 'needs_human', reason: error.message }
          await appendRuntimeEvent(goalId, 'goal_error', { state: result.state, error })
        } else {
          const verifier = {
            id: plan.verifierId,
            version: plan.verifierVersion,
            artifactId: plan.artifactId,
          }
          await appendRuntimeEvent(goalId, 'verifier_started', { state: 'running', verifier })
          try {
            const verified = await verifyAcceptancePlan(plan, this.verifiers, this.repository)
            const record: VerificationRecord = {
              goalId,
              runId,
              graphDigest: compiled.graphDigest,
              verifierId: plan.verifierId,
              verifierVersion: plan.verifierVersion,
              artifactId: plan.artifactId,
              snapshotId: plan.snapshot.snapshotId,
              passed: verified.passed,
              observation: verified.observation,
              verifiedAt: this.now().toISOString(),
            }
            await this.repository.appendVerification(record)
            result = { state: verified.passed ? 'success' : 'failure', verification: record }
            await appendRuntimeEvent(goalId, verified.passed ? 'verifier_passed' : 'verifier_failed', {
              state: result.state,
              verifier,
              ...(verified.passed ? {} : { reason: 'trusted verifier rejected the immutable artifact snapshot' }),
            })
          } catch (cause) {
            const error: GoalRuntimeError = {
              kind: 'verification_error',
              stage: 'verification',
              message: boundedMessage(messageOf(cause)),
            }
            result = { state: 'needs_human', reason: error.message }
            await appendRuntimeEvent(goalId, 'goal_error', { state: result.state, verifier, error })
          }
        }
      } else {
        result = evaluateComposite(goalId)
        if (node.completion === undefined) {
          await appendRuntimeEvent(goalId, 'goal_error', {
            state: result.state,
            error: {
              kind: 'completion_expression_missing',
              stage: 'composition',
              message: result.reason ?? 'validated composite lost its completion expression',
            },
          })
        } else {
          await appendRuntimeEvent(goalId, 'composite_evaluated', {
            state: result.state,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          })
        }
      }

      goals[goalId] = result
      const settledAt = this.now().toISOString()
      await appendRuntimeEvent(goalId, 'goal_settled', {
        at: settledAt,
        state: result.state,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        durationMs: elapsedMilliseconds(startedAt, settledAt),
      })
      await saveProgress(settledAt)
    }

    const rootResult = goals[compiled.input.root]
    const rootState = terminalState(rootResult, this.config.allowPartialRoot)
    const updatedAt = this.now().toISOString()
    run = {
      ...run,
      state: 'completed',
      rootState,
      goals: { ...goals },
      updatedAt,
    }
    await this.repository.saveRun(run)
    return deepFreeze(run)
  }

  /** Load a persisted run for status reporting. */
  async status(runId: string): Promise<DogRun> {
    return this.repository.loadRun(runId)
  }

  /** Authorize a trusted run Agent to create a child before the host allocates that session. */
  async assertAgentCanDelegate(options: DogAgentDelegationOptions): Promise<void> {
    const runId = requireContextId(options.runId, 'runId')
    const goalId = requireContextId(options.goalId, 'goalId')
    const parentSessionId = requireContextId(options.parentSessionId, 'delegating Agent sessionId')
    const run = await this.repository.loadRun(runId)
    if (run.goals[goalId] === undefined) throw new Error(`run ${runId} has no goal ${goalId}`)
    const ownerSessionId = run.invocation?.agentSessionId
    if (ownerSessionId === undefined) throw new Error(`run ${runId} has no trusted invocation Agent session`)
    const knownSessions = new Set<string>([ownerSessionId])
    for (const goal of Object.values(run.goals)) {
      for (const linked of goal.agentSessions ?? []) knownSessions.add(linked.sessionId)
    }
    if (!knownSessions.has(parentSessionId)) {
      throw new Error(`Agent session ${parentSessionId} is not rooted in run ${runId}`)
    }
  }

  /** Bind the trusted calling Agent session to one goal without accepting model-supplied session identity. */
  async bindAgent(options: DogBindAgentOptions): Promise<{ readonly run: DogRun; readonly agent: GoalAgentSessionRef }> {
    const runId = requireContextId(options.runId, 'runId')
    const goalId = requireContextId(options.goalId, 'goalId')
    const sessionId = requireContextId(options.sessionId, 'agent sessionId')
    const parentSessionId = options.parentSessionId === undefined
      ? undefined
      : requireContextId(options.parentSessionId, 'agent parentSessionId')
    if (!GOAL_AGENT_ROLES.has(options.role)) throw new Error(`unsupported goal Agent role ${String(options.role)}`)
    const boundAt = this.now().toISOString()
    let agent: GoalAgentSessionRef | undefined
    const run = await this.repository.updateRun(runId, current => {
      const result = current.goals[goalId]
      if (result === undefined) throw new Error(`run ${runId} has no goal ${goalId}`)
      const ownerSessionId = current.invocation?.agentSessionId
      if (ownerSessionId === undefined) throw new Error(`run ${runId} has no trusted invocation Agent session`)
      const knownSessions = new Set<string>([ownerSessionId])
      for (const goal of Object.values(current.goals)) {
        for (const linked of goal.agentSessions ?? []) knownSessions.add(linked.sessionId)
      }
      if (sessionId !== ownerSessionId && (parentSessionId === undefined || !knownSessions.has(parentSessionId))) {
        throw new Error(`Agent session ${sessionId} is not rooted in run ${runId}`)
      }
      agent = {
        sessionId,
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        role: options.role,
        boundAt,
      }
      const agentSessions = [...(result.agentSessions ?? []).filter(linked => linked.sessionId !== sessionId), agent]
      return {
        ...current,
        goals: { ...current.goals, [goalId]: { ...result, agentSessions } },
        updatedAt: boundAt,
      }
    })
    if (agent === undefined) throw new Error(`run ${runId} Agent binding did not commit`)
    return { run, agent }
  }

  private parse(value: unknown): DogGraphInput {
    return parseGraph(value, {
      maxGraphNodes: this.config.maxGraphNodes,
      maxExpressionNodes: this.config.maxExpressionNodes,
      maxExpressionDepth: this.config.maxExpressionDepth,
    })
  }

  private validateBindings(graph: DogGraphInput): void {
    const knownArtifacts = new Set(this.config.artifactBindings.map(binding => binding.id))
    for (const [goalId, node] of Object.entries(graph.nodes)) {
      if (node.kind !== 'leaf' || node.verifier === undefined) continue
      const spec = this.verifiers.get(node.verifier.id, node.verifier.version)
      const params = spec.validateParams(node.verifierParams ?? {})
      const artifactId = requireArtifactId(params, goalId)
      if (!knownArtifacts.has(artifactId)) throw new Error(`goal ${goalId} references unknown host artifact binding ${artifactId}`)
    }
  }
}

function validateHostConfig(config: DogConfig): void {
  if (config.maxGraphNodes < 1 || !Number.isInteger(config.maxGraphNodes)) throw new Error('maxGraphNodes must be a positive integer')
  if (config.maxExpressionNodes < 1 || !Number.isInteger(config.maxExpressionNodes)) throw new Error('maxExpressionNodes must be a positive integer')
  if (config.maxExpressionDepth < 1 || !Number.isInteger(config.maxExpressionDepth)) throw new Error('maxExpressionDepth must be a positive integer')
  if (config.maxSnapshotBytes < 1 || !Number.isInteger(config.maxSnapshotBytes)) throw new Error('maxSnapshotBytes must be a positive integer')
  if (config.storageDirectory.length === 0 || isAbsolute(config.storageDirectory) || hasTraversal(config.storageDirectory)) {
    throw new Error('storageDirectory must be a non-empty relative path without traversal')
  }
  assertUniqueIds(config.artifactRoots, 'artifact root')
  assertUniqueIds(config.artifactBindings, 'artifact binding')
  for (const root of config.artifactRoots) {
    if (!isAbsolute(root.path)) throw new Error(`artifact root ${root.id} path must be absolute`)
  }
  const roots = new Set(config.artifactRoots.map(root => root.id))
  for (const binding of config.artifactBindings) {
    if (!roots.has(binding.rootId)) throw new Error(`artifact binding ${binding.id} references unknown root ${binding.rootId}`)
    if (binding.relativePath.length === 0 || isAbsolute(binding.relativePath) || hasTraversal(binding.relativePath)) {
      throw new Error(`artifact binding ${binding.id} path must be a non-empty relative path without traversal`)
    }
  }

}

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]+/u).includes('..')
}

function assertUniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (value.id.length === 0) throw new Error(`${label} id must not be empty`)
    if (seen.has(value.id)) throw new Error(`duplicate ${label} id ${value.id}`)
    seen.add(value.id)
  }
}

function requireArtifactId(params: Record<string, JsonValue>, goalId: string): string {
  const artifactId = params.artifactId
  if (typeof artifactId !== 'string' || artifactId.length === 0) throw new Error(`goal ${goalId} verifier did not bind an artifactId`)
  return artifactId
}

function graphWarnings(graph: DogGraphInput): string[] {
  const parentCounts = new Map<string, number>()
  for (const edge of graph.contains) parentCounts.set(edge.child, (parentCounts.get(edge.child) ?? 0) + 1)
  return [...parentCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `goal ${id} is shared by ${count} parents; each parent relation is evaluated independently`)
}

function dependenciesBySource(graph: DogGraphInput): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const edge of graph.dependsOn) {
    const targets = result.get(edge.source) ?? []
    targets.push(edge.target)
    result.set(edge.source, targets)
  }
  return result
}

function childrenByParent(graph: DogGraphInput): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const edge of graph.contains) {
    const children = result.get(edge.parent) ?? []
    children.push(edge.child)
    result.set(edge.parent, children)
  }
  return result
}

function relationsByParent(graph: DogGraphInput): Map<string, DogGraphInput['contains'][number][]> {
  const result = new Map<string, DogGraphInput['contains'][number][]>()
  for (const edge of graph.contains) {
    const relations = result.get(edge.parent) ?? []
    relations.push(edge)
    result.set(edge.parent, relations)
  }
  return result
}

function postorder(graph: DogGraphInput): string[] {
  const outgoing = new Map<string, string[]>()
  for (const id of Object.keys(graph.nodes)) outgoing.set(id, [])
  for (const edge of graph.contains) outgoing.get(edge.parent)?.push(edge.child)
  for (const edge of graph.dependsOn) outgoing.get(edge.source)?.push(edge.target)
  const visited = new Set<string>()
  const order: string[] = []
  function visit(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    for (const target of outgoing.get(id) ?? []) visit(target)
    order.push(id)
  }
  for (const id of Object.keys(graph.nodes).sort()) visit(id)
  return order
}

function relationTruthValues(
  relations: readonly DogGraphInput['contains'][number][],
  goals: Readonly<Record<string, GoalResult>>,
): Map<string, boolean | undefined> {
  const values = new Map<string, boolean | undefined>()
  for (const relation of relations) values.set(relation.child, relationTruth(relation, goals))
  return values
}

function relationTruth(
  relation: DogGraphInput['contains'][number],
  goals: Readonly<Record<string, GoalResult>>,
): boolean | undefined {
  const direct = truthOf(goals[relation.child])
  if (direct === true) return true
  if (direct === undefined) return undefined
  if (relation.failure === 'degrade' && relation.degradeTo !== undefined) {
    const fallback = truthOf(goals[relation.degradeTo])
    if (fallback === true) return true
    if (fallback === undefined) return undefined
  }
  return false
}

function relationNeedsHuman(
  relation: DogGraphInput['contains'][number],
  goals: Readonly<Record<string, GoalResult>>,
): boolean {
  if (dependencyNeedsHuman(goals[relation.child])) return true
  return relation.failure === 'degrade'
    && relation.degradeTo !== undefined
    && dependencyNeedsHuman(goals[relation.degradeTo])
}

function truthOf(result: GoalResult | undefined): boolean | undefined {
  if (result?.state === 'success') return true
  if (result?.state === 'failure' || result?.state === 'partial' || result?.state === 'blocked') return false
  return undefined
}

function dependencyNeedsHuman(result: GoalResult | undefined): boolean {
  return result?.state === 'needs_human'
}

function terminalState(result: GoalResult | undefined, allowPartial: boolean): RootTerminalState {
  if (result?.state === 'success') return 'success'
  if (result?.state === 'partial') return allowPartial ? 'partial_success' : 'failure'
  if (result?.state === 'needs_human') return 'needs_replan'
  return 'failure'
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireContextId(value: string, label: string): string {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} must contain 1-512 characters`)
  return value
}

function boundedMessage(value: string): string {
  const normalized = value.length === 0 ? 'unknown runtime error' : value
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509)}...`
}

function elapsedMilliseconds(startedAt: string, settledAt: string): number {
  const elapsed = Date.parse(settledAt) - Date.parse(startedAt)
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0
}
