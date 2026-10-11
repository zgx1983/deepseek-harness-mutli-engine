/** The thinking-levels field shared by the provider create and edit forms. */

/**
 * The levels a thinking-levels field may name, in escalation order — the
 * thinking-level vocabulary the adapter parses and every request dialect
 * speaks (`pi-ai`'s `THINKING_LEVELS`).
 */
const VALID_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Parse the field's free-form string into level tokens. Separators are
 * spaces or commas; duplicates keep their first position. A blank string
 * yields no tokens, which both forms read as "unset — the adapter defaults".
 * @param raw - the field's current text.
 * @returns the level tokens in typed order.
 */
export function thinkingLevelTokens(raw: string): readonly string[] {
  return [...new Set(raw.split(/[\s,]+/u).filter(token => token.length > 0))]
}

/**
 * Name the field's problem for the copy dictionary, or accept the text.
 * @param raw - the field's current text.
 * @returns the failure copy key, or undefined when the field may be saved.
 */
export function thinkingLevelsFailure(raw: string): 'thinkingLevelsInvalid' | undefined {
  const tokens = thinkingLevelTokens(raw)
  if (tokens.length === 0) return 'thinkingLevelsInvalid'
  if (tokens.some(token => !VALID_LEVELS.includes(token))) return 'thinkingLevelsInvalid'
  return undefined
}
