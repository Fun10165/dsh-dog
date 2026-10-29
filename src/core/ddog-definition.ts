/** Definition checks shared by the DDoG entry points. */

const SENTENCE_END = /[。.!?！？]/gu
const DEFINITION_PREDICATE = /[是指作为即意味着]|:/u
const MEANINGFUL = /[\p{L}\p{N}]/u

export interface DefinitionCheckOptions {
  /** Require a shared fragment with the user instruction (default true). */
  readonly requireKeyword?: boolean
}

/** True when the text is exactly one sentence ending in sentence punctuation. */
export function isOneSentence(text: string): boolean {
  const endings = [...text.matchAll(SENTENCE_END)]
  if (endings.length !== 1) return false
  const last = endings[0]
  return last !== undefined && last.index === text.length - 1
}

/**
 * Longest fragment shared with the instruction that carries a letter or digit.
 * Scans down from twelve characters to two.
 *
 * @returns the fragment, or the empty string when nothing is shared.
 */
export function sharedSubstring(definition: string, inputText: string): string {
  const max = Math.min(definition.length, 12)
  for (let size = max; size >= 2; size -= 1) {
    for (let start = 0; start + size <= definition.length; start += 1) {
      const fragment = definition.slice(start, start + size)
      if (MEANINGFUL.test(fragment) && inputText.includes(fragment)) return fragment
    }
  }
  return ''
}

/**
 * Root definition gate: one sentence, at least twenty characters, a definition
 * predicate, and a shared fragment with the user instruction.
 *
 * @returns the reasons the definition is rejected; empty means accepted.
 */
export function definitionProblems(
  definition: string,
  inputText: string,
  options: DefinitionCheckOptions = {},
): readonly string[] {
  const text = definition.trim()
  const problems: string[] = []
  if (text.length === 0) problems.push('definition is empty')
  if (!isOneSentence(text)) problems.push('definition must be exactly one sentence ending in sentence punctuation')
  if (text.length < 20) problems.push('definition must be at least 20 characters')
  if (!DEFINITION_PREDICATE.test(text)) problems.push('definition must contain a defining predicate (是/指/作为/即/意味着/:)')
  if (options.requireKeyword !== false && sharedSubstring(text, inputText).length < 2) {
    problems.push('definition must share at least a two-character fragment with the user instruction')
  }
  return problems
}
