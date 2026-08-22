/** DoG v0.2 engine: graph compilation, programmatic-subtree rule, Agentic CI run. */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { evaluateBoolExpr } from './logic.ts'
import { DogValidationError, parseGraph } from './graph.ts'
import { sha256Json } from './json.ts'
import { computeGmDigest, createBuiltinExtractorRegistry, GroundingExtractorRegistry } from './extractors.ts'
import type {
  AcceptancePlan,
  ContainsEdge,
  CompiledGraph,
  DogConfig,
  DogGraphInput,
  DogRun,
  GoalResult,
  GoalRuntimeError,
  GoalRuntimeEvent,
  GoalRuntimePhase,
  GoalState,
  GoalAgentRole,
  GoalAgentSessionRef,
  GraphValidationReport,
  JsonValue,
  RootTerminalState,
  VerificationRecord,
} from './model.ts'
import { DogRepository, captureArtifactSnapshot, type CapturedArtifact, type HostArtifactConfig } from './storage.ts'
import { VerifierContractRegistry, createBuiltinVerifierRegistry, verifyAcceptancePlan } from './verifiers.ts'
import { WorkspaceManager } from './workspace.ts'

export interface DogEngineOptions {
  readonly config: DogConfig
  readonly repository: DogRepository
  readonly verifiers?: VerifierContractRegistry
  readonly extractors?: GroundingExtractorRegistry
  readonly workspaces?: WorkspaceManager
  readonly now?: () => Date
  readonly nextRunId?: () => string
}

export interface DogRunOptions {
  readonly invocation?: {
    readonly callId: string
    readonly agentSessionId?: string
    readonly parentSessionId?: string
  }
  readonly signal?: AbortSignal
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
  readonly gmDigest?: string
  readonly attempt?: number
  readonly durationMs?: number
}

const GOAL_AGENT_ROLES = new Set<GoalAgentRole>(['orchestrator', 'verifier', 'reviewer'])

/** Agentic CI engine used by the DSH tools and tests. */
export class DogEngine {
  private readonly config: DogConfig
  private readonly repository: DogRepository
  private readonly verifiers: VerifierContractRegistry
  private readonly extractors: GroundingExtractorRegistry
  private readonly workspaces: WorkspaceManager
  private readonly now: () => Date
  private readonly nextRunId: () => string
  private readonly hostArtifacts: HostArtifactConfig

  constructor(options: DogEngineOptions) {
    validateHostConfig(options.config)
    this.config = options.config
    this.repository = options.repository
    this.verifiers = options.verifiers ?? createBuiltinVerifierRegistry()
    this.extractors = options.extractors ?? createBuiltinExtractorRegistry()
    this.workspaces = options.workspaces ?? new WorkspaceManager()
    this.now = options.now ?? (() => new Date())
    this.nextRunId = options.nextRunId ?? (() => randomUUID())
    this.hostArtifacts = {
      roots: options.config.artifactRoots,
      bindings: options.config.artifactBindings,
    }
  }

  validate(value: unknown): GraphValidationReport {
    try {
      const graph = this.parse(value)
      this.validateBindings(graph)
      assertAgenticAtEveryComposite(graph, this.verifiers)
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
    assertAgenticAtEveryComposite(graph, this.verifiers)
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
      let gmDigest: string | undefined
      if (spec.grounding.kind === 'programmatic') {
        const extractor = this.extractors.get(spec.grounding.extractorId, '1')
        const grounded = await extractor.extract(captured.snapshot, this.repository)
        gmDigest = computeGmDigest(grounded, this.config.gmDigestAlgo)
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
        grounding: spec.grounding,
        evidenceSchemaId: spec.evidenceSchemaId,
        ...(gmDigest === undefined ? {} : { gmDigest }),
      }
    }
    const graphDigest = sha256Json({ input: graph, acceptancePlans })
    const compiled = deepFreeze({ input: graph, graphDigest, acceptancePlans })
    await this.repository.saveGraph(compiled)
    return compiled
  }

