/** DeepSeek Harness DoG plugin entry: configuration, lifecycle, and tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DogEngine } from './core.ts'
import { DOG_DEBUG_RPC_CHANNEL, createDogDebugRpcHandler } from './debug.ts'
import type { ArtifactBinding, ArtifactRootBinding } from './model.ts'
import { loadSchemaSet } from './schema.ts'
import { DogRepository } from './storage.ts'
import { createDogDelegateAgentTool, createDogTools } from './tools.ts'
import { WorkspaceManager } from './workspace.ts'
import { createBuiltinVerifierRegistry, type AgenticVerifierRunner, type VerifierContract } from './verifiers.ts'
import type { AcceptancePlan } from './model.ts'
import { waitForSettlement } from './verifier-file.ts'
import { renderDeckPages } from './render.ts'

export { DogEngine } from './core.ts'
export {
  DOG_DEBUG_RPC_CHANNEL,
  DOG_DEBUG_SNAPSHOT_ENDPOINT,
  DOG_RUNTIME_TRACE_ENDPOINT,
  buildDogDebugSnapshot,
  buildGoalRuntimeTrace,
  createDogDebugRpcHandler,
} from './debug.ts'
export type { DogDebugGraphRevision, DogDebugSnapshot } from './debug.ts'
export { DogValidationError, parseGraph } from './graph.ts'
export { evaluateBoolExpr, parseBoolExpr } from './logic.ts'
export { createBuiltinExtractorRegistry } from './extractors.ts'
export { VerifierContractRegistry, createBuiltinVerifierRegistry } from './verifiers.ts'
export { WorkspaceManager } from './workspace.ts'
export { loadSchemaSet } from './schema.ts'
export {
  DOG_BIND_AGENT_TOOL,
  DOG_CREATE_TOOL,
  DOG_DELEGATE_AGENT_TOOL,
  DOG_RUN_TOOL,
  DOG_STATUS_TOOL,
  DOG_VALIDATE_TOOL,
  createDogDelegateAgentTool,
  createDogTools,
} from './tools.ts'
export type * from './model.ts'

/** Cordis plugin name. */
export const name = 'dsh-dog'
/** Required Harness services. */
export const inject = ['tools']

/** Host-owned deployment configuration. */
export interface Config {
  artifactRoots: ArtifactRootBinding[]
  artifactBindings: ArtifactBinding[]
  storageDirectory: string
  maxGraphNodes: number
  maxExpressionNodes: number
  maxExpressionDepth: number
  maxSnapshotBytes: number
  allowPartialRoot: boolean
  maxConcurrentVerifications: number
  revalidateThreshold: number
  gmDigestAlgo: string
  subagentProvider: string
  subagentMaxDepth: number
}

/** Loader-validated DoG deployment configuration. */
export const Config: z<Config> = z.object({
  artifactRoots: z.array(z.object({
    id: z.string().required(),
    path: z.string().required(),
  })).default([]),
  artifactBindings: z.array(z.object({
    id: z.string().required(),
    rootId: z.string().required(),
    relativePath: z.string().required(),
  })).default([]),
  storageDirectory: z.string().default('dog'),
  maxGraphNodes: z.natural().min(1).default(256),
  maxExpressionNodes: z.natural().min(1).default(512),
  maxExpressionDepth: z.natural().min(1).default(64),
  maxSnapshotBytes: z.natural().min(1).default(67_108_864),
  allowPartialRoot: z.boolean().default(false),
  maxConcurrentVerifications: z.natural().min(1).default(1),
  revalidateThreshold: z.number().default(0.3),
  gmDigestAlgo: z.string().default('sha256'),
  subagentProvider: z.string().default('spawn'),
  subagentMaxDepth: z.natural().default(3),
})

