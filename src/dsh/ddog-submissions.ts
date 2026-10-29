/** Strict parsers for the JSON a DDoG session writes back. */

import { isOneSentence } from '../core/ddog-definition.ts'
import type { DdogNode, DdogVerdict, RootSlot } from '../core/ddog-model.ts'
import type { NewCandidateSubmission } from '../core/ddog-lifecycle.ts'

export class DdogSubmissionError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`invalid ddog submission: ${problems.join('; ')}`)
    this.name = 'DdogSubmissionError'
    this.problems = problems
  }
}

const VERDICTS: readonly DdogVerdict[] = ['pass', 'fail', 'inconclusive']

export interface InitSubmission {
  readonly definition: string
  readonly rationale: string
}

/** Parse the root-definition submission. */
export function parseInitSubmission(value: unknown): InitSubmission {
  const record = asRecord(value, 'submission', [])
  const problems: string[] = []
  const definition = typeof record.definition === 'string' ? record.definition.trim() : ''
  if (definition.length === 0) problems.push('definition must be a non-empty string')
  const rationale = record.rationale === undefined
    ? ''
    : typeof record.rationale === 'string' ? record.rationale : ''
  if (problems.length > 0) throw new DdogSubmissionError(problems)
  return { definition, rationale }
}

export interface ExpansionCandidateDraft {
  readonly key: string
  readonly definition: string
  readonly parent: string
  readonly level: number
  readonly exampleIndex?: number
  readonly trigger?: string
  readonly rationale: string
}

export interface ExpansionSubmission {
  readonly candidates: readonly ExpansionCandidateDraft[]
  readonly rootSlots?: readonly RootSlot[]
}

export interface ExpansionContext {
  readonly parent: DdogNode
  readonly existingIds: readonly string[]
  readonly existingDefinitions: readonly string[]
  /** The numbered example lines; trigger must be a substring of the cited line. */
  readonly examples: readonly string[]
}

/**
 * Parse and validate an expansion submission into tree order.
 *
 * @returns candidates (parent before child) and, under the root, slot coverage.
 * @throws DdogSubmissionError listing every problem.
 */
