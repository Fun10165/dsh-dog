/**
 * DoG deployment configuration: one schema for the composition entry and the
 * user settings section, plus the live source wiring.
 *
 * The schema is declared once and used for both layers — the loader-validated
 * plugin entry (composition `base`) and the `dog` settings namespace the user
 * document overrides. Alpha exposes this through the `ctx.settings` service
 * (`installSection`), not the removed free functions.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Host-owned deployment configuration (composition entry and settings base). */
export interface DogConfig {
 storageDirectory: string
 /** Verifier workspace root (WorkspaceManager.baseDir): verifiers only read files inside this tree. */
 workspaceRoot: string
 /** Host-registered programmatic script library (relative to DSH_HOME, or absolute). */
 scriptsDirectory: string
 maxGraphNodes: number
 maxExpressionNodes: number
 maxExpressionDepth: number
 maxSandboxBytes: number
 allowPartialRoot: boolean
 maxConcurrentVerifications: number
 revalidateThreshold: number
 gmDigestAlgo: string
 subagentProvider: string
 subagentMaxDepth: number
}

/** Settings namespace owned by this plugin. */
export const DOG_SETTINGS_NAMESPACE = 'dog'

/** Loader-validated DoG configuration schema (also the settings namespace schema). */
export const DogConfigSchema: z<DogConfig> = z.object({
 storageDirectory: z.string().default('dog'),
 workspaceRoot: z.string().default('dog/workspace'),
 scriptsDirectory: z.string().default('dog/scripts'),
 maxGraphNodes: z.natural().min(1).default(256),
 maxExpressionNodes: z.natural().min(1).default(512),
 maxExpressionDepth: z.natural().min(1).default(64),
 maxSandboxBytes: z.natural().min(1).default(67_108_864),
 allowPartialRoot: z.boolean().default(false),
 maxConcurrentVerifications: z.natural().min(1).default(1),
 revalidateThreshold: z.number().default(0.3),
 gmDigestAlgo: z.string().default('sha256'),
 subagentProvider: z.string().default('spawn'),
 subagentMaxDepth: z.natural().default(3),
})

/**
 * Attach the composition entry as the settings base and hand the caller the
 * live source thunk. The registration is optional: a composition without the
 * settings service keeps using the entry value verbatim.
 *
 * @param ctx - plugin context owning the registration's lifetime.
 * @param entry - loader-validated composition entry (settings base layer).
 * @param onSource - receives a thunk returning the currently authoritative value.
 */
export function installDogSettings(
 ctx: Context,
 entry: DogConfig,
 onSource: (current: () => DogConfig) => void,
): void {
 ctx.inject(['settings'], settingsCtx => {
  settingsCtx.settings.installSection(
   ctx,
   DOG_SETTINGS_NAMESPACE,
   DogConfigSchema,
   entry,
   {
    setSource: onSource,
    onChange: () => undefined,
   },
  )
 })
}
