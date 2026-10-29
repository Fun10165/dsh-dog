/** DDoG v0.1 model: a project-scoped tree whose nodes move between candidate, formal, and retired. */

import { DogValidationError } from './graph.ts'

export const DDOG_SCHEMA_VERSION = '0.1' as const

export type DdogVerdict = 'pass' | 'fail' | 'inconclusive'
/** Where the failure that produced a candidate was observed. */
export type FailureSource = 'production' | 'simulation'
export type DdogNodeKind = 'root' | 'formal' | 'candidate' | 'retired'

/** One recorded judgment of a node. `runId` groups the judgments of a single review pass. */
export interface Observation {
  readonly runId: string
  readonly at: string
  readonly verdict: DdogVerdict
  readonly evidence?: string
}

/** Why a node exists and what has been observed while it was still a candidate. */
export interface CandidateState {
  readonly source: FailureSource
  readonly failureDescription: string
  /** 1-based index of the non-empty example line that triggered this candidate. */
  readonly exampleIndex?: number
  /** Excerpt copied from that example line. */
  readonly trigger?: string
  readonly observations: readonly Observation[]
}

/** One conjunct of the root definition and the candidates whose paths cover it. */
export interface RootSlot {
  readonly slot: string
  readonly candidates: readonly string[]
}

/** Retirement bookkeeping: parent judgments paired against past failure cases. */
export interface RetirementState {
  readonly startedAt: string
  readonly jointVerdicts: readonly DdogVerdict[]
  readonly consistency?: number
  readonly retiredAt?: string
}

/** A node that passed promotion, plus its retirement record once evaluation starts. */
export interface FormalState {
  readonly observations: readonly Observation[]
  readonly exampleIndex?: number
  readonly trigger?: string
  readonly retirement?: RetirementState
}

export interface DdogNode {
  readonly id: string
  readonly definition: string
  readonly kind: DdogNodeKind
  readonly parentId: string | null
  /** Root is 0; every other node is its parent's level plus one. */
  readonly level: number
  readonly createdAt: string
  readonly candidate?: CandidateState
  readonly formal?: FormalState
}

/** The user instruction the graph was built from. */
export interface DdogInput {
  readonly file?: string
  readonly text: string
}

export interface DdogGraph {
  readonly schemaVersion: typeof DDOG_SCHEMA_VERSION
  readonly id: string
  readonly root: string
  readonly input: DdogInput
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: Record<string, DdogNode>
  readonly rootSlots?: readonly RootSlot[]
}

const NODE_KINDS: readonly DdogNodeKind[] = ['root', 'formal', 'candidate', 'retired']
const VERDICTS: readonly DdogVerdict[] = ['pass', 'fail', 'inconclusive']

/**
 * Parse an untrusted DDoG graph, enforcing the invariants the lifecycle relies on.
 * @param value - decoded JSON.
 * @returns the validated graph.
 * @throws DogValidationError listing every violation.
 */
export function parseDdogGraph(value: unknown): DdogGraph {
  const errors: string[] = []
  const root = asRecord(value, '$', errors)
  if (root === undefined) throw new DogValidationError(errors)
  checkExactKeys(root, ['schemaVersion', 'id', 'root', 'input', 'createdAt', 'updatedAt', 'nodes', 'rootSlots'], '$', errors)
  if (root.schemaVersion !== DDOG_SCHEMA_VERSION) errors.push(`$.schemaVersion: expected ${DDOG_SCHEMA_VERSION}`)
  const id = asString(root.id, '$.id', errors)
  const rootId = asString(root.root, '$.root', errors)
  const input = parseInput(root.input, '$.input', errors)
  const createdAt = asString(root.createdAt, '$.createdAt', errors)
  const updatedAt = asString(root.updatedAt, '$.updatedAt', errors)
  const nodes = parseNodes(root.nodes, errors)
  const rootSlots = parseRootSlots(root.rootSlots, errors)
  if (nodes !== undefined && rootId !== undefined) validateTree(rootId, nodes, errors)
  if (id === undefined || rootId === undefined || input === undefined || createdAt === undefined
    || updatedAt === undefined || nodes === undefined || errors.length > 0) {
    throw new DogValidationError(errors)
  }
  return {
    schemaVersion: DDOG_SCHEMA_VERSION,
    id,
    root: rootId,
    input,
    createdAt,
    updatedAt,
    nodes,
    ...(rootSlots === undefined ? {} : { rootSlots }),
  }
}

