/**
 * Model-facing DDoG tools: init, expand, run, status.
 *
 * Each mutating tool spawns exactly one child session per phase, validates the
 * submission strictly, and only then writes the project graph.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { definitionProblems } from '../core/ddog-definition.ts'
import {
  applyObservation,
  applyRetirement,
  appendNewCandidates,
  retirementCases,
  type DdogThresholds,
} from '../core/ddog-lifecycle.ts'
import {
  childrenOf,
  createRootGraph,
  formalChildrenOf,
  jointChildrenOf,
  withNode,
  type DdogGraph,
  type DdogNode,
  type Observation,
} from '../core/ddog-model.ts'
import { DdogStore } from '../core/ddog-store.ts'
import type { JsonValue } from '../core/model.ts'
import { buildExpandPrompt, buildParentPrompt, buildRootPrompt } from './ddog-prompts.ts'
import type { DdogSessionRunner } from './ddog-session.ts'
import {
  DdogSubmissionError,
  parseExpansionSubmission,
  parseInitSubmission,
  parseParentSubmission,
  type ParentSubmission,
} from './ddog-submissions.ts'
import type { DogSessionFacts } from './tools.ts'

export const DDOG_INIT_TOOL = 'ddog_init'
export const DDOG_EXPAND_TOOL = 'ddog_expand'
export const DDOG_RUN_TOOL = 'ddog_run'
export const DDOG_STATUS_TOOL = 'ddog_status'

export interface DdogToolDeps {
  readonly sessions: (sessionId: string) => DogSessionFacts | undefined
  readonly runner: () => DdogSessionRunner
  readonly thresholds: () => DdogThresholds
  readonly now: () => string
}

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

const SOURCES = ['production', 'simulation'] as const

/** The four DDoG tools, sharing one session runner and one project store per call. */
export function createDdogTools(deps: DdogToolDeps): readonly ToolDefinition[] {
  return [
    defineTool({
      name: DDOG_INIT_TOOL,
      description: 'Create the DDoG graph for this project by turning the user instruction into one root definition. '
        + 'Runs one Agent session; refuses when the project already has a graph.',
      parameters: {
        instruction: { type: 'string', required: true, description: 'The user instruction verbatim; the root definition must stay inside its meaning.' },
        file: { type: 'string', description: 'Absolute path of the instruction file, when the instruction came from one.' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const project = projectDirectory(deps, exec.agent)
        const store = new DdogStore(project)
        if (await store.load() !== undefined) {
          throw new Error(`this project already has ${store.graphPath}; remove it to start a new graph`)
        }
        const parent = requireAgent(exec.agent)
        const runner = deps.runner()
        const resultPath = await submissionPath(project, 'init')
        let prompt = buildRootPrompt({ instruction: args.instruction, instructionFile: args.file, resultPath })
        let lastProblems: readonly string[] = []
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const raw = await runner.run({ label: 'ddog-init', prompt, resultPath, parent, signal: exec.signal })
          exec.signal.throwIfAborted()
          const submission = parseInitSubmission(raw)
          lastProblems = definitionProblems(submission.definition, args.instruction)
          if (lastProblems.length === 0) {
            const now = deps.now()
            const graph = createRootGraph({
              definition: submission.definition,
              input: { ...(args.file === undefined ? {} : { file: args.file }), text: args.instruction },
              now,
            })
            await store.save(graph)
            return jsonResult({
              graphId: graph.id,
              graphPath: store.graphPath,
              root: { id: graph.root, definition: submission.definition },
              rationale: submission.rationale,
            })
          }
          prompt = `${prompt}\n\n上一次提交不合格，按这些理由修正一次：\n${lastProblems.map(problem => `- ${problem}`).join('\n')}\n`
        }
        throw new Error(`agent produced an invalid root definition: ${lastProblems.join('; ')}`)
      },
    }),
    defineTool({
      name: DDOG_EXPAND_TOOL,
      description: 'Add candidate children under one DDoG node from real examples. Under the root this also records '
        + 'which candidates cover each root conjunct.',
      parameters: {
        parentId: { type: 'string', required: true, description: 'Node id to expand (use "root" for the first expansion).' },
        examples: { type: 'json', required: true, description: 'Array of example strings, one per real observation; numbering starts at 1.' },
        source: {
          type: 'string',
          enum: SOURCES,
          description: 'production for real feedback, simulation for examples invented while building the graph.',
        },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const project = projectDirectory(deps, exec.agent)
        const store = new DdogStore(project)
        const graph = await requireGraph(store)
        const parentNode = graph.nodes[args.parentId]
        if (parentNode === undefined) throw new Error(`no node ${args.parentId} in ${store.graphPath}`)
        const examples = asStringArray(args.examples, 'examples')
        const source = args.source ?? 'simulation'
        const existingChildren = childrenOf(graph, parentNode.id)
        const runner = deps.runner()
        const resultPath = await submissionPath(project, `expand-${parentNode.id}`)
        const prompt = buildExpandPrompt({
          parentId: parentNode.id,
          parentDefinition: parentNode.definition,
          parentLevel: parentNode.level,
          existingChildren: existingChildren.map(child => ({ id: child.id, definition: child.definition })),
          examples,
          source,
          isRoot: parentNode.kind === 'root',
          resultPath,
        })
        const raw = await runWithRetry(runner, {
          label: `ddog-expand-${parentNode.id}`,
          prompt,
          resultPath,
          parent: requireAgent(exec.agent),
          signal: exec.signal,
        }, attemptPrompt => parseExpansionSubmission(attemptPrompt, {
          parent: parentNode,
          existingIds: Object.keys(graph.nodes),
          existingDefinitions: Object.values(graph.nodes).map(node => node.definition),
          examples,
        }))
        exec.signal.throwIfAborted()
        const now = deps.now()
        let next = graph
        for (const draft of raw.candidates) {
          const node: DdogNode = {
            id: draft.key,
            definition: draft.definition,
            kind: 'candidate',
            parentId: draft.parent,
            level: draft.level,
            createdAt: now,
            candidate: {
              source,
              failureDescription: draft.rationale,
              ...(draft.exampleIndex === undefined ? {} : { exampleIndex: draft.exampleIndex }),
              ...(draft.trigger === undefined ? {} : { trigger: draft.trigger }),
              observations: [],
            },
          }
          next = withNode(next, node, now)
        }
        if (raw.rootSlots !== undefined) {
          next = { ...next, rootSlots: raw.rootSlots, updatedAt: now }
        }
        await store.save(next)
        return jsonResult({
          parentId: parentNode.id,
          added: raw.candidates.map(draft => ({ id: draft.key, level: draft.level, parent: draft.parent })),
          rootSlots: raw.rootSlots === undefined ? undefined : raw.rootSlots.length,
        })
      },
    }),
    defineTool({
      name: DDOG_RUN_TOOL,
      description: 'Judge one deliverable against every formal node and the root. Each target runs one session that '
        + 'also judges its direct candidates and retired children; thresholds then promote or retire nodes.',
      parameters: {
        target: { type: 'string', required: true, description: 'Absolute path of the deliverable to judge.' },
        runId: { type: 'string', description: 'Optional run id shared by every judgment in this pass.' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const project = projectDirectory(deps, exec.agent)
        const store = new DdogStore(project)
        const graph = await requireGraph(store)
        const thresholds = deps.thresholds()
        const parent = requireAgent(exec.agent)
        const runner = deps.runner()
        const runId = args.runId ?? `ddog-${String(Date.now())}`
        const targets = [graph.root, ...Object.values(graph.nodes)
          .filter(node => node.kind === 'formal')
          .map(node => node.id)]
        const verdicts: Record<string, string> = {}
        let working = graph
        for (const targetId of targets) {
          exec.signal.throwIfAborted()
          const target = working.nodes[targetId]
          if (target === undefined) continue
          const joint = jointChildrenOf(working, targetId)
          const formal = formalChildrenOf(working, targetId)
          const retirementPlan = formal
            .map(child => ({ child, cases: retirementCases(child, thresholds) }))
            .filter(entry => entry.cases.length > 0)
          const resultPath = await submissionPath(project, `judge-${targetId}`)
          const prompt = buildParentPrompt({
            parentId: target.id,
            parentDefinition: target.definition,
            parentLevel: target.level,
            targetPath: args.target,
            rootSlots: working.rootSlots ?? [],
            jointChildren: joint.map(child => ({
              id: child.id,
              definition: child.definition,
              kind: child.kind === 'retired' ? 'retired' : 'candidate',
            })),
            formalChildren: formal.map(child => ({ id: child.id, definition: child.definition })),
            retirementCases: retirementPlan.flatMap(entry =>
              entry.cases.map((observation, index) => ({
                index: index + 1,
                evidence: observation.evidence ?? '(no evidence recorded)',
              }))),
            resultPath,
          })
          const submission = await runWithRetry(runner, {
            label: `ddog-judge-${targetId}`,
            prompt,
            resultPath,
            parent,
            signal: exec.signal,
          }, attemptPrompt => parseParentSubmission(attemptPrompt, {
            jointIds: joint.map(child => child.id),
            retirementCaseCount: retirementPlan.reduce((total, entry) => total + entry.cases.length, 0),
          }))
          exec.signal.throwIfAborted()
          verdicts[targetId] = submission.verdict
          const now = deps.now()
          const at = now
          working = applyParentJudgment(working, target, joint, submission, retirementPlan, { runId, at, now }, thresholds)
          await store.save(working)
        }
        return jsonResult({
          runId,
          graphId: working.id,
          rootVerdict: verdicts[working.root] ?? 'inconclusive',
          verdicts,
          nodes: Object.values(working.nodes).map(node => ({ id: node.id, kind: node.kind, level: node.level })),
        })
      },
    }),
    defineTool({
      name: DDOG_STATUS_TOOL,
      description: 'Read the project DDoG graph: root definition, node counts, root slot coverage, and every node state.',
      parameters: {},
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        exec.signal.throwIfAborted()
        const project = projectDirectory(deps, exec.agent)
        const store = new DdogStore(project)
        const graph = await requireGraph(store)
        const counts: Record<string, number> = { root: 0, candidate: 0, formal: 0, retired: 0 }
        for (const node of Object.values(graph.nodes)) counts[node.kind] = (counts[node.kind] ?? 0) + 1
        return jsonResult({
          graphId: graph.id,
          graphPath: store.graphPath,
          root: { id: graph.root, definition: graph.nodes[graph.root]?.definition },
          counts,
          rootSlots: graph.rootSlots ?? [],
          nodes: Object.values(graph.nodes).map(node => ({
            id: node.id,
            kind: node.kind,
            level: node.level,
            parentId: node.parentId,
            definition: node.definition,
          })),
        })
      },
    }),
  ]
}

