/**
 * Agentic verification runner: one verifier child Agent per leaf/composite
 * assertion, plus the durable `dog_delegate_agent` launcher.
 *
 * This is the only module that talks to the subagent service. It keeps the
 * engine free of DSH coupling and owns the live-verifier registry that
 * `dog_cancel` uses to interrupt children.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentInterruptAuthority, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { join } from 'node:path'
import type { DogEngine } from '../core/engine.ts'
import type { DogRepository } from '../core/storage.ts'
import { waitForSettlementFlexible } from '../core/verifier-file.ts'
import type { AgenticRunner } from '../core/verifiers.ts'
import type { DogAgentLauncher } from './tools.ts'

/** Live knobs the runner reads per start (settings may change without a reload). */
export interface AgenticRunnerHost {
 readonly ctx: Context
 readonly engine: () => DogEngine
 readonly repository: DogRepository
 /** Continuable-child provider name. */
 readonly provider: () => string
 readonly maxDepth: () => number
}

/** Runner plus the interrupt surface `dog_cancel` needs. */
export interface AgenticRunnerHandle {
 readonly runner: AgenticRunner
 readonly delegate: DogAgentLauncher
 /** Interrupt every live verifier child spawned for one run. */
 interruptRun(runId: string): void
}

const VERIFIER_SETTLEMENT_TIMEOUT_MS = 900_000

/**
 * Build the agentic runner and the delegate launcher over one subagent service.
 * @param host - engine, repository, and live configuration thunks.
 * @param subagents - the `ctx.subagents` service.
 * @returns runner, launcher, and run-level interruption.
 */
export function createAgenticRunner(
 host: AgenticRunnerHost,
 subagents: SubagentRuntime,
): AgenticRunnerHandle {
 // Live verifier subagents keyed by session id — dog_cancel interrupts them.
 const activeVerifiers = new Map<string, { readonly parent: Agent; readonly runId: string }>()

 const runner: AgenticRunner = async (instruction, workspace, inputPath, env) => {
  const { parent, runId } = env
  const signal = env.signal ?? new AbortController().signal
  const goalId = env.goalId ?? 'verification'
  const resultPath = join(workspace.path, 'settlement.json')
  const parentSessionId = parent === undefined ? '' : String(parent.id)
  if (parent === undefined) {
   throw new Error('verifier delegation requires a live parent Agent (recovered runs without a live parent cannot spawn verification workers)')
  }
  const started = await subagents.startContinuable({
   provider: host.provider(),
   label: `verifier ${goalId} · ${runId === undefined ? 'run' : runId.slice(0, 6)}`,
   request: {
    prompt: [{ type: 'text', text: buildVerifierPrompt(instruction, inputPath, resultPath) }],
    parent,
    maxDepth: host.maxDepth(),
   },
   signal,
  })
  const sessionId = started.childId
  activeVerifiers.set(sessionId, { parent, runId: runId ?? '' })
  if (runId !== undefined) {
   try {
    await host.engine().annotateRun(runId, `bind-branch entered for ${goalId}: session ${sessionId.slice(0, 8)}`)
    const binding = await host.engine().bindAgent(
     {
      runId,
      goalId,
      role: 'verifier',
      sessionId,
      ...(parentSessionId.length > 0 ? { parentSessionId } : {}),
     },
     { allowUnrooted: parentSessionId.length === 0 },
    )
    await host.engine().annotateRun(
     runId,
     `verifier bound for ${goalId}: ${sessionId.slice(0, 8)} (${binding.run.goals[goalId]?.agentSessions?.length ?? 0} bound)`,
    )
   } catch (bindingError) {
    await host.engine().annotateRun(runId, `verifier binding failed for ${goalId}: ${String(bindingError).slice(0, 300)}`)
    await host.engine().recordVerifierLifecycle(runId, goalId, 'verifier_bind_failed', sessionId, String(bindingError))
   }
  }
  const settlement = await waitForSettlementFlexible(
   resultPath,
   signal,
   VERIFIER_SETTLEMENT_TIMEOUT_MS,
   async () => verifierChildTurnEnded(host.ctx, sessionId),
  )
  if (settlement.source !== undefined && runId !== undefined) {
   // The verifier workspace is reclaimed at run teardown; keep the
   // verbatim judgment on disk so 'what happened' stays inspectable.
   void host.repository.saveSettlement(runId, goalId, settlement.source).catch(() => undefined)
  }
  if (runId !== undefined && parentSessionId.length > 0) {
   try {
    // Quiet release: interrupting a finished-but-not-yet-released child
    // emits "Background subagent … was stopped" notifications into the
    // parent session, which interrupt a parent-turn blocked in dog_wait.
    // drainContinuableChildren releases the Activation/session handle
    // without that notification storm.
    await subagents.drainContinuableChildren(parent, [sessionId])
    activeVerifiers.delete(sessionId)
    await host.engine().recordVerifierLifecycle(runId, goalId, 'verifier_released', sessionId)
   } catch (releaseError) {
    await host.engine().annotateRun(runId, `verifier release failed for ${goalId}: ${String(releaseError).slice(0, 300)}`)
   }
  }
  return { state: settlement.state, evidence: settlement.observation }
 }

 const delegate: DogAgentLauncher = {
  async launch(input) {
   const started = await subagents.startContinuable({
    provider: host.provider(),
    label: input.label,
    request: {
     prompt: [{ type: 'text', text: input.prompt }],
     parent: input.parent,
     maxDepth: host.maxDepth(),
    },
    signal: input.signal,
   })
   return { sessionId: started.childId }
  },
  interrupt(sessionId, parent) {
   subagents.interrupt(sessionId, { kind: 'ancestor', agent: parent } satisfies SubagentInterruptAuthority)
  },
 }

 const interruptRun = (runId: string): void => {
  for (const [sessionId, record] of activeVerifiers) {
   if (record.runId !== runId) continue
   try {
    subagents.interrupt(
     sessionId as SessionId,
     { kind: 'ancestor', agent: record.parent } satisfies SubagentInterruptAuthority,
    )
   } catch {
    // best-effort; the run record is already cancelled
   }
  }
 }

 return { runner, delegate, interruptRun }
}

/** The first-turn prompt handed to one verifier child. */
export function buildVerifierPrompt(
 instruction: string,
 inputPath: string,
 resultPath: string,
): string {
 return [
  'You are a DoG verifier. Judge only the object handed to you.',
  '',
  `Object (read from here; only this tree is yours): ${inputPath}`,
  '',
  'Instruction:',
  instruction,
  '',
  'Decide on your own terms; gather the strongest evidence you can with your own judgment. No fixed evidence format.',
  `Write your verdict to this exact absolute path: ${resultPath}. The file must contain exactly:`,
  '{"verdict": "pass" | "fail" | "inconclusive", "evidence": <any JSON>}',
  'Create it (it does not exist yet); never write it as a relative path or to another location. After writing, stop.',
 ].join('\n')
}

/** True once the verifier child's turn has ended (or the child is gone entirely). */
function verifierChildTurnEnded(ctx: Context, sessionId: string): boolean {
 const agent = ctx.agents.get(sessionId as SessionId)
 if (agent === undefined) return true
 return ctx.sessions.get(sessionId as SessionId)?.snapshotEvents().at(-1)?.type === 'turn/end'
}
