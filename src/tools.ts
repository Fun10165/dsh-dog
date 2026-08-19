/** Model-facing DoG tools over the verification-first engine. */

import { defineTool, type JsonValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DogEngine } from './core.ts'
import { isJsonValue } from './model.ts'
import type { CompiledGraph, DogRun } from './model.ts'

export const DOG_VALIDATE_TOOL = 'dog_validate'
export const DOG_CREATE_TOOL = 'dog_create'
export const DOG_RUN_TOOL = 'dog_run'
export const DOG_STATUS_TOOL = 'dog_status'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/** Build the complete DoG v0.1 tool surface around one engine instance. */
export function createDogTools(engine: DogEngine): readonly ToolDefinition[] {
  return [
    defineTool({
      name: DOG_VALIDATE_TOOL,
      description: 'Statically validate a DoG v0.1 graph. This does not write files, capture artifacts, or run goals.',
      parameters: {
        graph: { type: 'json', required: true, description: 'Complete JSON DoG graph using schemaVersion 0.1.' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        return jsonResult(engine.validate(args.graph))
      },
    }),
    defineTool({
      name: DOG_CREATE_TOOL,
      description: 'Compile and persist a valid DoG graph, resolving only host-configured artifact IDs and capturing immutable snapshots.',
      parameters: {
        graph: { type: 'json', required: true, description: 'Complete JSON DoG graph using schemaVersion 0.1.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const compiled = await engine.create(args.graph)
        exec.signal.throwIfAborted()
        return jsonResult(compiledGraphSummary(compiled))
      },
    }),
    defineTool({
      name: DOG_RUN_TOOL,
      description: 'Run trusted atomic verification for the latest persisted revision of a graph and recompute its root result.',
      parameters: {
        graphId: { type: 'string', required: true, description: 'Graph ID previously persisted by dog_create.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const run = await engine.run(args.graphId)
        exec.signal.throwIfAborted()
        return jsonResult(runSummary(run))
      },
    }),
    defineTool({
      name: DOG_STATUS_TOOL,
      description: 'Read the bounded persisted status and verifier evidence for one DoG run.',
      parameters: {
        runId: { type: 'string', required: true, description: 'Run ID returned by dog_run.' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const run = await engine.status(args.runId)
        exec.signal.throwIfAborted()
        return jsonResult(runSummary(run))
      },
    }),
  ]
}

function compiledGraphSummary(compiled: CompiledGraph): JsonValue {
  return {
    graphId: compiled.input.id,
    graphDigest: compiled.graphDigest,
    acceptancePlans: Object.values(compiled.acceptancePlans).map(plan => ({
      goalId: plan.goalId,
      verifierId: plan.verifierId,
      verifierVersion: plan.verifierVersion,
      artifactId: plan.artifactId,
      snapshotId: plan.snapshot.snapshotId,
      exists: plan.snapshot.exists,
      byteLength: plan.snapshot.byteLength,
      evidenceSchemaId: plan.evidenceSchemaId,
    })),
  }
}

function runSummary(run: DogRun): JsonValue {
  return {
    runId: run.runId,
    graphId: run.graphId,
    graphDigest: run.graphDigest,
    state: run.state,
    ...run.rootState === undefined ? {} : { rootState: run.rootState },
    goals: Object.fromEntries(Object.entries(run.goals).map(([goalId, result]) => [goalId, {
      state: result.state,
      ...result.reason === undefined ? {} : { reason: result.reason },
      ...result.verification === undefined ? {} : {
        verification: {
          verifierId: result.verification.verifierId,
          verifierVersion: result.verification.verifierVersion,
          artifactId: result.verification.artifactId,
          snapshotId: result.verification.snapshotId,
          passed: result.verification.passed,
          observation: result.verification.observation,
          verifiedAt: result.verification.verifiedAt,
        },
      },
    }])),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function jsonResult(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('DoG produced a non-JSON tool result')
  return value
}