export function parseExpansionSubmission(value: unknown, context: ExpansionContext): ExpansionSubmission {
  const record = asRecord(value, 'submission', [])
  const problems: string[] = []
  const rawCandidates = record.candidates
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new DdogSubmissionError(['candidates must be a non-empty array'])
  }
  const drafts: ExpansionCandidateDraft[] = []
  const keys = new Set<string>()
  const definitions = new Set(context.existingDefinitions.map(definition => definition.replace(/\s+/gu, ' ').trim()))
  for (const [index, raw] of rawCandidates.entries()) {
    const path = `candidates[${String(index)}]`
    const item = asRecord(raw, path, problems)
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const definition = typeof item.definition === 'string' ? item.definition.trim() : ''
    const parent = typeof item.parent === 'string' ? item.parent.trim() : ''
    const level = typeof item.level === 'number' && Number.isSafeInteger(item.level) ? item.level : undefined
    const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : ''
    if (key.length === 0) problems.push(`${path}.key must be a non-empty string`)
    if (keys.has(key)) problems.push(`${path}.key duplicates ${key}`)
    if (key.length > 0) keys.add(key)
    if (context.existingIds.includes(key)) problems.push(`${path}.key collides with existing node ${key}`)
    if (!isOneSentence(definition)) problems.push(`${path}.definition must be exactly one sentence`)
    if (definition.length > 0) {
      const normalized = definition.replace(/\s+/gu, ' ').trim()
      if (definitions.has(normalized)) problems.push(`${path}.definition duplicates an existing definition`)
      definitions.add(normalized)
    }
    if (level === undefined) problems.push(`${path}.level must be an integer`)
    if (rationale.length === 0) problems.push(`${path}.rationale must explain the inner meaning it carries`)
    const exampleIndex = item.exampleIndex === undefined
      ? undefined
      : typeof item.exampleIndex === 'number' && Number.isSafeInteger(item.exampleIndex) && item.exampleIndex >= 1
        ? item.exampleIndex
        : undefined
    if (item.exampleIndex !== undefined && exampleIndex === undefined) {
      problems.push(`${path}.exampleIndex must be a positive integer`)
    }
    const trigger = typeof item.trigger === 'string' ? item.trigger.trim() : undefined
    if (exampleIndex === undefined) problems.push(`${path}.exampleIndex is required`)
    if (trigger === undefined || trigger.length === 0) problems.push(`${path}.trigger is required`)
    if (exampleIndex !== undefined && trigger !== undefined) {
      const line = context.examples[exampleIndex - 1]
      if (line === undefined) problems.push(`${path}.exampleIndex ${String(exampleIndex)} is out of range`)
      else if (!line.includes(trigger)) problems.push(`${path}.trigger is not an excerpt of example ${String(exampleIndex)}`)
    }
    drafts.push({
      key,
      definition,
      parent,
      level: level ?? context.parent.level + 1,
      ...(exampleIndex === undefined ? {} : { exampleIndex }),
      ...(trigger === undefined ? {} : { trigger }),
      rationale,
    })
  }
  // Parent chain: a candidate's parent is the real parent id or another candidate key.
  const byKey = new Map(drafts.map(draft => [draft.key, draft]))
  for (const draft of drafts) {
    let cursor = draft.parent
    let expectedLevel = context.parent.level + 1
    const seen = new Set<string>([draft.key])
    while (cursor !== context.parent.id) {
      const upstream = byKey.get(cursor)
      if (upstream === undefined) {
        problems.push(`${draft.key}.parent ${cursor} is neither ${context.parent.id} nor a submitted key`)
        break
      }
      if (seen.has(cursor)) {
        problems.push(`${draft.key}.parent chain contains a cycle`)
        break
      }
      seen.add(cursor)
      expectedLevel = upstream.level + 1
      cursor = upstream.parent
    }
    if (draft.level !== expectedLevel) problems.push(`${draft.key}.level must be ${String(expectedLevel)}`)
  }
  if (problems.length > 0) throw new DdogSubmissionError(problems)
  const rootSlots = context.parent.kind === 'root'
    ? parseRootSlots(record.rootSlots, keys)
    : undefined
  return {
    candidates: treeOrder(drafts, context.parent.id),
    ...(rootSlots === undefined ? {} : { rootSlots }),
  }
}

function parseRootSlots(value: unknown, keys: ReadonlySet<string>): readonly RootSlot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DdogSubmissionError(['rootSlots must be a non-empty array when expanding the root'])
  }
  const slots: RootSlot[] = []
  const problems: string[] = []
  for (const [index, raw] of value.entries()) {
    const item = asRecord(raw, `rootSlots[${String(index)}]`, problems)
    const slot = typeof item.slot === 'string' ? item.slot.trim() : ''
    if (slot.length === 0) problems.push(`rootSlots[${String(index)}].slot must be a non-empty string`)
    const candidates = Array.isArray(item.candidates)
      ? item.candidates.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (candidates.length === 0) problems.push(`rootSlots[${String(index)}].candidates must not be empty`)
    for (const candidate of candidates) {
      if (!keys.has(candidate)) problems.push(`rootSlots[${String(index)}]: ${candidate} is not a submitted key`)
    }
    slots.push({ slot, candidates })
  }
  if (problems.length > 0) throw new DdogSubmissionError(problems)
  return slots
}

/** Parents before children, preserving submission order within a parent. */
function treeOrder(
  drafts: readonly ExpansionCandidateDraft[],
  rootParentId: string,
): readonly ExpansionCandidateDraft[] {
  const ordered: ExpansionCandidateDraft[] = []
  const placed = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const draft of drafts) {
      if (placed.has(draft.key)) continue
      if (draft.parent !== rootParentId && !placed.has(draft.parent)) continue
      ordered.push(draft)
      placed.add(draft.key)
      changed = true
    }
  }
  return ordered
}

export interface JointVerdictDraft {
  readonly id: string
  readonly verdict: DdogVerdict
  readonly evidence: string
}

export interface ParentSubmission {
  readonly verdict: DdogVerdict
  readonly evidence: string
  readonly candidates: readonly JointVerdictDraft[]
  readonly newCandidates: readonly NewCandidateSubmission[]
  readonly retirementVerdicts: readonly DdogVerdict[]
}

