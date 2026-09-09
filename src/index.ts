/**
 * Package entry: the Cordis plugin surface the loader reads plus the public
 * domain API (engine, graph parsing, storage, tools) for programmatic users.
 *
 * Layering: `core/` is a plain library with no Harness imports, `dsh/` adapts
 * it to Cordis services, `client/` is the browser half, `shared/` holds the
 * zero-dependency wire constants both halves agree on.
 */

// ---- Cordis plugin surface (name / inject / Config / apply) ----
export { apply, Config, inject, name } from './dsh/plugin.ts'

// ---- Domain API ----
export { DogEngine, resolveScriptPath } from './core/engine.ts'
export { DogValidationError, parseGraph } from './core/graph.ts'
export { evaluateBoolExpr, parseBoolExpr } from './core/logic.ts'
export { canonicalJson, sha256Json } from './core/json.ts'
export { loadSchemaSet, schemaErrorText, type SchemaSet } from './core/schema.ts'
export { DogRepository } from './core/storage.ts'
export { runPlan, type AgenticRunner, type ProgrammaticRunner, type Verdict } from './core/verifiers.ts'
export { WorkspaceManager } from './core/workspace.ts'
export type * from './core/model.ts'

// ---- Harness-facing helpers ----
export {
 DOG_DEBUG_SNAPSHOT_PATH,
 DOG_RUNTIME_TRACE_PATH,
 buildDogDebugSnapshot,
 buildGoalRuntimeTrace,
 registerDogDebugRoutes,
} from './dsh/debug.ts'
export type { DogDebugGraphRevision, DogDebugSnapshot } from './dsh/debug.ts'
export {
 DOG_BIND_AGENT_TOOL,
 DOG_CREATE_TOOL,
 DOG_DELEGATE_AGENT_TOOL,
 DOG_RUN_TOOL,
 DOG_STATUS_TOOL,
 DOG_VALIDATE_TOOL,
 DOG_WAIT_TOOL,
 createDogDelegateAgentTool,
 createDogTools,
} from './dsh/tools.ts'
export type { DogAgentLauncher, DogSessionFacts } from './dsh/tools.ts'
export { DOG_SETTINGS_NAMESPACE, DogConfigSchema, installDogSettings } from './dsh/settings.ts'
export type { DogConfig } from './dsh/settings.ts'
