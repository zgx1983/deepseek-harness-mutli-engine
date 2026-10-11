import { describe, expect, it } from 'vitest'
import { impliedDefaultEffort, ReasoningEffortId, type LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'

function effort(id: string): LlmReasoningEffortInfo {
  return { id: ReasoningEffortId(id), name: id }
}

describe('impliedDefaultEffort', () => {
  it('names the strongest offered level', () => {
    expect(impliedDefaultEffort([effort('off'), effort('high'), effort('medium')]))
      .toBe(ReasoningEffortId('high'))
    expect(impliedDefaultEffort([effort('off'), effort('high'), effort('xhigh')]))
      .toBe(ReasoningEffortId('xhigh'))
  })

  it('matches ids case-insensitively and keeps the offered spelling', () => {
    expect(impliedDefaultEffort([effort('High')])).toBe(ReasoningEffortId('High'))
    expect(impliedDefaultEffort([effort('HIGH'), effort('XHigh')])).toBe(ReasoningEffortId('XHigh'))
  })

  it('names none when the route offers neither level', () => {
    expect(impliedDefaultEffort([])).toBeUndefined()
    expect(impliedDefaultEffort([effort('off'), effort('low'), effort('medium')])).toBeUndefined()
    expect(impliedDefaultEffort([effort('maximum')])).toBeUndefined()
  })
})
