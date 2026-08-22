/** Shared test helpers: make v0.1-era fixtures legal under the §4 agentic rule. */

import type { DogGraphInput } from '../src/model.ts'

/**
 * Inject an agentic audit leaf under every composite whose children are all
 * programmatic. The audit is required:false / tolerable and is not referenced
 * by any completion expression, so it never affects composite or root
 * settlement — it only makes the graph legal under the programmatic-subtree
 * rule. When no agentic runner is installed the audit settles inconclusive.
 */
export function injectAgenticAudit(graph: DogGraphInput): DogGraphInput {
 const firstArtifactId = Object.values(graph.nodes)
  .flatMap(node => Object.entries(node.verifierParams ?? {}))
  .find(([key]) => key === 'artifactId')?.[1] as string | undefined
 const artifactId = typeof firstArtifactId === 'string' && firstArtifactId.length > 0 ? firstArtifactId : 'artifact'
 const parentIds = new Set(graph.contains.map(edge => edge.parent))
 const compositeIds = Object.entries(graph.nodes)
  .filter(([, node]) => node.kind === 'composite')
  .map(([id]) => id)
 const needsAudit = compositeIds.filter(id => parentIds.has(id) || id === graph.root)
 const nodes = { ...graph.nodes }
 const contains = [...graph.contains]
 for (const parent of needsAudit) {
  const children = graph.contains.filter(edge => edge.parent === parent).map(edge => edge.child)
  if (children.length === 0) continue
  if (children.some(child => graph.nodes[child]?.kind === 'leaf' && graph.nodes[child]?.verifier?.id === 'vision.overlap')) continue
  const auditId = `agentic-audit-${parent}`
  if (nodes[auditId] !== undefined) continue
  nodes[auditId] = {
   kind: 'leaf',
   title: `Agentic audit for ${parent}`,
   constraint: 'hard',
   verifier: { id: 'vision.overlap', version: '1' },
   verifierParams: { artifactId },
  }
  contains.push({ parent, child: auditId, required: false, failure: 'tolerable' })
 }
 return { ...graph, nodes, contains }
}