  /** Run the Agentic CI cycle: revalidate-select, parallel verification, recompute. */
  async run(graphId: string, options: DogRunOptions = {}): Promise<DogRun> {
    const signal = options.signal ?? new AbortController().signal
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
    const gmDigests: Record<string, string> = {}
    let run: DogRun = {
      runId,
      graphId: compiled.input.id,
      graphDigest: compiled.graphDigest,
      state: 'running',
      ...(invocation === undefined ? {} : { invocation }),
      gmDigests,
      goals,
      createdAt,
      updatedAt: createdAt,
    }
    await this.repository.saveRun(run)

    const appendRuntimeEvent = async (
      goalId: string,
      phase: GoalRuntimePhase,
      details: RuntimeEventDetails = {},
    ): Promise<void> => {
      const event: GoalRuntimeEvent = {
        schemaVersion: '0.1',
        runId,
        goalId,
        phase,
        at: details.at ?? this.now().toISOString(),
        ...(details.state === undefined ? {} : { state: details.state }),
        ...(details.reason === undefined ? {} : { reason: boundedMessage(details.reason) }),
        ...(details.verifier === undefined ? {} : { verifier: details.verifier }),
        ...(details.gmDigest === undefined ? {} : { gmDigest: details.gmDigest }),
        ...(details.attempt === undefined ? {} : { attempt: details.attempt }),
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
      run = { ...run, goals: { ...goals }, gmDigests: { ...gmDigests }, updatedAt }
      await this.repository.saveRun(run)
    }

    const dependencies = dependenciesBySource(compiled.input)
    const children = childrenByParent(compiled.input)
    const relations = relationsByParent(compiled.input)

    // ---- revalidate_select: partition leaves into re-run and inherited.
    const priorRun = await this.repository.loadLatestCompletedRun(compiled.input.id)
    const planFor = (goalId: string): AcceptancePlan | undefined => compiled.acceptancePlans[goalId]
    const inheritedFor = (goalId: string): GoalResult | undefined => {
      if (priorRun === undefined) return undefined
      const plan = planFor(goalId)
      if (plan === undefined || plan.gmDigest === undefined) return undefined
      const priorDigest = priorRun.gmDigests[goalId]
      if (priorDigest !== plan.gmDigest) return undefined
      const priorRecord = priorRun.goals[goalId]?.verification
      if (priorRecord === undefined || priorRecord.gmDigest === undefined || priorRecord.gmDigest !== plan.gmDigest) return undefined
      return { state: 'inherited', inheritedFrom: priorRun.runId, verification: priorRecord }
    }
    const leaves = Object.keys(compiled.input.nodes).filter(id => compiled.input.nodes[id]?.kind === 'leaf')
    for (const goalId of leaves) {
      const plan = planFor(goalId)
      if (plan === undefined) continue
      if (plan.gmDigest !== undefined) {
        gmDigests[goalId] = plan.gmDigest
        const inherited = inheritedFor(goalId)
        if (inherited !== undefined) {
          goals[goalId] = inherited
          await appendRuntimeEvent(goalId, 'result_inherited', {
            state: 'inherited',
            reason: `reused ${inherited.inheritedFrom ?? 'prior run'} verification record`,
            gmDigest: plan.gmDigest,
          })
          await saveProgress(this.now().toISOString())
        }
      }
    }
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

    const settleLeaf = async (goalId: string): Promise<GoalResult> => {
      const node = compiled.input.nodes[goalId]
      const plan = compiled.acceptancePlans[goalId]
      if (node === undefined || node.kind !== 'leaf') return goals[goalId] ?? { state: 'pending' }
      if (plan === undefined) {
        return { state: 'needs_human', reason: 'compiled acceptance plan is missing' }
      }
      const startedAt = this.now().toISOString()
      goals[goalId] = { state: 'running' }
      await appendRuntimeEvent(goalId, 'goal_started', { at: startedAt, state: 'running' })
      await saveProgress(startedAt)
      const workspace = await this.workspaces.acquire()
      await appendRuntimeEvent(goalId, 'workspace_allocated', { state: 'running', attempt: 1 })
      try {
        const verifier = {
          id: plan.verifierId,
          version: plan.verifierVersion,
          artifactId: plan.artifactId,
        }
        await appendRuntimeEvent(goalId, 'verifier_started', { state: 'running', verifier, attempt: 1 })
        const settled = await verifyAcceptancePlan(plan, this.verifiers, this.repository, workspace)
        const verdict: GoalState = settled.state === 'pass' ? 'success' : settled.state === 'fail' ? 'failure' : 'needs_human'
        const record: VerificationRecord = {
          schemaVersion: '0.1',
          goalId,
          runId,
          graphId: compiled.input.id,
          graphDigest: compiled.graphDigest,
          verifierId: plan.verifierId,
          verifierVersion: plan.verifierVersion,
          artifactId: plan.artifactId,
          snapshotId: plan.snapshot.snapshotId,
          ...(plan.gmDigest === undefined ? {} : { gmDigest: plan.gmDigest }),
          passed: settled.state === 'pass',
          observation: settled.observation,
          at: this.now().toISOString(),
        }
        const result: GoalResult = verdict === 'success'
          ? { state: 'success', verification: record }
          : verdict === 'failure'
            ? { state: 'failure', verification: record }
            : { state: 'needs_human', reason: 'verifier was inconclusive; evidence insufficient', verification: record }
        const phase = settled.state === 'pass' ? 'verifier_passed' : settled.state === 'fail' ? 'verifier_failed' : 'verifier_inconclusive'
        await this.repository.appendVerification(record)
        await appendRuntimeEvent(goalId, phase, {
          state: result.state,
          verifier,
          attempt: 1,
          ...(result.state === 'failure' ? { reason: 'trusted verifier rejected the immutable artifact snapshot' } : {}),
          ...(result.state === 'needs_human' ? { reason: 'verifier inconclusive' } : {}),
        })
        return result
      } catch (cause) {
        const error: GoalRuntimeError = {
          kind: 'verification_error',
          stage: 'verification',
          message: boundedMessage(messageOf(cause)),
        }
        await appendRuntimeEvent(goalId, 'structured_error', { state: 'needs_human', reason: error.kind })
        return { state: 'needs_human', reason: error.message }
      } finally {
        await this.workspaces.release(workspace)
      }
    }

    // ---- verify: ready-leaves parallel scheduling, then composite settlement.
    const pendingLeaves = new Set(leaves.filter(id => goals[id]?.state === 'pending'))
    const concurrency = Math.max(1, Math.floor(this.config.maxConcurrentVerifications))
    const inFlight = new Set<Promise<void>>()
    const drain = async (): Promise<void> => {
      await Promise.allSettled([...inFlight])
      inFlight.clear()
    }
    const pump = async (): Promise<void> => {
      // Ready = no unresolved dependency target.
      for (const goalId of [...pendingLeaves]) {
        const blockedDependency = (dependencies.get(goalId) ?? []).find(target => goals[target]?.state !== 'success')
        if (blockedDependency !== undefined) {
          const reason = `dependency ${blockedDependency} did not succeed`
          const state = dependencyNeedsHuman(goals[blockedDependency]) ? 'needs_human' : 'blocked'
          goals[goalId] = { state, reason }
          pendingLeaves.delete(goalId)
          await appendRuntimeEvent(goalId, 'dependency_blocked', { state, reason })
          continue
        }
        if (inFlight.size >= concurrency) break
        pendingLeaves.delete(goalId)
        const task = settleLeaf(goalId)
          .then(result => {
            goals[goalId] = result
            const settledAt = this.now().toISOString()
            return appendRuntimeEvent(goalId, 'goal_settled', {
              at: settledAt,
              state: result.state,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
              attempt: 1,
            })
          })
          .finally(() => { inFlight.delete(task) })
        inFlight.add(task)
      }
    }
    let aborted = false
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    do {
      await pump()
      if (inFlight.size > 0) await drain()
    } while (pendingLeaves.size > 0 && !aborted)

    // ---- composites settle in postorder after all leaves have settled.
    for (const goalId of postorder(compiled.input)) {
      const node = compiled.input.nodes[goalId]
      if (node === undefined || node.kind !== 'composite') continue
      const blockedDependency = (dependencies.get(goalId) ?? []).find(target => goals[target]?.state !== 'success')
      let result: GoalResult
      if (blockedDependency !== undefined) {
        const state = dependencyNeedsHuman(goals[blockedDependency]) ? 'needs_human' : 'blocked'
        result = { state, reason: `dependency ${blockedDependency} did not succeed` }
        await appendRuntimeEvent(goalId, 'dependency_blocked', { state, reason: result.reason ?? '' })
      } else {
        const startedAt = this.now().toISOString()
        goals[goalId] = { state: 'running' }
        result = evaluateComposite(goalId)
        await appendRuntimeEvent(goalId, 'composite_evaluated', {
          state: result.state,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        })
        await appendRuntimeEvent(goalId, 'goal_settled', {
          at: this.now().toISOString(),
          state: result.state,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        })
        void startedAt
      }
      goals[goalId] = result
      await saveProgress(this.now().toISOString())
    }

    const rootResult = goals[compiled.input.root]
    const rootState = terminalState(rootResult, this.config.allowPartialRoot)
    const updatedAt = this.now().toISOString()
    const revalidatedCount = leaves.filter(id => goals[id]?.state !== 'inherited').length
    if (leaves.length > 0 && revalidatedCount / leaves.length > this.config.revalidateThreshold) {
      run = {
        ...run,
        runtimeWarning: `this submission re-triggers ${revalidatedCount}/${leaves.length} leaves; `
          + 'exceeds revalidateThreshold — confirm unrelated parts were not changed',
      }
    }
    run = {
      ...run,
      state: 'completed',
      rootState,
      goals: { ...goals },
      gmDigests: { ...gmDigests },
      updatedAt,
    }
    await this.repository.saveRun(run)
    return deepFreeze(run)
  }

  async status(runId: string): Promise<DogRun> {
    return this.repository.loadRun(runId)
  }

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

/** SPEC §4 programmatic-subtree rule: every composite must have at least one non-programmatic descendant. */
function assertAgenticAtEveryComposite(graph: DogGraphInput, verifiers: VerifierContractRegistry): void {
  const isProgrammatic = (goalId: string, visiting: Set<string>): boolean => {
    const node = graph.nodes[goalId]
    if (node === undefined) return false
    if (node.kind === 'leaf') {
      if (node.verifier === undefined) return false
      return verifiers.isProgrammatic(node.verifier.id, node.verifier.version)
    }
    if (visiting.has(goalId)) return true
    visiting.add(goalId)
    const children = graph.contains.filter(edge => edge.parent === goalId).map(edge => edge.child)
    const all = children.length > 0 && children.every(child => isProgrammatic(child, visiting))
    visiting.delete(goalId)
    return all
  }
  for (const edge of graph.contains) {
    const parent = graph.nodes[edge.parent]
    if (parent === undefined || parent.kind !== 'composite') continue
    const siblings = graph.contains.filter(item => item.parent === edge.parent).map(item => item.child)
    const allProgrammatic = siblings.length > 0 && siblings.every(child => isProgrammatic(child, new Set()))
    if (allProgrammatic) {
      throw new Error(
        `composite ${edge.parent} has only programmatic descendants; this subtree is fully computable `
        + 'and belongs to the existing CI pipeline — move it out of DoG or gate on a CI-produced artifact binding '
        + 'beside an agentic sibling',
      )
    }
  }
}

function validateHostConfig(config: DogConfig): void {
  if (config.maxGraphNodes < 1 || !Number.isInteger(config.maxGraphNodes)) throw new Error('maxGraphNodes must be a positive integer')
  if (config.maxExpressionNodes < 1 || !Number.isInteger(config.maxExpressionNodes)) throw new Error('maxExpressionNodes must be a positive integer')
  if (config.maxExpressionDepth < 1 || !Number.isInteger(config.maxExpressionDepth)) throw new Error('maxExpressionDepth must be a positive integer')
  if (config.maxSnapshotBytes < 1 || !Number.isInteger(config.maxSnapshotBytes)) throw new Error('maxSnapshotBytes must be a positive integer')
  if (config.maxConcurrentVerifications < 1 || !Number.isInteger(config.maxConcurrentVerifications)) {
    throw new Error('maxConcurrentVerifications must be a positive integer')
  }
  if (config.revalidateThreshold < 0 || config.revalidateThreshold > 1 || !Number.isFinite(config.revalidateThreshold)) {
    throw new Error('revalidateThreshold must be a ratio in [0, 1]')
  }
  if (config.gmDigestAlgo.length === 0) throw new Error('gmDigestAlgo must not be empty')
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
  }
}

function assertUniqueIds<T extends { readonly id: string }>(items: readonly T[], label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`duplicate ${label} id ${item.id}`)
    seen.add(item.id)
  }
}

