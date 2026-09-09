/** Browser half: a frame overlay that visualizes persisted DoG revisions and runs. */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { } from '@deepseek-ai/dsh-client-ui-session/client'
import { DOG_DEBUG_SNAPSHOT_PATH, DOG_RUNTIME_TRACE_PATH } from '../shared/protocol.ts'
import { DogDebugger } from './DogDebugger.tsx'
import { openInvocationSession } from './sessionNavigation.ts'
import { DOG_DEBUG_CSS, DOG_DEBUG_STYLE_ID } from './styles.ts'

/** The overlay uses the shared `/api` carrier and the canonical session navigator. */
export const inject = ['slots', 'sessions', 'uiSession']

/** Register the debugger beside other frame-wide overlays without replacing shipped UI. */
export function apply(ctx: Context): void {
  // Host and browser packages both augment `Context`, so the shared type of
  // `sessions` resolves to the Host service in a single-program build. Narrow
  // once here: this half runs in a client Context, and the declared `inject`
  // guarantees the service below is present.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const pendingInteractions = ctx.uiSession.pendingInteractions
  // Same-origin POST to the Host's exact Fetch routes; the `/api` carrier has
  // already applied its Host/Origin fence and browser authentication.
  const call = async (path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`DoG debugger request failed: HTTP ${response.status}`)
    return await response.json()
  }
  const openSession = (sessionId: string, parentSessionId?: string): Promise<boolean> =>
    openInvocationSession(sessions, sessionId, parentSessionId)
  const DogDebuggerHost = (): JSX.Element => <DogDebugger
    readSnapshot={signal => call(DOG_DEBUG_SNAPSHOT_PATH, {}, signal)}
    readGoalRuntime={(runId, goalId, signal) => call(DOG_RUNTIME_TRACE_PATH, { runId, goalId }, signal)}
    openSession={openSession}
    getSessionState={() => sessions.list.getSnapshot()}
    subscribeSessions={listener => sessions.list.subscribe(listener)}
    getPendingInteractions={() => pendingInteractions.getSnapshot()}
    subscribePendingInteractions={listener => pendingInteractions.subscribe(listener)}
    refreshAgentCatalog={parentSessionId => sessions.refreshSubagents(parentSessionId as SessionId)}
  />
  ctx.effect(installStyles, 'dog-debugger: styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dog-graph-debugger',
    order: 80,
  }, DogDebuggerHost))
}

function installStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${DOG_DEBUG_STYLE_ID}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = '@dsh-external/dsh-dog'
  style.dataset.pluginCss = DOG_DEBUG_STYLE_ID
  style.textContent = DOG_DEBUG_CSS
  document.head.appendChild(style)
  return () => style.remove()
}