/** Register all DoG tools as Cordis-owned effects so fiber disposal removes them. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const schema = await loadSchemaSet()
  const repository = new DogRepository(dshHomePath(config.storageDirectory), schema)
  const engine = new DogEngine({ config, repository, workspaces: new WorkspaceManager() })
  void engine.reapOrphanRuns().catch(() => undefined)
  for (const tool of createDogTools(engine)) ctx.effect(() => ctx.tools.register(tool))
  ctx.inject(['subagents'], (subagentCtx) => {
    const subagents = (subagentCtx as unknown as { readonly subagents: HostContinuableSubagents }).subagents
    const agenticRunner: AgenticVerifierRunner = {
      async run({ contract, plan, workspace, parent, signal, runId }) {
        const bytes = await repository.read(plan.snapshot)
        const inputPath = join(workspace.path, `${plan.artifactId}.bin`)
        await writeFile(inputPath, bytes)
        const resultPath = join(workspace.path, 'settlement.json')
        const rendered = await renderDeckPages(inputPath, workspace.path)
        if (!rendered.ok && runId !== undefined) {
          await engine.annotateRun(runId, `page renderer unavailable for ${plan.goalId}: ${rendered.detail}`)
        }
        const parentSessionId = readSessionId(parent)
        const started = await subagents.startContinuable({
          provider: config.subagentProvider,
          label: `verifier ${contract.id}@${contract.version}`,
          request: {
            prompt: [{ type: 'text', text: buildVerifierPrompt(contract, plan, inputPath, resultPath, rendered.pages) }],
            parent,
            maxDepth: config.subagentMaxDepth,
          },
          signal,
        })
        const sessionId = String(started.childId)
        if (runId !== undefined && parentSessionId.length > 0) {
          try {
            await engine.bindAgent({
              runId,
              goalId: plan.goalId,
              role: 'verifier',
              sessionId,
              parentSessionId,
            })
          } catch (bindingError) {
            await engine.annotateRun(runId, `verifier binding failed for ${plan.goalId}: ${String(bindingError).slice(0, 300)}`)
            await engine.recordVerifierLifecycle(runId, plan.goalId, 'verifier_bind_failed', sessionId, String(bindingError))
          }
        }
        const settlement = await waitForSettlement(resultPath, signal, 900_000)
        if (runId !== undefined && parentSessionId.length > 0) {
          try {
            subagents.interrupt(sessionId, { kind: 'ancestor', agent: parent })
            await engine.recordVerifierLifecycle(runId, plan.goalId, 'verifier_released', sessionId)
          } catch (releaseError) {
            await engine.annotateRun(runId, `verifier release failed for ${plan.goalId}: ${String(releaseError).slice(0, 300)}`)
          }
        }
        return { state: settlement.state, observation: settlement.observation }
      },
    }
    engine.setVerifierRegistry(createBuiltinVerifierRegistry({ agenticRunner }))
    const delegateTool = createDogDelegateAgentTool(engine, {
      async launch(input) {
        const started = await subagents.startContinuable({
          provider: config.subagentProvider,
          label: input.label,
          request: {
            prompt: [{ type: 'text', text: input.prompt }],
            parent: input.parent,
            maxDepth: config.subagentMaxDepth,
          },
          signal: input.signal,
        })
        return { sessionId: String(started.childId) }
      },
      interrupt(sessionId, parent) {
        subagents.interrupt(sessionId, { kind: 'ancestor', agent: parent })
      },
    })
    subagentCtx.effect(() => subagentCtx.tools.register(delegateTool))
  })
  const debugHandler = createDogDebugRpcHandler(repository)
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.rpc.handle(
      DOG_DEBUG_RPC_CHANNEL,
      debugHandler,
      { authority: 'trusted-host' },
    ), 'dog: trusted debugger RPC')
  })
}

interface HostContinuableSubagents {
  startContinuable(spec: {
    readonly provider: string
    readonly label: string
    readonly request: {
      readonly prompt: { readonly type: 'text'; readonly text: string }[]
      readonly parent: unknown
      readonly maxDepth: number
      readonly toolFilter?: { readonly deny?: readonly string[]; readonly allow?: readonly string[] }
    }
    readonly signal: AbortSignal
  }): Promise<{ readonly childId: unknown }>
  interrupt(sessionId: string, authority: { readonly kind: 'ancestor'; readonly agent: unknown }): void
}

function buildVerifierPrompt(
  contract: VerifierContract,
  plan: AcceptancePlan,
  inputPath: string,
  resultPath: string,
  renderedPages: readonly string[],
): string {
  const requirement = typeof plan.params.requirement === 'string'
    ? plan.params.requirement
    : contract.requirement
  const target = typeof plan.params.target === 'string' ? plan.params.target : '<whole artifact>'
  return [
    'You are a DoG verification Agent. Judge ONLY the bound material; you never redefine the task.',
    '',
    `Verification task: ${requirement}`,
    `Target region: ${target}`,
    `Artifact file (read-only content): ${inputPath}`,
    `Allowed tools: ${contract.allowedTools.join(', ') || 'none'}`,
    'Shell commands are allowed BUT only while the working directory is the artifact workspace; never touch any path outside it',
    '(especially the host project /Users/fun10165 and other mounts). Write files only inside the workspace directory.',
    ...(renderedPages.length === 0
      ? ['WARNING: no page renders are available; inspect the OOXML structure instead.']
      : [
        'Page renders (you have vision): use your read tool on each of these PNG files BEFORE judging:',
        ...renderedPages.map(page => `  - ${page}`),
      ]),
    'Your ONLY writable location is the directory containing the artifact file; all other paths are forbidden.',
    'Do not inspect, list, or read anything outside that directory.',
    'Produce structured evidence: your observation must state what you actually measured or saw',
    '(boxes, areas, OCR text, measurements). You cannot claim a pass or fail without evidence.',
    `Write your settlement to this exact absolute path with your write tool: ${resultPath}`,
    'It must be a JSON object: {"settlement": "pass"|"fail"|"inconclusive", "observation": {...}}.',
    'After writing the file, stop immediately: no further tool calls, no further inspection. Reply only "verification done".',
    'If the material cannot be inspected or you cannot decide, report settlement "inconclusive".',
  ].join('\n')
}

/** Read the durable session id from a host-provided agent object without trusting an unchecked shape. */
function readSessionId(parent: unknown): string {
  if (parent === null || typeof parent !== 'object') return ''
  if (!('id' in parent)) return ''
  const id = parent.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : ''
}
