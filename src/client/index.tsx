/** Browser half: a frame overlay that visualizes persisted DoG revisions and runs. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  DOG_DEBUG_RPC_CHANNEL,
  DOG_DEBUG_SNAPSHOT_ENDPOINT,
  DOG_RUNTIME_TRACE_ENDPOINT,
} from '../debug.ts'
import { DogDebugger } from './DogDebugger.tsx'
import { openInvocationSession } from './sessionNavigation.ts'
import { DOG_DEBUG_CSS, DOG_DEBUG_STYLE_ID } from './styles.ts'

/** The overlay uses the shared trusted RPC transport and canonical session navigator. */
export const inject = ['slots', 'sessions', 'connection']

/** Register the debugger beside other frame-wide overlays without replacing shipped UI. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const sessions = ctx.get('sessions') as unknown as ISessions
  const call = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = await connection.rpc.call(DOG_DEBUG_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const openSession = (sessionId: string, parentSessionId?: string): Promise<boolean> =>
    openInvocationSession(sessions, sessionId, parentSessionId)
  const DogDebuggerHost = (): JSX.Element => <DogDebugger
    readSnapshot={signal => call(DOG_DEBUG_SNAPSHOT_ENDPOINT, {}, signal)}
    readGoalRuntime={(runId, goalId, signal) => call(DOG_RUNTIME_TRACE_ENDPOINT, { runId, goalId }, signal)}
    openSession={openSession}
    getSessionState={() => sessions.list.getSnapshot()}
    subscribeSessions={listener => sessions.list.subscribe(listener)}
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
