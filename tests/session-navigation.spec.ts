import { describe, expect, it, vi } from 'vitest'
import { loadInvocationSession } from '../src/client/sessionNavigation.ts'

type Sessions = Parameters<typeof loadInvocationSession>[0]

interface FixtureOptions {
  readonly ids: string[]
  readonly byId?: Record<string, unknown>
  readonly readyRejects?: boolean
  readonly onRefresh?: (parentSessionId: string) => void | Promise<void>
}

interface SessionFixture {
  readonly sessions: Sessions
  readonly setById: (sessionId: string, row: unknown) => void
  readonly setAddress: (sessionId: string, address: unknown) => void
  readonly retain: ReturnType<typeof vi.fn>
  readonly refreshProjections: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
}

function sessionFixture(options: FixtureOptions): SessionFixture {
  const byId: Record<string, unknown> = { ...options.byId }
  const addresses = new Map<string, unknown>()
  const release = vi.fn()
  const retain = vi.fn(() => ({
    sessionId: 'unused',
    binding: {},
    ready: options.readyRejects === true
      ? Promise.reject(new Error('open rejected'))
      : Promise.resolve({}),
    release,
  }))
  const refreshProjections = vi.fn(async (parentSessionId: string) => options.onRefresh?.(parentSessionId))
  const sessions = {
    list: { getSnapshot: () => ({ ids: options.ids, byId }) },
    retain,
    subagentAddress: (sessionId: string) => addresses.get(sessionId),
    refreshProjections,
  } as unknown as Sessions
  return {
    sessions,
    setById: (sessionId, row) => { byId[sessionId] = row },
    setAddress: (sessionId, address) => addresses.set(sessionId, address),
    retain,
    refreshProjections,
    release,
  }
}

describe('invocation session loading', () => {
  it('retains a catalogued session and releases the reference afterwards', async () => {
    const fixture = sessionFixture({ ids: ['session-target'] })

    await expect(loadInvocationSession(fixture.sessions, 'session-target')).resolves.toBe(true)
    expect(fixture.retain).toHaveBeenCalledWith('session-target', { source: 'dogDebugger' })
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it('resolves a retained subagent fallback row that the catalog ids omit', async () => {
    const fixture = sessionFixture({
      ids: ['session-parent'],
      byId: { 'session-child': { id: 'session-child' } },
    })

    await expect(loadInvocationSession(fixture.sessions, 'session-child')).resolves.toBe(true)
    expect(fixture.retain).toHaveBeenCalledWith('session-child', { source: 'dogDebugger' })
  })

  it('refreshes the recorded parent before resolving an addressed subagent', async () => {
    const address = { parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'task' }
    let fixture: SessionFixture
    fixture = sessionFixture({
      ids: ['session-parent'],
      onRefresh: () => fixture.setAddress('session-child', address),
    })

    await expect(loadInvocationSession(
      fixture.sessions,
      'session-child',
      'session-parent',
    )).resolves.toBe(true)
    expect(fixture.refreshProjections).toHaveBeenCalledWith('session-parent')
    expect(fixture.retain).toHaveBeenCalledWith(address, { source: 'dogDebugger' })
  })

  it('returns false when the persisted session is no longer addressable', async () => {
    const fixture = sessionFixture({ ids: ['session-other'] })

    await expect(loadInvocationSession(
      fixture.sessions,
      'session-missing',
      'session-parent',
    )).resolves.toBe(false)
    expect(fixture.retain).not.toHaveBeenCalled()
  })

  it('returns false and still releases when the initial open rejects', async () => {
    const fixture = sessionFixture({ ids: ['session-target'], readyRejects: true })

    await expect(loadInvocationSession(fixture.sessions, 'session-target')).resolves.toBe(false)
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })
})
