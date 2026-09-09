/**
 * Host face of the debugger: two exact Fetch routes on the shared `/api`
 * carrier, serving the read-only projections from `src/core/debug.ts`.
 *
 * Why Fetch routes rather than a logical RPC channel: the Connection plugin
 * mounts `/api` itself and applies its Host/Origin fence plus browser
 * authentication before dispatch, so a plugin never re-implements trust. Its
 * `rpc.handle(channel, …)` prefix registry is unusable from an external plugin
 * on this platform release — the registry resolves `webServer` from the
 * Connection plugin's own fiber, which does not inject it.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
 boundedMessage,
 buildDogDebugSnapshot,
 buildGoalRuntimeTrace,
 messageOf,
 type DogDebugGraphRevision,
 type DogDebugSnapshot,
} from '../core/debug.ts'
import type { DogRepository } from '../core/storage.ts'
import { DOG_DEBUG_SNAPSHOT_PATH, DOG_RUNTIME_TRACE_PATH } from '../shared/protocol.ts'

export { DOG_DEBUG_SNAPSHOT_PATH, DOG_RUNTIME_TRACE_PATH }
export { buildDogDebugSnapshot, buildGoalRuntimeTrace }
export type { DogDebugGraphRevision, DogDebugSnapshot }

/**
 * Register the debugger routes on the Connection Fetch registry.
 * @param ctx - a context that has `connection` (the caller's fiber owns the effect).
 * @param repository - persisted DoG store to read.
 */
export function registerDogDebugRoutes(ctx: Context, repository: DogRepository): void {
 for (const route of debugRoutes(repository)) {
  ctx.effect(() => ctx.connection.fetch.register(route), `dog: ${route.path}`)
 }
}

function debugRoutes(repository: DogRepository): readonly ConnectionFetchRoute[] {
 return [
  {
   path: DOG_DEBUG_SNAPSHOT_PATH,
   methods: ['POST'],
   requestBody: 'buffered',
   fetch: async () => jsonResponse(await buildDogDebugSnapshot(repository)),
  },
  {
   path: DOG_RUNTIME_TRACE_PATH,
   methods: ['POST'],
   requestBody: 'buffered',
   fetch: async request => {
    try {
     const { runId, goalId } = parseGoalRuntimeRequest(await request.json())
     return jsonResponse(await buildGoalRuntimeTrace(repository, runId, goalId))
    } catch (error) {
     return jsonResponse({ error: boundedMessage(messageOf(error)) }, 400)
    }
   },
  },
 ]
}

function jsonResponse(value: unknown, status = 200): Response {
 return Response.json(value, { status })
}

function parseGoalRuntimeRequest(value: unknown): { readonly runId: string; readonly goalId: string } {
 if (value === null || typeof value !== 'object' || Array.isArray(value)) {
  throw new Error('DoG runtime request payload must be an object')
 }
 const record = Object.fromEntries(Object.entries(value))
 return {
  runId: requireBoundedId(record.runId, 'runId'),
  goalId: requireBoundedId(record.goalId, 'goalId'),
 }
}

function requireBoundedId(value: unknown, label: string): string {
 if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
  throw new Error(`${label} must contain 1-512 characters`)
 }
 return value
}
