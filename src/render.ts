/** Host-side page renderer: pptx snapshot -> one PNG per slide inside the verifier workspace. */

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RenderedPages {
  readonly pages: readonly string[]
  readonly ok: boolean
  readonly detail: string
}

const RENDER_SCRIPT = new URL('../../scripts/render_deck.py', import.meta.url).pathname

/** Render deck.pptx bytes (already written to inputPath) to slide-N.png inside the workspace. */
export async function renderDeckPages(inputPath: string, workspacePath: string): Promise<RenderedPages> {
  try {
    await execFileAsync('/opt/homebrew/bin/uv', [
      'run', '--with', 'python-pptx', 'python3', RENDER_SCRIPT, inputPath, workspacePath,
    ], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
    const entries = await readdir(workspacePath)
    const pages = entries
      .filter(name => /^slide-\d+\.png$/u.test(name))
      .sort((left, right) => Number(left.match(/\d+/u)?.[0] ?? 0) - Number(right.match(/\d+/u)?.[0] ?? 0))
      .map(name => join(workspacePath, name))
    if (pages.length === 0) return { pages: [], ok: false, detail: 'renderer produced no pages' }
    return { pages, ok: true, detail: `rendered ${pages.length} pages` }
  } catch (cause) {
    return { pages: [], ok: false, detail: String(cause).slice(0, 512) }
  }
}
