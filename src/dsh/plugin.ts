/**
 * DoG Cordis plugin entry: configuration, lifecycle, and service wiring.
 *
 * Everything DSH-specific lives in this directory (`src/dsh/`); the engine in
 * `src/core/` is a plain library with no Harness imports, so this file is the
 * only place that decides which upper-layer services the plugin consumes:
 * `ctx.tools` (tool registry), `ctx.sessions` (cwd/lineage facts),
 * `ctx.settings` (live config), `ctx.subagents` (verifier children),
 * `ctx.agents` (live-parent resolution), `ctx.jobs` (background waits), and
 * `ctx.connection` (trusted debugger RPC).
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { DogEngine, resolveScriptPath } from '../core/engine.ts'
import { isJsonValue } from '../core/model.ts'
import { loadSchemaSet } from '../core/schema.ts'
import { DogRepository } from '../core/storage.ts'
import type { ProgrammaticRunner, Verdict } from '../core/verifiers.ts'
import { WorkspaceManager } from '../core/workspace.ts'
import { createAgenticRunner, type AgenticRunnerHandle } from './agentic.ts'
import { registerDogDebugRoutes } from './debug.ts'
import { DogConfigSchema, type DogConfig } from './settings.ts'
import { installInterruptedTurnCapture } from './telemetry.ts'
import { createDogDelegateAgentTool, createDogTools, type DogSessionFacts } from './tools.ts'
import { createDdogSessionRunner } from './ddog-session.ts'
import { createDdogTools } from './ddog-tools.ts'

/** Cordis plugin name. */
export const name = 'dsh-dog'
/**
 * Required Harness services. Cordis gates every typed service access on the
 * caller's `inject` (reading an undeclared one throws at first use), so this
 * list must name every service the plugin touches: `tools` (registry),
 * `sessions` (cwd/lineage facts), and `agents` (live-verifier liveness).
 */
export const inject = ['tools', 'sessions', 'agents']

/** Loader-validated DoG deployment configuration (also the settings base). */
export type Config = DogConfig
/** Schemastery schema the loader validates the composition entry against. */
export const Config = DogConfigSchema

/** Register all DoG tools as Cordis-owned effects so fiber disposal removes them. */
export async function apply(ctx: Context, config: DogConfig): Promise<void> {
 const schema = await loadSchemaSet()
 const repository = new DogRepository(dshHomePath(config.storageDirectory), schema)
 // Host boot: cancel runs a previous process left `running` (killed/restarted
 // host) as soon as the plugin loads — before any engine or tool call. Their
 // settled leaves remain inheritable by the next run of the same graph.
 void repository.markOrphanedRunningRuns(new Date().toISOString()).catch(() => undefined)
 const scriptsDir = isAbsolute(config.scriptsDirectory) ? config.scriptsDirectory : dshHomePath(config.scriptsDirectory)
 const programmatic: ProgrammaticRunner = async (script, inputPath) => {
  let out: string
  try {
   out = execFileSync(resolveScriptPath(scriptsDir, script), [inputPath], {
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
   })
  } catch (error) {
   return {
    state: 'inconclusive',
    evidence: { error: String(error instanceof Error ? error.message : error) },
    reason: 'script execution failed',
   }
  }
  return parseVerdict(out)
 }
 /** Session facts tools need, read through the Session Store (never the Agent). */
 const sessionFacts = (sessionId: string): DogSessionFacts | undefined => {
  const header = ctx.sessions.get(sessionId as SessionId)?.header
  if (header === undefined) return undefined
  return {
   ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
   ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
  }
 }
 let dogEngine: DogEngine | undefined
 let agenticHandle: AgenticRunnerHandle | undefined
 const getEngine = (): DogEngine => {
  if (dogEngine === undefined) {
   // The Loader merges profile overrides into the validated entry before apply,
   // so `config` already is the effective value. A change to an ordinary field
   // restarts the plugin; the concurrency knob is volatile and read per run.
   dogEngine = new DogEngine({
    config: {
     ...config,
     maxConcurrentVerifications: config.maxConcurrentVerifications,
     workspaceRoot: isAbsolute(config.workspaceRoot) ? config.workspaceRoot : dshHomePath(config.workspaceRoot),
     scriptsDirectory: isAbsolute(config.scriptsDirectory) ? config.scriptsDirectory : dshHomePath(config.scriptsDirectory),
    },
    programmatic,
    ...(agenticHandle === undefined ? {} : { agentic: agenticHandle.runner }),
    repository,
    workspaces: new WorkspaceManager({ baseDir: config.workspaceRoot }),
    onRunCancelled: runId => agenticHandle?.interruptRun(runId),
    liveConfig: () => ({ maxConcurrentVerifications: config.maxConcurrentVerifications }),
    agentWorkspaceDir: sessionId => ctx.sessions.get(sessionId as SessionId)?.header.cwd,
   })
  }
  return dogEngine
 }
 for (const tool of createDogTools(getEngine, () => ctx.get('jobs') as JobRegistry | undefined, sessionFacts)) {
  ctx.effect(() => ctx.tools.register(tool))
 }
 ctx.inject(['subagents'], subagentCtx => {
  const handle = createAgenticRunner(
   {
    ctx,
    engine: getEngine,
    repository,
    provider: () => config.subagentProvider,
    maxDepth: () => config.subagentMaxDepth,
   },
   subagentCtx.subagents,
  )
  agenticHandle = handle
  subagentCtx.effect(() => subagentCtx.tools.register(createDogDelegateAgentTool(getEngine, handle.delegate)))
  const ddogRunner = createDdogSessionRunner({
   subagents: subagentCtx.subagents,
   provider: () => config.subagentProvider,
   maxDepth: () => config.subagentMaxDepth,
  })
  for (const tool of createDdogTools({
   sessions: sessionFacts,
   runner: () => ddogRunner,
   thresholds: () => ({
    promotionFailures: config.promotionFailures,
    promotionFailureRate: config.promotionFailureRate,
    retirementSuccessRate: config.retirementSuccessRate,
    retirementConsistency: config.retirementConsistency,
    retirementMinRuns: config.retirementMinRuns,
   }),
   now: () => new Date().toISOString(),
  })) {
   subagentCtx.effect(() => subagentCtx.tools.register(tool))
  }
 })
 installInterruptedTurnCapture(ctx, repository)
 // Browser-facing transport is optional: a composition without Connection
 // (headless, bare) keeps every tool working and simply has no debugger UI.
 ctx.inject(['connection'], debugCtx => registerDogDebugRoutes(debugCtx, repository))
}

/** Parse one programmatic script's stdout into a verdict. */
function parseVerdict(out: string): Verdict {
 let value: unknown
 try {
  value = JSON.parse(out)
 } catch {
  return { state: 'inconclusive', evidence: { parseError: 'script output was not JSON' }, reason: 'script output was not JSON' }
 }
 const record = value as Record<string, unknown>
 if (record === null || typeof record !== 'object' || Array.isArray(record)) {
  return { state: 'inconclusive', evidence: { parseError: 'script output was not an object' }, reason: 'script output was not an object' }
 }
 const verdict = record.verdict
 if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'inconclusive') {
  return { state: 'inconclusive', evidence: { parseError: 'invalid verdict' }, reason: 'script returned an invalid verdict' }
 }
 return {
  state: verdict,
  evidence: isJsonValue(record.evidence) ? record.evidence : { outcome: 'no evidence supplied by script' },
 }
}