interface JudgmentContext {
  readonly runId: string
  readonly at: string
  readonly now: string
}

/**
 * Apply one parent submission: joint-child observations, the target's own
 * observation, retirement settlement, and any new candidates.
 */
function applyParentJudgment(
  graph: DdogGraph,
  target: DdogNode,
  joint: readonly DdogNode[],
  submission: ParentSubmission,
  retirementPlan: readonly { readonly child: DdogNode; readonly cases: readonly Observation[] }[],
  context: JudgmentContext,
  thresholds: DdogThresholds,
): DdogGraph {
  let next = graph
  for (const child of joint) {
    const reported = submission.candidates.find(candidate => candidate.id === child.id)
    if (reported === undefined) continue
    const current = next.nodes[child.id] ?? child
    const updated = applyObservation(current, {
      runId: context.runId,
      at: context.at,
      verdict: reported.verdict,
      ...(reported.evidence.length === 0 ? {} : { evidence: reported.evidence }),
    }, thresholds)
    next = withNode(next, updated, context.now)
  }
  if (target.kind !== 'root') {
    const current = next.nodes[target.id] ?? target
    const updated = applyObservation(current, {
      runId: context.runId,
      at: context.at,
      verdict: submission.verdict,
      ...(submission.evidence.length === 0 ? {} : { evidence: submission.evidence }),
    }, thresholds)
    next = withNode(next, updated, context.now)
  }
  let cursor = 0
  for (const entry of retirementPlan) {
    const count = entry.cases.length
    const slice = submission.retirementVerdicts.slice(cursor, cursor + count)
    cursor += count
    const current = next.nodes[entry.child.id]
    if (current === undefined || current.formal === undefined) continue
    const started: DdogNode = current.formal.retirement === undefined
      ? { ...current, formal: { ...current.formal, retirement: { startedAt: context.at, jointVerdicts: [] } } }
      : current
    try {
      next = withNode(next, applyRetirement(started, slice, thresholds, context.now), context.now)
    } catch {
      // Fewer decisive pairs than the minimum: keep the node as-is this round.
      next = withNode(next, started, context.now)
    }
  }
  if (submission.newCandidates.length > 0) {
    next = appendNewCandidates(next, target.id, submission.newCandidates, context.runId, context.now)
  }
  return next
}