export interface ParentContext {
  /** Direct candidates plus retired children: every one must be reported. */
  readonly jointIds: readonly string[]
  /** Number of retirement cases in the brief; verdicts are required only when positive. */
  readonly retirementCaseCount: number
}

/** Parse the parent judgment submission. */
export function parseParentSubmission(value: unknown, context: ParentContext): ParentSubmission {
  const record = asRecord(value, 'submission', [])
  const problems: string[] = []
  const verdict = VERDICTS.includes(record.verdict as DdogVerdict) ? (record.verdict as DdogVerdict) : undefined
  if (verdict === undefined) problems.push('verdict must be pass, fail, or inconclusive')
  const evidence = typeof record.evidence === 'string' ? record.evidence : ''
  const candidates: JointVerdictDraft[] = []
  if (!Array.isArray(record.candidates)) {
    problems.push('candidates must be an array reporting every direct candidate and retired child')
  } else {
    const reported = new Set<string>()
    for (const [index, raw] of record.candidates.entries()) {
      const item = asRecord(raw, `candidates[${String(index)}]`, problems)
      const id = typeof item.id === 'string' ? item.id : ''
      if (!context.jointIds.includes(id)) problems.push(`candidates[${String(index)}].id ${id} is not a joint child`)
      if (reported.has(id)) problems.push(`candidates[${String(index)}].id ${id} is reported twice`)
      reported.add(id)
      const childVerdict = VERDICTS.includes(item.verdict as DdogVerdict) ? (item.verdict as DdogVerdict) : undefined
      if (childVerdict === undefined) problems.push(`candidates[${String(index)}].verdict must be pass, fail, or inconclusive`)
      const childEvidence = typeof item.evidence === 'string' ? item.evidence : ''
      if (id.length > 0 && childVerdict !== undefined) candidates.push({ id, verdict: childVerdict, evidence: childEvidence })
    }
    for (const id of context.jointIds) {
      if (!reported.has(id)) problems.push(`candidates is missing joint child ${id}`)
    }
  }
  const newCandidates: NewCandidateSubmission[] = []
  if (record.newCandidates !== undefined) {
    if (!Array.isArray(record.newCandidates)) problems.push('newCandidates must be an array')
    else if (record.newCandidates.length > 10) problems.push('newCandidates carries at most 10 entries')
    else {
      for (const [index, raw] of record.newCandidates.entries()) {
        const item = asRecord(raw, `newCandidates[${String(index)}]`, problems)
        const definition = typeof item.definition === 'string' ? item.definition.trim() : ''
        const candidateEvidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
        if (!isOneSentence(definition)) problems.push(`newCandidates[${String(index)}].definition must be exactly one sentence`)
        if (candidateEvidence.length === 0) problems.push(`newCandidates[${String(index)}].evidence must quote the deliverable`)
        if (definition.length > 0) newCandidates.push({ definition, evidence: candidateEvidence })
      }
      if (newCandidates.length > 0 && verdict !== 'fail') problems.push('a submission with newCandidates must judge the parent fail')
    }
  }
  const retirementVerdicts: DdogVerdict[] = []
  if (context.retirementCaseCount > 0) {
    if (!Array.isArray(record.retirementVerdicts)) {
      problems.push('retirementVerdicts must report one verdict per past failure case')
    } else if (record.retirementVerdicts.length !== context.retirementCaseCount) {
      problems.push(`retirementVerdicts must have exactly ${String(context.retirementCaseCount)} entries`)
    } else {
      for (const [index, raw] of record.retirementVerdicts.entries()) {
        if (!VERDICTS.includes(raw as DdogVerdict)) {
          problems.push(`retirementVerdicts[${String(index)}] must be pass, fail, or inconclusive`)
          continue
        }
        retirementVerdicts.push(raw as DdogVerdict)
      }
    }
  }
  if (problems.length > 0) throw new DdogSubmissionError(problems)
  return {
    verdict: verdict!,
    evidence,
    candidates,
    newCandidates,
    retirementVerdicts,
  }
}

function asRecord(value: unknown, path: string, problems: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path} must be an object`)
    throw new DdogSubmissionError(problems)
  }
  return value as Record<string, unknown>
}
