/**
 * Runtime forensic capture: whenever a session turn is interrupted, snapshot
 * the on-scene facts (process uptime, recent event sequence, seed boundary)
 * so the next incident carries its own evidence instead of post-hoc guessing.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DogRepository } from '../core/storage.ts'

const RECENT_EVENT_COUNT = 12

/**
 * Subscribe to interrupted turns and persist one diagnostics file per incident.
 * @param ctx - plugin context owning the subscription.
 * @param repository - DoG store root the diagnostics directory lives under.
 */
export function installInterruptedTurnCapture(ctx: Context, repository: DogRepository): void {
 ctx.on('session/event', (session: Session, event: SessionEvent) => {
  if (event.type !== 'turn/end') return
  const reason = (event.data as { readonly reason?: { readonly kind?: string } }).reason
  if (reason?.kind !== 'interrupted') return
  void captureInterruptedTurn(repository, session, event).catch(() => undefined)
 })
}

async function captureInterruptedTurn(
 repository: DogRepository,
 session: Session,
 event: { readonly seq: number; readonly time: number },
): Promise<void> {
 const diagnosticsDir = join(repository.rootPath, 'diagnostics')
 await mkdir(diagnosticsDir, { recursive: true })
 const recentEvents = session.snapshotEvents().slice(-RECENT_EVENT_COUNT).map(candidate => ({
  seq: candidate.seq,
  type: candidate.type,
  time: candidate.time,
 }))
 const payload = {
  capturedAt: new Date().toISOString(),
  process: {
   pid: process.pid,
   startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  },
  sessionId: session.id,
  interruptSeq: event.seq,
  interruptEventTime: new Date(event.time).toISOString(),
  recentEvents,
 }
 await writeFile(
  join(diagnosticsDir, `interrupt-${session.id.replaceAll(/[^a-zA-Z0-9-]/gu, '_')}-${event.seq}.json`),
  JSON.stringify(payload, null, 2),
 )
}
