/**
 * Public core surface for embedders: the graph engine, its storage, graph
 * parsing and the verifier runners — everything a host needs to validate,
 * create and run a DoG graph without pulling the Cordis plugin half.
 *
 * Import from `@dsh-external/dsh-dog/core`. Anything not exported here is
 * internal: bundling may rename it, so downstream code must not reach into
 * `lib/*.js` chunks.
 */
export { DogEngine, resolveScriptPath } from './engine.ts'
export type { DogAgentDelegationOptions, DogBindAgentOptions, DogEngineOptions, DogRunOptions } from './engine.ts'
export { DogValidationError, parseGraph } from './graph.ts'
export { evaluateBoolExpr, parseBoolExpr } from './logic.ts'
export { canonicalJson, sha256Json } from './json.ts'
export { loadSchemaSet, schemaErrorText, type SchemaSet } from './schema.ts'
export { DogRepository } from './storage.ts'
export type { CapturedInputFile } from './storage.ts'
export { runPlan, type AgenticRunner, type ProgrammaticRunner, type Verdict } from './verifiers.ts'
export { WorkspaceManager } from './workspace.ts'
export type * from './model.ts'
