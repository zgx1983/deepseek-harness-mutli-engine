/**
 * Implied default reasoning level for adapter metadata that offers levels but
 * names no default of its own.
 */
import type { ReasoningEffortId } from './brand.ts'
import type { LlmReasoningEffortInfo } from './types.ts'

/**
 * Selectable ids that stand in for an undeclared provider default, strongest
 * first. Ids compare lowercased, so a route may spell a level `High`.
 */
const IMPLIED_DEFAULT_EFFORTS = ['xhigh', 'high'] as const

/**
 * Name the level a request lands on when it omits an effort and the adapter
 * declared no default. Claude, Codex, and OpenAI-compatible gateways run
 * their own model default at these levels, so an omitted effort reaches one
 * of them; a route that offers neither keeps the provider's unnamed default.
 * @param efforts - validated selectable efforts for one exact route.
 * @returns the implied default id, or undefined when neither level is offered.
 */
export function impliedDefaultEffort(
  efforts: readonly LlmReasoningEffortInfo[],
): ReasoningEffortId | undefined {
  for (const candidate of IMPLIED_DEFAULT_EFFORTS) {
    const match = efforts.find(effort => effort.id.toLowerCase() === candidate)
    if (match !== undefined) return match.id
  }
  return undefined
}
