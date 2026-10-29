import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDdogGraph, type DdogGraph } from '../src/core/ddog-model.ts'
import { DdogStore } from '../src/core/ddog-store.ts'
import type { DdogSessionInput, DdogSessionRunner } from '../src/dsh/ddog-session.ts'
import {
  createDdogTools,
  DDOG_EXPAND_TOOL,
  DDOG_INIT_TOOL,
  DDOG_RUN_TOOL,
  DDOG_STATUS_TOOL,
} from '../src/dsh/ddog-tools.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const ROOT_DEFINITION = '学术论文是一种以可复核证据让读者相信并采用作者核心判断的论证文本。'
const TEMPORARY_ROOTS: string[] = []

afterEach(async () => {
  await Promise.all(TEMPORARY_ROOTS.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ddog-'))
  TEMPORARY_ROOTS.push(root)
  return root
}

function toolByName(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

interface Scripted {
  readonly init?: unknown
  readonly expand?: unknown
  readonly judge?: (input: DdogSessionInput) => unknown
}

async function callTool(
  tools: readonly ToolDefinition[],
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const tool = toolByName(tools, name)
  const exec = {
    agent: { id: 'session-1' } as unknown as Agent,
    signal: new AbortController().signal,
    callId: 'call-1',
  }
  const value = await tool.execute(args as never, exec as never)
  return value as Record<string, unknown>
}

async function readGraph(root: string): Promise<DdogGraph> {
  const store = new DdogStore(root)
  return parseDdogGraph(JSON.parse(await readFile(store.graphPath, 'utf8')))
}

describe('DDoG tools end to end', () => {
  it('initialises, expands, judges, promotes, and retires through the tool surface', async () => {
    const root = await project()
    let clock = Date.parse('2026-10-29T00:00:00.000Z')
    const script: Scripted = {
      init: { definition: ROOT_DEFINITION, rationale: '保留用户原话的语义空间' },
      expand: {
        candidates: [{
          key: 'evidence',
          definition: '论证的证据可以被独立复核。',
          parent: 'root',
          level: 1,
          exampleIndex: 1,
          trigger: '数据与代码不是同一版本',
          rationale: '对应“可复核”这处内涵，用版本错配的失败检验过',
        }],
        rootSlots: [{ slot: '以可复核证据', candidates: ['evidence'] }],
      },
      judge: input => input.prompt.includes('父节点：root')
        ? {
          verdict: 'fail',
          evidence: '论文正文引用的数据与附带的代码不是同一版本。',
          candidates: [{ id: 'evidence', verdict: 'fail', evidence: '脚本复算得不到正文数值。' }],
        }
        : { verdict: 'fail', evidence: '证据无法复算。', candidates: [] },
    }
    const runner: DdogSessionRunner = {
      async run(input) {
        const value = input.label.startsWith('ddog-init')
          ? script.init
          : input.label.startsWith('ddog-expand')
            ? script.expand
            : script.judge?.(input)
        await writeFile(input.resultPath, JSON.stringify(value), 'utf8')
        return value
      },
    }
    const tools = createDdogTools({
      sessions: sessionId => (sessionId === 'session-1' ? { cwd: root } : undefined),
      runner: () => runner,
      thresholds: () => ({
        promotionFailures: 2,
        promotionFailureRate: 0.2,
        retirementSuccessRate: 0.9,
        retirementConsistency: 0.8,
        retirementMinRuns: 5,
      }),
      now: () => new Date(clock += 1000).toISOString(),
    })

    const init = await callTool(tools, DDOG_INIT_TOOL, { instruction: '帮我写一篇好论文' })
    expect(init.root).toMatchObject({ id: 'root', definition: ROOT_DEFINITION })

    const expand = await callTool(tools, DDOG_EXPAND_TOOL, {
      parentId: 'root',
      examples: ['数据与代码不是同一版本'],
      source: 'production',
    })
    expect(expand.added).toEqual([{ id: 'evidence', level: 1, parent: 'root' }])
    expect((await readGraph(root)).rootSlots).toEqual([{ slot: '以可复核证据', candidates: ['evidence'] }])

    const target = join(root, 'paper.md')
    await writeFile(target, 'fallback', 'utf8')
    // Three decisive failures promote the candidate on the third pass.
    await callTool(tools, DDOG_RUN_TOOL, { target, runId: 'pass-1' })
    await callTool(tools, DDOG_RUN_TOOL, { target, runId: 'pass-2' })
    await callTool(tools, DDOG_RUN_TOOL, { target, runId: 'pass-3' })
    const promoted = await readGraph(root)
    expect(promoted.nodes.evidence?.kind).toBe('formal')
    expect(promoted.nodes.evidence?.formal?.observations).toHaveLength(3)

    const status = await callTool(tools, DDOG_STATUS_TOOL, {})
    expect(status.counts).toMatchObject({ root: 1, formal: 1, candidate: 0 })
  })

  it('refuses to initialise twice and reports a clear status before init', async () => {
    const root = await project()
    let clock = Date.parse('2026-10-29T00:00:00.000Z')
    const runner: DdogSessionRunner = {
      async run(input) {
        const value = { definition: ROOT_DEFINITION, rationale: '' }
        await writeFile(input.resultPath, JSON.stringify(value), 'utf8')
        return value
      },
    }
    const tools = createDdogTools({
      sessions: () => ({ cwd: root }),
      runner: () => runner,
      thresholds: () => ({
        promotionFailures: 2,
        promotionFailureRate: 0.2,
        retirementSuccessRate: 0.9,
        retirementConsistency: 0.8,
        retirementMinRuns: 5,
      }),
      now: () => new Date(clock += 1000).toISOString(),
    })
    await expect(callTool(tools, DDOG_STATUS_TOOL, {})).rejects.toThrow(/run ddog_init first/u)
    await callTool(tools, DDOG_INIT_TOOL, { instruction: '帮我写一篇好论文' })
    await expect(callTool(tools, DDOG_INIT_TOOL, { instruction: '帮我写一篇好论文' })).rejects.toThrow(/already has/u)
  })
})
