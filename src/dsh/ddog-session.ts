/**
 * One DDoG session: spawn a child Agent, have it write a JSON submission, read it back.
 *
 * The child never returns a structured payload over the wire; the file is the
 * contract, which keeps the parent turn free of stray notifications.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { readFile } from 'node:fs/promises'

export interface DdogSessionInput {
  readonly label: string
  readonly prompt: string
  readonly resultPath: string
  readonly parent: Agent
  readonly signal: AbortSignal
}

export interface DdogSessionRunner {
  run(input: DdogSessionInput): Promise<unknown>
}

export interface DdogSessionRunnerOptions {
  readonly subagents: SubagentRuntime
  readonly provider: () => string
  readonly maxDepth: () => number
  /** Total wait for one submission; defaults to fifteen minutes. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const POLL_INTERVAL_MS = 250

/** Build the runner that owns activation lifetime and submission waiting. */
export function createDdogSessionRunner(options: DdogSessionRunnerOptions): DdogSessionRunner {
  return {
    async run(input) {
      const resultPath = input.resultPath
      const started = await options.subagents.startActivation({
        provider: options.provider(),
        label: input.label,
        request: {
          prompt: [{ type: 'text', text: input.prompt }],
          parent: input.parent,
          maxDepth: options.maxDepth(),
        },
        signal: input.signal,
        // The parent collects the submission itself; a completion notice would
        // land as a stray turn in the middle of the tool call.
        delivery: 'caller',
      })
      let settled = false
      void started.result.then(() => { settled = true }, () => { settled = true })
      try {
        return await waitForSubmission(
          resultPath,
          input.signal,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          () => settled,
        )
      } finally {
        await started.dispose().catch(() => undefined)
      }
    },
  }
}

async function waitForSubmission(
  resultPath: string,
  signal: AbortSignal,
  timeoutMs: number,
  childSettled: () => boolean,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) throw new Error('ddog session aborted before writing its submission')
    const text = await readIfPresent(resultPath)
    if (text !== undefined) return parseSubmissionText(text, resultPath)
    if (childSettled()) {
      const last = await readIfPresent(resultPath)
      if (last !== undefined) return parseSubmissionText(last, resultPath)
      throw new Error(`the ddog session finished without writing ${resultPath}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ddog submission at ${resultPath}`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, POLL_INTERVAL_MS)
    await promise
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Parse a submission file, tolerating markdown fences around the JSON object. */
function parseSubmissionText(text: string, path: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error(`ddog submission at ${path} is not JSON`)
  }
}
