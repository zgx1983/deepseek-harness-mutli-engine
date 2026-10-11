import { describe, expect, it } from 'vitest'
import { modelServesEngine, providerServesEngine } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

const codexProvider: LlmProviderInfo = {
  id: 'openai',
  name: 'OpenAI',
  endpoints: [{ id: 'openai-compatible', name: 'OpenAI-compatible' }],
}

const nativeProvider: LlmProviderInfo = {
  id: 'deepseek',
  name: 'DeepSeek',
  endpoints: [{ id: 'deepseek-api', name: 'DeepSeek API' }],
}

const unadvertisedProvider: LlmProviderInfo = {
  id: 'custom',
  name: 'Custom',
}

function model(overrides: Partial<LlmModelInfo> = {}): LlmModelInfo {
  return { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o', ...overrides }
}

describe('providerServesEngine', () => {
  it('an engine that filters by endpoints reaches only advertising providers', () => {
    expect(providerServesEngine(codexProvider, ['openai-compatible'])).toBe(true)
    expect(providerServesEngine(nativeProvider, ['openai-compatible'])).toBe(false)
  })

  it('an engine that does not filter reaches every provider', () => {
    expect(providerServesEngine(codexProvider, [])).toBe(true)
    expect(providerServesEngine(nativeProvider, [])).toBe(true)
    expect(providerServesEngine(unadvertisedProvider, [])).toBe(true)
  })

  it('a provider that advertises no endpoint is not offered to a filtering engine', () => {
    expect(providerServesEngine(unadvertisedProvider, ['openai-compatible'])).toBe(false)
  })
})

describe('modelServesEngine', () => {
  it('an unfiltered engine offers every model', () => {
    expect(modelServesEngine(model(), codexProvider, [])).toBe(true)
  })

  it('a model without its own endpoints inherits the provider endpoints', () => {
    expect(modelServesEngine(model(), codexProvider, ['openai-compatible'])).toBe(true)
    expect(modelServesEngine(model(), codexProvider, ['deepseek-api'])).toBe(false)
  })

  it('an explicit model endpoint set narrows the provider endpoints', () => {
    const narrowed = model({ endpoints: ['deepseek-api'] })
    expect(modelServesEngine(narrowed, codexProvider, ['deepseek-api'])).toBe(true)
    expect(modelServesEngine(narrowed, codexProvider, ['openai-compatible'])).toBe(false)
  })
})