/** Create the single-node graph produced by `ddog_init`. */
export function createRootGraph(options: {
  readonly definition: string
  readonly input: DdogInput
  readonly now: string
  readonly id?: string
}): DdogGraph {
  const id = options.id ?? 'ddog'
  const rootNode: DdogNode = {
    id: 'root',
    definition: options.definition,
    kind: 'root',
    parentId: null,
    level: 0,
    createdAt: options.now,
  }
  return {
    schemaVersion: DDOG_SCHEMA_VERSION,
    id,
    root: 'root',
    input: options.input,
    createdAt: options.now,
    updatedAt: options.now,
    nodes: { root: rootNode },
  }
}

/** Child ids of one node in insertion order. */
export function childrenOf(graph: DdogGraph, parentId: string): readonly DdogNode[] {
  return Object.values(graph.nodes).filter(node => node.parentId === parentId)
}

/** Candidate and retired children, the set a parent judges in its own session. */
export function jointChildrenOf(graph: DdogGraph, parentId: string): readonly DdogNode[] {
  return childrenOf(graph, parentId).filter(node => node.kind === 'candidate' || node.kind === 'retired')
}

/** Formal children are judged by their own sessions; the parent only checks coverage. */
export function formalChildrenOf(graph: DdogGraph, parentId: string): readonly DdogNode[] {
  return childrenOf(graph, parentId).filter(node => node.kind === 'formal')
}

/** Replace one node immutably. */
export function withNode(graph: DdogGraph, node: DdogNode, updatedAt: string): DdogGraph {
  return { ...graph, updatedAt, nodes: { ...graph.nodes, [node.id]: node } }
}

function parseInput(value: unknown, path: string, errors: string[]): DdogInput | undefined {
  const record = asRecord(value, path, errors)
  if (record === undefined) return undefined
  checkExactKeys(record, ['file', 'text'], path, errors)
  const text = asString(record.text, `${path}.text`, errors)
  const file = record.file === undefined ? undefined : asString(record.file, `${path}.file`, errors)
  if (text === undefined) return undefined
  return { ...(file === undefined ? {} : { file }), text }
}

function parseNodes(value: unknown, errors: string[]): Record<string, DdogNode> | undefined {
  const record = asRecord(value, '$.nodes', errors)
  if (record === undefined) return undefined
  const nodes: Record<string, DdogNode> = {}
  for (const [nodeId, raw] of Object.entries(record)) {
    const node = parseNode(raw, `$.nodes.${nodeId}`, errors)
    if (node === undefined) continue
    if (node.id !== nodeId) errors.push(`$.nodes.${nodeId}.id: expected ${nodeId}`)
    nodes[nodeId] = node
  }
  return nodes
}

function parseNode(value: unknown, path: string, errors: string[]): DdogNode | undefined {
  const record = asRecord(value, path, errors)
  if (record === undefined) return undefined
  checkExactKeys(record, ['id', 'definition', 'kind', 'parentId', 'level', 'createdAt', 'candidate', 'formal'], path, errors)
  const id = asString(record.id, `${path}.id`, errors)
  const definition = asString(record.definition, `${path}.definition`, errors)
  const kind = NODE_KINDS.includes(record.kind as DdogNodeKind) ? (record.kind as DdogNodeKind) : undefined
  if (kind === undefined) errors.push(`${path}.kind: expected one of ${NODE_KINDS.join(', ')}`)
  const parentId = record.parentId === null ? null : asString(record.parentId, `${path}.parentId`, errors)
  const level = asNatural(record.level, `${path}.level`, errors)
  const createdAt = asString(record.createdAt, `${path}.createdAt`, errors)
  const candidate = record.candidate === undefined ? undefined : parseCandidate(record.candidate, `${path}.candidate`, errors)
  const formal = record.formal === undefined ? undefined : parseFormal(record.formal, `${path}.formal`, errors)
  if (id === undefined || definition === undefined || kind === undefined || parentId === undefined
    || level === undefined || createdAt === undefined) return undefined
  if (kind === 'candidate' && candidate === undefined) errors.push(`${path}.candidate: required for a candidate node`)
  if ((kind === 'formal' || kind === 'retired') && formal === undefined) errors.push(`${path}.formal: required for a ${kind} node`)
  if (kind === 'root' && (parentId !== null || level !== 0)) errors.push(`${path}: root must have parentId null and level 0`)
  if (kind !== 'root' && parentId === null) errors.push(`${path}.parentId: required for a ${kind} node`)
  return {
    id,
    definition,
    kind,
    parentId,
    level,
    createdAt,
    ...(candidate === undefined ? {} : { candidate }),
    ...(formal === undefined ? {} : { formal }),
  }
}

