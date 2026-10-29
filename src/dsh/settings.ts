/**
 * DoG deployment configuration: one schema for the composition entry.
 *
 * Since harness 0.2 the settings service derives a form from each plugin's
 * declared Config instead of accepting a section injected by the plugin, so
 * this module only declares the schema. A field change is an ordinary config
 * once at apply time and a change restarts the plugin; the concurrency knob is
 * read once per plugin lifetime; editing it restarts the plugin.
 */

import z from '@deepseek-ai/schemastery'

/** Host-owned deployment configuration (composition entry). */
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
 /** DDoG lifecycle constants; defaults are the omp-dog values. */
 promotionFailures: number
 promotionFailureRate: number
 retirementSuccessRate: number
 retirementConsistency: number
 retirementMinRuns: number
}

/** Loader-validated DoG configuration schema. */
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
 promotionFailures: z.natural().min(0).default(2),
 promotionFailureRate: z.number().min(0).max(1).default(0.2),
 retirementSuccessRate: z.number().min(0).max(1).default(0.9),
 retirementConsistency: z.number().min(0).max(1).default(0.8),
 retirementMinRuns: z.natural().min(1).default(5),
})