async function runWithRetry<T>(
  runner: DdogSessionRunner,
  input: { readonly label: string; readonly prompt: string; readonly resultPath: string; readonly parent: Agent; readonly signal: AbortSignal },
  parse: (raw: unknown) => T,
): Promise<T> {
  const first = await runner.run(input)
  try {
    return parse(first)
  } catch (error) {
    if (!(error instanceof DdogSubmissionError)) throw error
    const reminder = `${input.prompt}\n\n上一次提交不合格，按这些理由修正后重新写文件：\n${error.problems.map(problem => `- ${problem}`).join('\n')}\n`
    return parse(await runner.run({ ...input, prompt: reminder }))
  }
}

function projectDirectory(deps: DdogToolDeps, agent: Agent | undefined): string {
  const sessionId = agent === undefined ? undefined : String(agent.id)
  const cwd = sessionId === undefined ? undefined : deps.sessions(sessionId)?.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error('ddog tools require a session working directory; this session has none')
  }
  return cwd
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('ddog tools require a live Agent session')
  return agent
}

async function requireGraph(store: DdogStore): Promise<DdogGraph> {
  const graph = await store.load()
  if (graph === undefined) throw new Error(`no DDoG graph at ${store.graphPath}; run ddog_init first`)
  return graph
}

async function submissionPath(project: string, label: string): Promise<string> {
  const directory = join(project, '.dsh', 'ddog', 'sessions', `${label}-${String(Date.now())}`)
  await mkdir(directory, { recursive: true })
  return join(directory, 'submission.json')
}

function asStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value as string[]
}

function jsonResult(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
