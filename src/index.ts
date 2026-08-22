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
import { createBuiltinVerifierRegistry, type AgenticVerifierRunner, type Settlement, type VerifierContract } from './verifiers.ts'
import type { AcceptancePlan, JsonValue } from './model.ts'

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
  for (const tool of createDogTools(engine)) ctx.effect(() => ctx.tools.register(tool))
  ctx.inject(['subagents'], (subagentCtx) => {
    const subagents = (subagentCtx as unknown as { readonly subagents: HostContinuableSubagents }).subagents
    const agenticRunner: AgenticVerifierRunner = {
      async run({ contract, plan, workspace, parent, signal }) {
        const bytes = await repository.read(plan.snapshot)
        const inputPath = join(workspace.path, `${plan.artifactId}.bin`)
        await writeFile(inputPath, bytes)
        const run = await subagents.start(config.subagentProvider, {
          label: `verifier ${contract.id}@${contract.version}`,
          prompt: [{ type: 'text', text: buildVerifierPrompt(contract, plan, inputPath) }],
          parent: parent as never,
          signal,
          outputSchema: VERIFIER_OUTPUT_SCHEMA as never,
        } as never)
        const result = await run.result
        return parseSettlement(result.structured as unknown)
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
  start(provider: string, spec: {
    readonly label?: string
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
    readonly parent: unknown
    readonly signal: AbortSignal
    readonly outputSchema?: unknown
  }): Promise<{
    readonly result: Promise<{
      readonly structured?: unknown
      readonly output: readonly unknown[]
      readonly stopReason: string
    }>
  }>
  startContinuable(spec: {
    readonly provider: string
    readonly label: string
    readonly request: {
      readonly prompt: { readonly type: 'text'; readonly text: string }[]
      readonly parent: unknown
      readonly maxDepth: number
    }
    readonly signal: AbortSignal
  }): Promise<{ readonly childId: unknown }>
  interrupt(sessionId: string, authority: { readonly kind: 'ancestor'; readonly agent: unknown }): void
}

const VERIFIER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['settlement', 'observation'],
  properties: {
    settlement: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
    observation: { type: 'object' },
  },
} as const

function buildVerifierPrompt(contract: VerifierContract, plan: AcceptancePlan, inputPath: string): string {
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
    'You may write scratch files inside your present working directory only. Never touch other paths.',
    'Produce structured evidence: your observation must state what you actually measured or saw',
    '(boxes, areas, OCR text, measurements). You cannot claim a pass or fail without evidence.',
    'If the material cannot be inspected or you cannot decide, report settlement "inconclusive".',
  ].join('\n')
}

function parseSettlement(value: unknown): Settlement {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { state: 'inconclusive', observation: {} }
  const record = value as { readonly settlement?: unknown; readonly observation?: unknown }
  const settlement = record.settlement
  if (settlement !== 'pass' && settlement !== 'fail' && settlement !== 'inconclusive') {
    return { state: 'inconclusive', observation: {} }
  }
  const observation = record.observation
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
    return { state: settlement, observation: { settled: settlement } }
  }
  return { state: settlement, observation: observation as Record<string, JsonValue> }
}