function parseCandidate(value: unknown, path: string, errors: string[]): CandidateState | undefined {
  const record = asRecord(value, path, errors)
  if (record === undefined) return undefined
  checkExactKeys(record, ['source', 'failureDescription', 'exampleIndex', 'trigger', 'observations'], path, errors)
  const source = record.source === 'production' || record.source === 'simulation' ? record.source : undefined
  if (source === undefined) errors.push(`${path}.source: expected production or simulation`)
  const failureDescription = asString(record.failureDescription, `${path}.failureDescription`, errors)
  const exampleIndex = record.exampleIndex === undefined ? undefined : asNatural(record.exampleIndex, `${path}.exampleIndex`, errors)
  const trigger = record.trigger === undefined ? undefined : asString(record.trigger, `${path}.trigger`, errors)
  const observations = parseObservations(record.observations, `${path}.observations`, errors)
  if (source === undefined || failureDescription === undefined || observations === undefined) return undefined
  return {
    source,
    failureDescription,
    ...(exampleIndex === undefined ? {} : { exampleIndex }),
    ...(trigger === undefined ? {} : { trigger }),
    observations,
  }
}

function parseFormal(value: unknown, path: string, errors: string[]): FormalState | undefined {
  const record = asRecord(value, path, errors)
  if (record === undefined) return undefined
  checkExactKeys(record, ['observations', 'exampleIndex', 'trigger', 'retirement'], path, errors)
  const observations = parseObservations(record.observations, `${path}.observations`, errors)
  const exampleIndex = record.exampleIndex === undefined ? undefined : asNatural(record.exampleIndex, `${path}.exampleIndex`, errors)
  const trigger = record.trigger === undefined ? undefined : asString(record.trigger, `${path}.trigger`, errors)
  const retirement = record.retirement === undefined ? undefined : parseRetirement(record.retirement, `${path}.retirement`, errors)
  if (observations === undefined) return undefined
  return {
    observations,
    ...(exampleIndex === undefined ? {} : { exampleIndex }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(retirement === undefined ? {} : { retirement }),
  }
}

function parseRetirement(value: unknown, path: string, errors: string[]): RetirementState | undefined {
  const record = asRecord(value, path, errors)
  if (record === undefined) return undefined
  checkExactKeys(record, ['startedAt', 'jointVerdicts', 'consistency', 'retiredAt'], path, errors)
  const startedAt = asString(record.startedAt, `${path}.startedAt`, errors)
  const jointVerdicts = parseVerdicts(record.jointVerdicts, `${path}.jointVerdicts`, errors)
  const consistency = record.consistency === undefined ? undefined : asUnitInterval(record.consistency, `${path}.consistency`, errors)
  const retiredAt = record.retiredAt === undefined ? undefined : asString(record.retiredAt, `${path}.retiredAt`, errors)
  if (startedAt === undefined || jointVerdicts === undefined) return undefined
  return {
    startedAt,
    jointVerdicts,
    ...(consistency === undefined ? {} : { consistency }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
  }
}

function parseObservations(value: unknown, path: string, errors: string[]): readonly Observation[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array`)
    return undefined
  }
  const result: Observation[] = []
  for (const [index, raw] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const record = asRecord(raw, itemPath, errors)
    if (record === undefined) continue
    checkExactKeys(record, ['runId', 'at', 'verdict', 'evidence'], itemPath, errors)
    const runId = asString(record.runId, `${itemPath}.runId`, errors)
    const at = asString(record.at, `${itemPath}.at`, errors)
    const verdict = VERDICTS.includes(record.verdict as DdogVerdict) ? (record.verdict as DdogVerdict) : undefined
    if (verdict === undefined) errors.push(`${itemPath}.verdict: expected pass, fail, or inconclusive`)
    const evidence = record.evidence === undefined ? undefined : asString(record.evidence, `${itemPath}.evidence`, errors)
    if (runId === undefined || at === undefined || verdict === undefined) continue
    result.push({ runId, at, verdict, ...(evidence === undefined ? {} : { evidence }) })
  }
  return result
}

function parseVerdicts(value: unknown, path: string, errors: string[]): readonly DdogVerdict[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array`)
    return undefined
  }
  const result: DdogVerdict[] = []
  for (const [index, raw] of value.entries()) {
    if (!VERDICTS.includes(raw as DdogVerdict)) {
      errors.push(`${path}[${index}]: expected pass, fail, or inconclusive`)
      continue
    }
    result.push(raw as DdogVerdict)
  }
  return result
}

