/**
 * DDoG lifecycle: the only place that turns judgments into state changes.
 *
 * Every function here is pure. The thresholds default to the omp-dog constants;
 * a host may override them through configuration.
 */

import type {
  CandidateState,
  DdogGraph,
  DdogNode,
  DdogVerdict,
  Observation,
  RetirementState,
} from './ddog-model.ts'
import { withNode } from './ddog-model.ts'

/** Lifecycle constants. Defaults are the omp-dog values. */
export interface DdogThresholds {
  /** A candidate promotes once its decisive failures exceed this count. */
  readonly promotionFailures: number
  /** ...and its failure rate exceeds this fraction. */
  readonly promotionFailureRate: number
  /** A formal node starts retirement evaluation above this pass rate. */
  readonly retirementSuccessRate: number
  /** It retires once parent/child consistency exceeds this value. */
  readonly retirementConsistency: number
  /** Minimum paired decisive judgments before retirement can be settled. */
  readonly retirementMinRuns: number
}

export const DEFAULT_DDOG_THRESHOLDS: DdogThresholds = {
  promotionFailures: 2,
  promotionFailureRate: 0.2,
  retirementSuccessRate: 0.9,
  retirementConsistency: 0.8,
  retirementMinRuns: 5,
}

export interface VerdictStats {
  readonly total: number
  readonly pass: number
  readonly fail: number
  /** fail / total; zero when there is nothing decisive to divide. */
  readonly failureRate: number
}

/** Decisive statistics: inconclusive judgments never move a node. */
export function verdictStats(observations: readonly Observation[]): VerdictStats {
  let pass = 0
  let fail = 0
  for (const observation of observations) {
    if (observation.verdict === 'pass') pass += 1
    else if (observation.verdict === 'fail') fail += 1
  }
  const total = pass + fail
  return { total, pass, fail, failureRate: total === 0 ? 0 : fail / total }
}

/** Promotion needs more than the failure count AND a rate above the fraction. */
export function shouldPromote(
  observations: readonly Observation[],
  thresholds: DdogThresholds = DEFAULT_DDOG_THRESHOLDS,
): boolean {
  const stats = verdictStats(observations)
  return stats.fail > thresholds.promotionFailures && stats.failureRate > thresholds.promotionFailureRate
}

/** Retirement evaluation starts on a formal node that keeps passing. */
export function shouldStartRetirement(
  node: DdogNode,
  thresholds: DdogThresholds = DEFAULT_DDOG_THRESHOLDS,
): boolean {
  if (node.kind !== 'formal') return false
  if (node.formal?.retirement !== undefined) return false
  const stats = verdictStats(node.formal?.observations ?? [])
  return stats.total > 0 && stats.pass / stats.total > thresholds.retirementSuccessRate
}

/**
 * Record one judgment against a node and apply the transitions it triggers.
 *
 * Root has no judgment record of its own: the root's per-run verdict is an
 * output of the run, not state that the lifecycle can move.
 *
 * @param node - current node.
 * @param observation - judgment produced by the parent's session.
 * @param thresholds - lifecycle constants.
 * @returns the node after the observation and any promotion.
 */
export function applyObservation(
  node: DdogNode,
  observation: Observation,
  thresholds: DdogThresholds = DEFAULT_DDOG_THRESHOLDS,
): DdogNode {
  if (node.kind === 'root') throw new Error(`applyObservation: the root has no judgment record (${node.id})`)
  if (node.kind === 'candidate') {
    const candidate = node.candidate
    if (candidate === undefined) throw new Error(`applyObservation: candidate ${node.id} has no candidate state`)
    const observations = [...candidate.observations, observation]
    if (!shouldPromote(observations, thresholds)) {
      return { ...node, candidate: { ...candidate, observations } }
    }
    const { candidate: _promoted, ...rest } = node
    return {
      ...rest,
      kind: 'formal',
      formal: {
        observations,
        ...(candidate.exampleIndex === undefined ? {} : { exampleIndex: candidate.exampleIndex }),
        ...(candidate.trigger === undefined ? {} : { trigger: candidate.trigger }),
      },
    }
  }
  const formal = node.formal
  if (formal === undefined) throw new Error(`applyObservation: ${node.kind} node ${node.id} has no formal state`)
  const observations = [...formal.observations, observation]
  const next: DdogNode = { ...node, formal: { ...formal, observations } }
  if (node.kind === 'formal' && shouldStartRetirement(next, thresholds)) {
    return {
      ...next,
      formal: { ...next.formal!, retirement: { startedAt: observation.at, jointVerdicts: [] } },
    }
  }
  return next
}

/**
 * Cross-entropy agreement between a parent's pass rate and the paired child verdicts.
 *
 * Fewer than `minRuns` decisive pairs cannot settle retirement and yield undefined.
 */
