import { describe, expect, it } from 'vitest'
import { definitionProblems, isOneSentence, sharedSubstring } from '../src/core/ddog-definition.ts'
import {
  applyObservation,
  applyRetirement,
  appendNewCandidates,
  DEFAULT_DDOG_THRESHOLDS,
  retirementCases,
  retirementConsistency,
  shouldPromote,
  verdictStats,
} from '../src/core/ddog-lifecycle.ts'
import {
  createRootGraph,
  parseDdogGraph,
  type DdogGraph,
  type DdogNode,
  type DdogVerdict,
  type Observation,
} from '../src/core/ddog-model.ts'

const NOW = '2026-10-29T00:00:00.000Z'

function observation(index: number, verdict: 'pass' | 'fail' | 'inconclusive'): Observation {
  return { runId: `run-${String(index)}`, at: NOW, verdict }
}

function rootGraph(): DdogGraph {
  return createRootGraph({
    definition: '学术论文是一种以可复核证据让读者相信并采用作者核心判断的论证文本。',
    input: { text: '写一篇好论文' },
    now: NOW,
  })
}

function candidateNode(id: string, observations: readonly Observation[]): DdogNode {
  return {
    id,
    definition: '论证的可复核性。',
    kind: 'candidate',
    parentId: 'root',
    level: 1,
    createdAt: NOW,
    candidate: { source: 'simulation', failureDescription: '数据与代码不是同一版本', observations },
  }
}

function formalNode(observations: readonly Observation[]): DdogNode {
  return {
    id: 'leaf',
    definition: '证据可获取。',
    kind: 'formal',
    parentId: 'root',
    level: 1,
    createdAt: NOW,
    formal: { observations },
  }
}

describe('DDoG model', () => {
  it('round-trips the root graph through the parser', () => {
    const graph = rootGraph()
    expect(parseDdogGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph)
    expect(graph.nodes.root?.kind).toBe('root')
  })

  it('rejects a node whose level does not follow its parent', () => {
    const graph = rootGraph()
    const broken = {
      ...graph,
      nodes: { ...graph.nodes, leaf: { ...candidateNode('leaf', []), level: 3 } },
    }
    expect(() => parseDdogGraph(broken)).toThrow(/level: expected 1/u)
  })

  it('rejects a parent cycle', () => {
    const graph = rootGraph()
    const broken = {
      ...graph,
      nodes: {
        ...graph.nodes,
        a: { ...candidateNode('a', []), parentId: 'b' },
        b: { ...candidateNode('b', []), parentId: 'a' },
      },
    }
    expect(() => parseDdogGraph(broken)).toThrow(/cycle/u)
  })

  it('requires candidate state on candidate nodes', () => {
    const graph = rootGraph()
    const node = candidateNode('leaf', [])
    const broken = { ...graph, nodes: { ...graph.nodes, leaf: { ...node, candidate: undefined } } }
    expect(() => parseDdogGraph(broken)).toThrow(/candidate: required/u)
  })
})

