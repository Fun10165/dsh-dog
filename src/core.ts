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

  /** Run every trusted verifier and recompute all parents in dependency-safe postorder. */
  async run(graphId: string): Promise<DogRun> {
    const compiled = await this.repository.loadGraph(graphId)
    const runId = this.nextRunId()
    const createdAt = this.now().toISOString()
    const goals: Record<string, GoalResult> = Object.fromEntries(
      Object.keys(compiled.input.nodes).map(id => [id, { state: 'pending' as const }]),
    )
    let run: DogRun = {
      runId,
      graphId: compiled.input.id,
      graphDigest: compiled.graphDigest,
      state: 'running',
      goals,
      createdAt,
      updatedAt: createdAt,
    }
    await this.repository.saveRun(run)

    const dependencies = dependenciesBySource(compiled.input)
    const children = childrenByParent(compiled.input)
    const relations = relationsByParent(compiled.input)
    for (const goalId of postorder(compiled.input)) {
      const node = compiled.input.nodes[goalId]
      if (node === undefined) continue
      const blockedDependency = (dependencies.get(goalId) ?? []).find(target => goals[target]?.state !== 'success')
      if (blockedDependency !== undefined) {
        goals[goalId] = {
          state: dependencyNeedsHuman(goals[blockedDependency]) ? 'needs_human' : 'blocked',
          reason: `dependency ${blockedDependency} did not succeed`,
        }
        continue
      }
      if (node.kind === 'leaf') {
        const plan = compiled.acceptancePlans[goalId]
        if (plan === undefined) {
          goals[goalId] = { state: 'needs_human', reason: 'compiled acceptance plan is missing' }
          continue
        }
        try {
          const result = await verifyAcceptancePlan(plan, this.verifiers, this.repository)
          const record: VerificationRecord = {
            goalId,
            runId,
            graphDigest: compiled.graphDigest,
            verifierId: plan.verifierId,
            verifierVersion: plan.verifierVersion,
            artifactId: plan.artifactId,
            snapshotId: plan.snapshot.snapshotId,
            passed: result.passed,
            observation: result.observation,
            verifiedAt: this.now().toISOString(),
          }
          await this.repository.appendVerification(record)
          goals[goalId] = { state: result.passed ? 'success' : 'failure', verification: record }
        } catch (error) {
          goals[goalId] = { state: 'needs_human', reason: messageOf(error) }
        }
        continue
      }

      const parentRelations = relations.get(goalId) ?? []
      const childIds = children.get(goalId) ?? []
      const values = relationTruthValues(parentRelations, goals)
      if (node.completion === undefined) {
        goals[goalId] = { state: 'needs_human', reason: 'validated composite lost its completion expression' }
        continue
      }
      const requiredFailures = parentRelations.filter(edge => edge.required && relationTruth(edge, goals) === false)
      const fatalRequiredFailure = requiredFailures.find(edge => edge.failure === 'fatal')
      const requiredUnknown = parentRelations.find(edge => edge.required && relationTruth(edge, goals) === undefined)
      if (fatalRequiredFailure !== undefined) {
        goals[goalId] = { state: 'failure', reason: `required non-tolerable child ${fatalRequiredFailure.child} failed` }
        continue
      }
      if (requiredUnknown !== undefined) {
        goals[goalId] = relationNeedsHuman(requiredUnknown, goals)
          ? { state: 'needs_human', reason: `required child relation ${requiredUnknown.child} requires human review` }
          : { state: 'blocked', reason: `required child ${requiredUnknown.child} is unresolved` }
        continue
      }
      if (requiredFailures.length > 0) {
        goals[goalId] = { state: 'partial', reason: `required child ${requiredFailures[0]?.child ?? 'unknown'} failed under a tolerable policy` }
        continue
      }
      const completion = evaluateBoolExpr(node.completion, values)
      if (completion === true) {
        goals[goalId] = { state: 'success' }
        continue
      }
      if (completion === 'unknown') {
        const humanChild = childIds.find(childId => dependencyNeedsHuman(goals[childId]))
        goals[goalId] = humanChild === undefined
          ? { state: 'blocked', reason: 'one or more child outcomes are unresolved' }
          : { state: 'needs_human', reason: `child ${humanChild} requires human review` }
        continue
      }
      const failedRelations = parentRelations.filter(edge => relationTruth(edge, goals) === false)
      const fatal = failedRelations.find(edge => edge.failure === 'fatal')
      goals[goalId] = fatal === undefined
        ? { state: 'partial', reason: 'completion rule is false, but every failed child relation is tolerable or optional' }
        : { state: 'failure', reason: `non-tolerable child ${fatal.child} failed` }
    }

    const rootResult = goals[compiled.input.root]
    const rootState = terminalState(rootResult, this.config.allowPartialRoot)
    const updatedAt = this.now().toISOString()
    run = {
      ...run,
      state: 'completed',
      rootState,
      goals,
      updatedAt,
    }
    await this.repository.saveRun(run)
    return deepFreeze(run)
  }

  /** Load a persisted run for status reporting. */
  async status(runId: string): Promise<DogRun> {
    return this.repository.loadRun(runId)
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