function parseRootSlots(value: unknown, errors: string[]): readonly RootSlot[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    errors.push('$.rootSlots: expected an array')
    return undefined
  }
  const result: RootSlot[] = []
  for (const [index, raw] of value.entries()) {
    const path = `$.rootSlots[${index}]`
    const record = asRecord(raw, path, errors)
    if (record === undefined) continue
    checkExactKeys(record, ['slot', 'candidates'], path, errors)
    const slot = asString(record.slot, `${path}.slot`, errors)
    const candidates = record.candidates
    if (!Array.isArray(candidates) || candidates.some(item => typeof item !== 'string')) {
      errors.push(`${path}.candidates: expected an array of node ids`)
      continue
    }
    if (slot === undefined) continue
    result.push({ slot, candidates: candidates as string[] })
  }
  return result
}

function validateTree(rootId: string, nodes: Record<string, DdogNode>, errors: string[]): void {
  const root = nodes[rootId]
  if (root === undefined) {
    errors.push(`$.root: ${rootId} is not a node`)
    return
  }
  if (root.kind !== 'root') errors.push(`$.nodes.${rootId}: the declared root must have kind root`)
  for (const node of Object.values(nodes)) {
    if (node.id === rootId) continue
    if (node.parentId === null) {
      errors.push(`$.nodes.${node.id}.parentId: only the root may be parentless`)
      continue
    }
    const parent = nodes[node.parentId]
    if (parent === undefined) {
      errors.push(`$.nodes.${node.id}.parentId: ${node.parentId} is not a node`)
      continue
    }
    if (node.level !== parent.level + 1) errors.push(`$.nodes.${node.id}.level: expected ${parent.level + 1}`)
    // Every node must reach the declared root; a cycle would otherwise loop forever.
    const seen = new Set<string>([node.id])
    let cursor: DdogNode | undefined = parent
    while (cursor !== undefined && cursor.id !== rootId) {
      if (seen.has(cursor.id)) {
        errors.push(`$.nodes.${node.id}.parentId: parent chain contains a cycle`)
        break
      }
      seen.add(cursor.id)
      cursor = cursor.parentId === null ? undefined : nodes[cursor.parentId]
    }
    if (cursor === undefined) errors.push(`$.nodes.${node.id}.parentId: parent chain does not reach ${rootId}`)
  }
}

function asRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path}: expected an object`)
    return undefined
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path}: expected a non-empty string`)
    return undefined
  }
  return value
}

function asNatural(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${path}: expected a non-negative integer`)
    return undefined
  }
  return value
}

function asUnitInterval(value: unknown, path: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path}: expected a number in [0, 1]`)
    return undefined
  }
  return value
}

function checkExactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unexpected field`)
  }
}
