/** DeepSeek Harness DoG plugin entry: configuration, lifecycle, and tools. */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { DogEngine } from './core.ts'
import type { ArtifactBinding, ArtifactRootBinding } from './model.ts'
import { DogRepository } from './storage.ts'
import { createDogTools } from './tools.ts'

export { DogEngine } from './core.ts'
export { DogValidationError, parseGraph } from './graph.ts'
export { evaluateBoolExpr, parseBoolExpr } from './logic.ts'
export { AtomicVerifierRegistry, createBuiltinVerifierRegistry } from './verifiers.ts'
export {
  DOG_CREATE_TOOL,
  DOG_RUN_TOOL,
  DOG_STATUS_TOOL,
  DOG_VALIDATE_TOOL,
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
})

/** Register all DoG tools as Cordis-owned effects so fiber disposal removes them. */
export function apply(ctx: Context, config: Config): void {
  const repository = new DogRepository(dshHomePath(config.storageDirectory))
  const engine = new DogEngine({ config, repository })
  for (const tool of createDogTools(engine)) ctx.effect(() => ctx.tools.register(tool))
}