export function retirementConsistency(
  parentVerdicts: readonly DdogVerdict[],
  jointVerdicts: readonly DdogVerdict[],
  minRuns: number,
): number | undefined {
  const pairs: { readonly parent: DdogVerdict; readonly child: DdogVerdict }[] = []
  const length = Math.min(parentVerdicts.length, jointVerdicts.length)
  for (let index = 0; index < length; index += 1) {
    const parent = parentVerdicts[index]!
    const child = jointVerdicts[index]!
    if (parent === 'inconclusive' || child === 'inconclusive') continue
    pairs.push({ parent, child })
  }
  if (pairs.length < minRuns) return undefined
  const parentRate = Math.min(1 - 1e-9, Math.max(1e-9, pairs.filter(pair => pair.parent === 'pass').length / pairs.length))
  const childRate = Math.min(1 - 1e-9, Math.max(1e-9, pairs.filter(pair => pair.child === 'pass').length / pairs.length))
  const entropy = -(childRate * Math.log2(parentRate) + (1 - childRate) * Math.log2(1 - parentRate))
  return Math.min(1, Math.max(0, 1 - entropy))
}

/**
 * Settle a retirement round from the parent's verdicts on the child's past failures.
 *
 * The child side is the historical failures themselves, so the agreement is high
 * exactly when the parent also fails the cases its child failed.
 *
 * @throws when evaluation never started or there are too few decisive pairs.
 */
export function applyRetirement(
  node: DdogNode,
  parentVerdicts: readonly DdogVerdict[],
  thresholds: DdogThresholds = DEFAULT_DDOG_THRESHOLDS,
  now?: string,
): DdogNode {
  const formal = node.formal
  if (node.kind !== 'formal' || formal?.retirement === undefined) {
    throw new Error(`applyRetirement: ${node.id} is not under retirement evaluation`)
  }
  const consistency = retirementConsistency(
    parentVerdicts,
    parentVerdicts.map(() => 'fail' as const),
    thresholds.retirementMinRuns,
  )
  if (consistency === undefined) {
    throw new Error(`applyRetirement: ${node.id} needs at least ${String(thresholds.retirementMinRuns)} paired verdicts`)
  }
  const retirement: RetirementState = { ...formal.retirement, jointVerdicts: parentVerdicts, consistency }
  if (consistency <= thresholds.retirementConsistency) {
    return { ...node, formal: { ...formal, retirement } }
  }
  return {
    ...node,
    kind: 'retired',
    formal: { ...formal, retirement: { ...retirement, ...(now === undefined ? {} : { retiredAt: now }) } },
  }
}

/** Past failure cases a parent must re-judge while a child is being retired. */
export function retirementCases(
  node: DdogNode,
  thresholds: DdogThresholds = DEFAULT_DDOG_THRESHOLDS,
): readonly Observation[] {
  const formal = node.formal
  if (formal === undefined) return []
  const evaluating = formal.retirement !== undefined || shouldStartRetirement(node, thresholds)
  if (!evaluating) return []
  const failures = formal.observations.filter(observation => observation.verdict === 'fail')
  return failures.length >= thresholds.retirementMinRuns ? failures : []
}

/** One failure mode the parent found that no existing child covers. */
export interface NewCandidateSubmission {
  readonly definition: string
  readonly evidence: string
}

/** Candidate state for a failure observed during a run. */
export function productionCandidate(options: {
  readonly definition: string
  readonly evidence: string
  readonly runId: string
  readonly at: string
}): CandidateState {
  return {
    source: 'production',
    failureDescription: options.evidence,
    trigger: options.evidence,
    observations: [{ runId: options.runId, at: options.at, verdict: 'fail', evidence: options.evidence }],
  }
}

/**
 * Append candidates discovered during a run under one parent.
 *
 * @throws when a submitted definition already exists anywhere in the graph.
 */
export function appendNewCandidates(
  graph: DdogGraph,
  parentId: string,
  submissions: readonly NewCandidateSubmission[],
  runId: string,
  now: string,
): DdogGraph {
  const parent = graph.nodes[parentId]
  if (parent === undefined) throw new Error(`appendNewCandidates: no parent ${parentId}`)
  const existing = new Set(
    Object.values(graph.nodes).map(node => node.definition.replace(/\s+/gu, ' ').trim()),
  )
  let next = graph
  let counter = Object.values(graph.nodes).filter(node => node.kind === 'candidate').length
  for (const submission of submissions) {
    const definition = submission.definition.trim()
    const key = definition.replace(/\s+/gu, ' ').trim()
    if (existing.has(key)) throw new Error(`appendNewCandidates: definition already exists: ${definition}`)
    existing.add(key)
    counter += 1
    let id = `candidate-${String(counter)}`
    while (next.nodes[id] !== undefined) {
      counter += 1
      id = `candidate-${String(counter)}`
    }
    const node: DdogNode = {
      id,
      definition,
      kind: 'candidate',
      parentId,
      level: parent.level + 1,
      createdAt: now,
      candidate: productionCandidate({ definition, evidence: submission.evidence, runId, at: now }),
    }
    next = withNode(next, node, now)
  }
  return next
}
