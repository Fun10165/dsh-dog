/**
 * Load a persisted DoG invocation session in the client.
 *
 * Harness 0.2 removed view navigation from the sessions service: the catalog
 * belongs to the Controller, and which Session the main view shows belongs to
 * the view owner. What remains public is the object layer — resolve the target,
 * then retain it so the client starts its shared history opening. This module
 * therefore loads a session rather than switching the main view.
 */

import type { ISessions, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
 interface SessionReferenceSourceMap {
  dogDebugger: unknown
 }
}

/**
 * Resolve a persisted invocation session and start opening it.
 *
 * @param sessions - client sessions service.
 * @param rawSessionId - the Agent session recorded on the DoG binding.
 * @param rawParentSessionId - the parent whose catalog holds a subagent child.
 * @returns true when the harness knows the session and its history opened.
 */
export async function loadInvocationSession(
 sessions: ISessions,
 rawSessionId: string,
 rawParentSessionId?: string,
): Promise<boolean> {
 const sessionId = rawSessionId as SessionId
 const target = await resolveTarget(sessions, sessionId, rawParentSessionId)
 if (target === undefined) return false
 const reference: SessionReference = sessions.retain(target, { source: 'dogDebugger' })
 try {
  await reference.ready
  return true
 } catch {
  return false
 } finally {
  reference.release()
 }
}

/** Catalog membership first; a direct-parent catalog supplies subagent children. */
async function resolveTarget(
 sessions: ISessions,
 sessionId: SessionId,
 rawParentSessionId: string | undefined,
): Promise<SessionTarget | undefined> {
 const state = sessions.list.getSnapshot()
 if (state.ids.includes(sessionId)) return sessionId
 // `byId` also carries retained subagent fallback rows, which `ids` omits.
 if (state.byId[sessionId] !== undefined) return sessionId
 const known = sessions.subagentAddress(sessionId)
 if (known !== undefined) return known
 if (rawParentSessionId === undefined) return undefined
 await sessions.refreshProjections(rawParentSessionId as SessionId)
 const refreshed = sessions.subagentAddress(sessionId)
 if (refreshed !== undefined) return refreshed
 return sessions.list.getSnapshot().byId[sessionId] === undefined ? undefined : sessionId
}
