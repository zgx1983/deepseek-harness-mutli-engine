/** Engine reasoning mappings preserve selectable ids and validate native parameters. */
import { expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { mapEngineReasoning, resolveEngineEffort } from '../src/engine-reasoning.ts'

const source = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off', wireValue: null },
    { id: ReasoningEffortId('minimal'), name: 'Minimal' },
    { id: ReasoningEffortId('max'), name: 'Maximum', wireValue: 'xhigh' },
  ], defaultEffort: ReasoningEffortId('max'),
}

it('filters unsupported engine parameters and inherits the mapped model default', () => {
  const result = mapEngineReasoning(source, {}, value => value === 'xhigh', null)
  expect(result?.efforts.map(effort => effort.id)).toEqual(['off', 'max'])
  expect(resolveEngineEffort(result)).toBe('xhigh')
  expect(resolveEngineEffort(result, 'off')).toBeNull()
  expect(() => resolveEngineEffort(result, 'minimal')).toThrow('does not support')
})

it('uses explicit model mappings and resolves the engine disabled parameter', () => {
  const result = mapEngineReasoning(source, { reasoningEfforts: { off: null, minimal: 'low' }, defaultReasoningEffort: 'minimal' }, () => true, 'none')
  expect(resolveEngineEffort(result)).toBe('low')
  expect(resolveEngineEffort(result, 'off')).toBe('none')
  expect(() => resolveEngineEffort(result, 'max')).toThrow('does not support')
})

it('rejects invalid configured mappings and defaults', () => {
  expect(() => mapEngineReasoning(source, { reasoningEfforts: { max: 'invalid' } }, () => false, null)).toThrow('Unsupported engine reasoning mapping')
  expect(() => mapEngineReasoning(source, { defaultReasoningEffort: 'missing' }, () => true, null)).toThrow('is not offered')
  expect(resolveEngineEffort(undefined)).toBeUndefined()
  expect(() => resolveEngineEffort(undefined, 'high')).toThrow('does not support')
})

it('names the strongest offered level when neither the deployment nor the adapter declared one', () => {
  const unmapped = mapEngineReasoning(undefined, { reasoningEfforts: { off: null, medium: 'medium', high: 'high' } }, () => true, 'none')
  expect(unmapped?.defaultEffort).toBe('high')
  expect(resolveEngineEffort(unmapped)).toBe('high')

  const strongest = mapEngineReasoning(undefined, { reasoningEfforts: { off: null, high: 'high', xhigh: 'xhigh' } }, () => true, 'none')
  expect(strongest?.defaultEffort).toBe('xhigh')

  const undeclared = mapEngineReasoning(undefined, { reasoningEfforts: { off: null, low: 'low', medium: 'medium' } }, () => true, 'none')
  expect(undeclared?.defaultEffort).toBeUndefined()
  expect(resolveEngineEffort(undeclared)).toBeUndefined()

  // An adapter default the engine mapping cannot offer yields to the mapped
  // level set rather than to the adapter's dropped id.
  const remapped = mapEngineReasoning(source, { reasoningEfforts: { off: null, high: 'high' } }, () => true, 'none')
  expect(remapped?.defaultEffort).toBe('high')
})
