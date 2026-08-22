/** Mutually exclusive isolated workspaces: one per verification, never shared, never merged. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IsolatedWorkspace } from './verifiers.ts'

export interface WorkspaceOptions {
  readonly baseDir?: string
}

export class WorkspaceManager {
  private readonly baseDir: string
  private readonly pending = new Set<Promise<void>>()

  constructor(options: WorkspaceOptions = {}) {
    this.baseDir = options.baseDir ?? join(tmpdir(), 'dsh-dog-workspaces')
  }

  /** Allocate one mutually exclusive workspace directory. */
  async acquire(): Promise<IsolatedWorkspace> {
    await mkdir(this.baseDir, { recursive: true })
    const path = await mkdtemp(join(this.baseDir, `${randomUUID()}-`))
    return { path }
  }

  /** Release a workspace after verification completes; contents are discarded. */
  async release(workspace: IsolatedWorkspace): Promise<void> {
    const removal = rm(workspace.path, { recursive: true, force: true }).catch(() => undefined)
    const tracked = removal.finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
    await tracked
  }

  /** Wait for every in-flight release (host shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }
}