describe('DDoG lifecycle', () => {
  it('counts only decisive judgments', () => {
    expect(verdictStats([observation(1, 'pass'), observation(2, 'inconclusive'), observation(3, 'fail')]))
      .toEqual({ total: 2, pass: 1, fail: 1, failureRate: 0.5 })
  })

  it('promotes after the third decisive failure but not at exactly the failure rate', () => {
    expect(shouldPromote([observation(1, 'fail'), observation(2, 'fail')])).toBe(false)
    expect(shouldPromote([observation(1, 'fail'), observation(2, 'fail'), observation(3, 'fail')])).toBe(true)
    const diluted = [
      ...Array.from({ length: 17 }, (_, index) => observation(index, 'pass')),
      observation(20, 'fail'),
      observation(21, 'fail'),
      observation(22, 'fail'),
    ]
    expect(shouldPromote(diluted)).toBe(false)
  })

  it('turns a promoted candidate into a formal node and keeps its history', () => {
    const node = candidateNode('leaf', [observation(1, 'fail'), observation(2, 'fail')])
    const promoted = applyObservation(node, observation(3, 'fail'))
    expect(promoted.kind).toBe('formal')
    expect(promoted.candidate).toBeUndefined()
    expect(promoted.formal?.observations).toHaveLength(3)
  })

  it('starts retirement strictly above a 90 percent pass rate', () => {
    const passes = (count: number): Observation[] =>
      Array.from({ length: count }, (_, index) => observation(index, 'pass'))
    const above = applyObservation(formalNode(passes(10)), observation(11, 'fail'))
    expect(above.formal?.retirement?.startedAt).toBe(NOW)
    const atLimit = applyObservation(formalNode(passes(9)), observation(10, 'fail'))
    expect(atLimit.formal?.retirement).toBeUndefined()
  })

  it('measures agreement against the child past failures', () => {
    const fails = (count: number): DdogVerdict[] => Array.from({ length: count }, () => 'fail')
    const passes = (count: number): DdogVerdict[] => Array.from({ length: count }, () => 'pass')
    const mixed = (count: number, passShare: number): DdogVerdict[] =>
      Array.from({ length: count }, (_, index) => (index / count < passShare ? 'pass' : 'fail'))
    expect(retirementConsistency(fails(10), fails(10), 5)).toBeCloseTo(1, 5)
    expect(retirementConsistency(passes(10), fails(10), 5)).toBeCloseTo(0, 5)
    expect(retirementConsistency(mixed(10, 0.1), fails(10), 5)).toBeGreaterThan(0.8)
    expect(retirementConsistency(mixed(10, 0.5), fails(10), 5)).toBeLessThan(0.8)
    expect(retirementConsistency(['pass', 'fail'], ['fail', 'fail'], 5)).toBeUndefined()
  })

  it('retires a node the parent also fails, and refuses too few paired judgments', () => {
    const observations = Array.from({ length: 10 }, (_, index) => observation(index, 'pass'))
    const retirable = formalNode(observations)
    const started: DdogNode = {
      ...retirable,
      formal: { observations, retirement: { startedAt: NOW, jointVerdicts: [] } },
    }
    const settled = applyRetirement(started, Array.from({ length: 10 }, () => 'fail' as const), DEFAULT_DDOG_THRESHOLDS, NOW)
    expect(settled.kind).toBe('retired')
    expect(settled.formal?.retirement?.retiredAt).toBe(NOW)

    expect(() => applyRetirement(started, ['fail', 'fail'], DEFAULT_DDOG_THRESHOLDS, NOW)).toThrow(/paired verdicts/u)
  })

  it('appends production candidates under the parent and rejects duplicates', () => {
    const graph = rootGraph()
    const next = appendNewCandidates(graph, 'root', [{ definition: '证据可获取。', evidence: '缺原始数据' }], 'run-1', NOW)
    const added = Object.values(next.nodes).find(node => node.kind === 'candidate')
    expect(added?.level).toBe(1)
    expect(added?.candidate?.source).toBe('production')
    expect(added?.candidate?.observations.map(item => item.verdict)).toEqual(['fail'])
    expect(() => appendNewCandidates(next, 'root', [{ definition: '证据可获取。', evidence: '再次' }], 'run-2', NOW))
      .toThrow(/already exists/u)
  })

  it('offers past failures only while a child is being evaluated', () => {
    const failures = Array.from({ length: 5 }, (_, index) => observation(index, 'fail'))
    const notEvaluating = formalNode(failures)
    expect(retirementCases(notEvaluating)).toEqual([])
    const evaluating: DdogNode = {
      ...notEvaluating,
      formal: { observations: failures, retirement: { startedAt: NOW, jointVerdicts: [] } },
    }
    expect(retirementCases(evaluating)).toHaveLength(5)
  })
})

describe('DDoG definitions', () => {
  it('accepts one sentence with a defining predicate and a shared fragment', () => {
    const text = '学术论文是一种以可复核证据让读者相信并采用作者核心判断的论证文本。'
    expect(isOneSentence(text)).toBe(true)
    expect(sharedSubstring(text, '我要一篇好论文')).toBe('论文')
    expect(definitionProblems(text, '我要一篇好论文')).toEqual([])
  })

  it('rejects extra sentences, missing predicates, short text, and no shared fragment', () => {
    expect(definitionProblems('论文要好。还要短。', '论文')).toContain(
      'definition must be exactly one sentence ending in sentence punctuation',
    )
    expect(definitionProblems('这是一篇读起来让人觉得作者很认真的长文章。', '别的需求'))
      .toContain('definition must share at least a two-character fragment with the user instruction')
    expect(definitionProblems('文章质量高。', '文章'))!.toContain('definition must be at least 20 characters')
  })
})