function requireContextId(value: string, label: string): string {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} must contain 1-512 characters`)
  return value
}

function requireArtifactId(params: Record<string, JsonValue>, goalId: string): string {
  const artifactId = params.artifactId
  if (typeof artifactId !== 'string' || artifactId.length === 0) throw new Error(`goal ${goalId} verifier did not bind an artifactId`)
  return artifactId
}

function graphWarnings(graph: DogGraphInput): string[] {
  const warnings: string[] = []
  for (const [goalId, node] of Object.entries(graph.nodes)) {
    if (goalId === graph.root) continue
    if (node.constraint === 'soft') warnings.push(`goal ${goalId} is soft; v0.2 records this but has no soft-score model`)
  }
  return warnings
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedMessage(message: string): string {
  return message.length > 512 ? message.slice(0, 512) : message
}

function postorder(input: DogGraphInput): string[] {
  const children = new Map<string, string[]>()
  for (const edge of input.contains) {
    const list = children.get(edge.parent) ?? []
    list.push(edge.child)
    children.set(edge.parent, list)
  }
  const visited = new Set<string>()
  const order: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    visited.add(id)
    for (const child of children.get(id) ?? []) visit(child)
    order.push(id)
  }
  visit(input.root)
  return order
}

function dependenciesBySource(input: DogGraphInput): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of input.dependsOn) {
    const list = map.get(edge.source) ?? []
    list.push(edge.target)
    map.set(edge.source, list)
  }
  return map
}

function childrenByParent(input: DogGraphInput): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of input.contains) {
    const list = map.get(edge.parent) ?? []
    list.push(edge.child)
    map.set(edge.parent, list)
  }
  return map
}

function relationsByParent(input: DogGraphInput): Map<string, ContainsEdge[]> {
  const map = new Map<string, ContainsEdge[]>()
  for (const edge of input.contains) {
    const list = map.get(edge.parent) ?? []
    list.push(edge)
    map.set(edge.parent, list)
  }
  return map
}

function relationTruth(edge: { readonly child: string; readonly failure?: string; readonly degradeTo?: string }, goals: Record<string, GoalResult>): boolean | undefined {
  const state = goals[edge.child]?.state
  if (state === 'success' || state === 'inherited' || state === 'partial') return true
  if (state === 'failure' || state === 'blocked') {
    if (edge.failure === 'degrade' && edge.degradeTo !== undefined) {
      const substitute = goals[edge.degradeTo]?.state
      if (substitute === 'success' || substitute === 'inherited') return true
      if (substitute === 'needs_human' || substitute === 'invalidated') return undefined
    }
    return false
  }
  return undefined
}

function relationTruthValues(edges: readonly { readonly child: string; readonly failure?: string; readonly degradeTo?: string }[], goals: Record<string, GoalResult>): Map<string, boolean | undefined> {
  const values = new Map<string, boolean | undefined>()
  for (const edge of edges) values.set(edge.child, relationTruth(edge, goals))
  return values
}

function relationNeedsHuman(edge: { readonly child: string; readonly failure?: string; readonly degradeTo?: string }, goals: Record<string, GoalResult>): boolean {
  const childState = goals[edge.child]?.state
  if (childState === 'needs_human' || childState === 'invalidated') return true
  if (edge.failure === 'degrade' && edge.degradeTo !== undefined) {
    const substitute = goals[edge.degradeTo]?.state
    return substitute === 'needs_human' || substitute === 'invalidated'
  }
  return false
}

function dependencyNeedsHuman(result: GoalResult | undefined): boolean {
  return result?.state === 'needs_human' || result?.state === 'invalidated'
}

function terminalState(rootResult: GoalResult | undefined, allowPartialRoot: boolean): RootTerminalState {
  if (rootResult?.state === 'success' || rootResult?.state === 'inherited') return 'success'
  if (rootResult?.state === 'partial' && allowPartialRoot) return 'partial_success'
  if (rootResult?.state === 'needs_human') return 'needs_replan'
  return 'failure'
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/u).some(segment => segment === '..' || segment === '.')
}
