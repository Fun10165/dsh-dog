/** File-backed settlement channel for continuable verifier subagents. */

import { readFile } from 'node:fs/promises'
import type { JsonValue } from './model.ts'

export interface SettlementFileSummary {
 readonly state: 'pass' | 'fail' | 'inconclusive'
 readonly observation: Record<string, JsonValue>
 readonly waitedMs: number
}

/**
 * Wait (bounded polling) for a continuable verifier subagent to write its
 * settlement JSON to `resultPath`. Returns inconclusive on timeout or abort
 * instead of throwing, so the verification turn always settles honestly.
 */
export async function waitForSettlement(
 resultPath: string,
 signal: AbortSignal,
 timeoutMs: number,
): Promise<SettlementFileSummary> {
 const startAt = Date.now()
 while (Date.now() - startAt < timeoutMs) {
  if (signal.aborted) return { state: 'inconclusive', observation: { outcome: 'aborted' }, waitedMs: Date.now() - startAt }
  try {
   const parsed = parseSettlementFile(await readFile(resultPath, 'utf8'))
   return { ...parsed, waitedMs: Date.now() - startAt }
  } catch (error) {
   if (isMissing(error)) {
    await sleep(500)
    continue
   }
   return { state: 'inconclusive', observation: { outcome: 'unreadable settlement file' }, waitedMs: Date.now() - startAt }
  }
 }
 return { state: 'inconclusive', observation: { outcome: 'timed out waiting for verifier result' }, waitedMs: Date.now() - startAt }
}

export function parseSettlementFile(source: string): { readonly state: 'pass' | 'fail' | 'inconclusive'; readonly observation: Record<string, JsonValue> } {
 const value = JSON.parse(source) as unknown
 if (value === null || typeof value !== 'object' || Array.isArray(value)) {
  return { state: 'inconclusive', observation: { outcome: 'settlement file is not a JSON object' } }
 }
 const raw = value as Record<string, unknown>
 const state = raw.settlement
 if (state !== 'pass' && state !== 'fail' && state !== 'inconclusive') {
  return { state: 'inconclusive', observation: { outcome: 'settlement file has an invalid settlement value' } }
 }
 const observation = raw.observation
 if (observation === undefined) {
  return { state: 'inconclusive', observation: { outcome: 'settlement file has no observation evidence' } }
 }
 if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
  return { state: 'inconclusive', observation: { outcome: 'settlement observation is not an object' } }
 }
 const record: Record<string, JsonValue> = {}
 for (const [key, item] of Object.entries(observation)) {
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
   record[key] = item
  } else if (Array.isArray(item) || typeof item === 'object') {
   if (isJsonValueLike(item)) record[key] = item
  }
 }
 if (Object.keys(record).length === 0) record.settled = state
 return { state, observation: record }
}

function isJsonValueLike(value: unknown): boolean {
 if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
 if (typeof value === 'number') return Number.isFinite(value)
 if (Array.isArray(value)) return value.every(isJsonValueLike)
 if (typeof value !== 'object') return false
 return Object.values(value).every(isJsonValueLike)
}

function isMissing(error: unknown): boolean {
 return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function sleep(ms: number): Promise<void> {
 return new Promise(resolve => setTimeout(resolve, ms))
}
