/**
 * Project-scoped DDoG storage.
 *
 * DDoG belongs to the project it judges, so its graph lives inside the working
 * directory rather than under the harness home: `<project>/.dsh/ddog/graph.json`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDdogGraph, type DdogGraph } from './ddog-model.ts'

export class DdogStore {
  readonly graphPath: string

  /**
   * @param projectDirectory - absolute project directory the graph belongs to.
   */
  constructor(projectDirectory: string) {
    this.graphPath = join(projectDirectory, '.dsh', 'ddog', 'graph.json')
  }

  /**
   * Read the graph.
   * @returns the validated graph, or undefined when the project has none yet.
   * @throws DogValidationError when the stored graph is corrupt.
   */
  async load(): Promise<DdogGraph | undefined> {
    let source: string
    try {
      source = await readFile(this.graphPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    return parseDdogGraph(JSON.parse(source))
  }

  /** Write the graph atomically: a temporary sibling, then rename over the target. */
  async save(graph: DdogGraph): Promise<void> {
    await mkdir(dirname(this.graphPath), { recursive: true })
    const temporary = `${this.graphPath}.tmp.${String(process.pid)}.${String(Date.now())}`
    await writeFile(temporary, `${JSON.stringify(graph, null, 1)}\n`, 'utf8')
    await rename(temporary, this.graphPath)
  }
}
