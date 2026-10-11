import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, parseReasoningEfforts, resolveProfiles, type Options } from '../src/config.ts'

/** Validate one hand-declared route, with the caller's fields layered onto it. */
const routeWith = (profile: Record<string, unknown>): (() => unknown) =>
  () => ({ providers: Config({
    providers: {
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        ...profile,
      },
    },
  }).providers.get() })

/** Validate that route with the caller's fields on its single model entry. */
const configWith = (model: Record<string, unknown>): (() => unknown) =>
  routeWith({ models: [{ id: 'm', ...model }] })

describe('reasoning schema boundary', () => {
  it('accepts an empty provider section and propagates unexpected catalog failures', () => {
    expect(() => { assertServiceable({}) }).not.toThrow()
    const failure = new TypeError('model metadata lookup failed')
    expect(() => resolveProfiles({ openrouter: { models: [{
      id: '111',
      get name(): string { throw failure },
    }], api: 'openai-completions' } }, 'deferred')).toThrow(failure)
  })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })

  it('accepts Baseten template arguments and completion controls', () => {
    expect(configWith({
      compat: {
        supportsFinishReason: false,
        thinkingFormat: 'baseten',
        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        supportsThinkingTokenBudget: true,
      },
    })).not.toThrow()
  })
})

describe('modality schema boundary', () => {
  it('rejects a modality pi-ai does not know, at either level', () => {
    expect(configWith({ input: ['audio'] })).toThrow(/expected/)
    expect(routeWith({ defaultInput: ['text', 'audio'] })).toThrow(/expected/)
  })

  it('refuses a route whose models could accept nothing', () => {
    // The pair the settings seam runs: the schema accepts the empty list as
    // well-typed, and the namespace validator is what refuses it. Asserting
    // only the schema would report this route as writable.
    expect(routeWith({ defaultInput: [] })).not.toThrow()
    expect(() => { assertServiceable(routeWith({ defaultInput: [] })() as Options) })
      .toThrow(/defaultInput must name at least one modality/)
  })

  type Materialized = {
    providers: Record<string, { defaultInput?: unknown; models?: { input?: unknown }[] }>
  }

  it('materializes an absent entry list as empty and an absent route list as text', () => {
    // The empty-list inheritance rule exists because of exactly this: an entry
    // that declares nothing reaches resolution as `[]`, not as `undefined`.
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.input).toEqual([])
    expect(absent.providers['acme-gateway']?.defaultInput).toEqual(['text'])
  })
})

describe('request image policy bounds', () => {
  it.each([
    ['requestImagePixelBudget', 0, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /requestImagePixelBudget must be a positive safe integer/],
    ['requestImageMaxBytes', 0, /requestImageMaxBytes must be a positive safe integer/],
    ['requestImageMaxBytes', 1.5, /requestImageMaxBytes must be a positive safe integer/],
  ] as const)('rejects %s=%s at service resolution', (field, value, message) => {
    const programmatic = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: value,
        },
      },
    } as Options
    expect(() => {
      assertServiceable(programmatic)
    }).toThrow(message)
  })
})

describe('engine URL schema boundary', () => {
  it.each(['claudeCodeURL', 'codexURL'] as const)('rejects invalid %s values at settings validation', (field) => {
    for (const value of ['   ', 'not-a-url', 'file:///tmp/api', 'ftp://example.test', ' https://example.test ']) {
      const options = routeWith({ [field]: value })() as Options
      expect(() => { assertServiceable(options) }).toThrow(/must be an HTTP or HTTPS URL/)
    }
    for (const value of ['http://localhost:1234/v1', 'https://example.test/api']) {
      expect(() => { assertServiceable(routeWith({ [field]: value })() as Options) }).not.toThrow()
    }
  })

  it.each([
    ['claudeCodeURL', /provider "acme-gateway" has an empty claudeCodeURL/],
    ['codexURL', /provider "acme-gateway" has an empty codexURL/],
  ] as const)('rejects an empty %s while leaving omission serviceable', (field, message) => {
    const empty = {
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm' }],
          [field]: '',
        },
      },
    } as Options
    expect(() => { assertServiceable(empty) }).toThrow(message)

    // Both fields are optional: a route without them resolves and the schema
    // materializes neither key.
    const omitted = routeWith({})() as {
      providers: Record<string, { claudeCodeURL?: unknown; codexURL?: unknown }>
    }
    expect(omitted.providers['acme-gateway']?.claudeCodeURL).toBeUndefined()
    expect(omitted.providers['acme-gateway']?.codexURL).toBeUndefined()
  })
})

describe('route reasoning efforts', () => {
  it('parses space- and comma-separated tokens, keeping first duplicates', () => {
    expect(parseReasoningEfforts('acme', 'low high')).toEqual(['low', 'high'])
    expect(parseReasoningEfforts('acme', 'minimal,low,  medium , high')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(parseReasoningEfforts('acme', 'off low low')).toEqual(['off', 'low'])
  })

  it('rejects a list that names no level, or `off` alone', () => {
    expect(() => parseReasoningEfforts('acme', '  ')).toThrow(/names no level/)
    expect(() => parseReasoningEfforts('acme', ', ,')).toThrow(/names no level/)
    expect(() => parseReasoningEfforts('acme', 'off')).toThrow(/no level beyond "off"/)
    expect(() => parseReasoningEfforts('acme', 'low turbo')).toThrow(/names "turbo", which is not a thinking level/)
  })

  it('resolves the configured string to tokens and refuses a separator-only one at load', () => {
    const resolved = resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        reasoningEfforts: 'low  high, off',
        models: [{ id: 'm' }],
      },
    })
    expect(resolved.get('acme-gateway')?.reasoningEfforts).toEqual(['low', 'high', 'off'])
    expect(resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
      },
    }).get('acme-gateway')?.reasoningEfforts).toBeUndefined()
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        reasoningEfforts: ' , ',
        models: [{ id: 'm' }],
      },
    })).toThrow(/names no level/)
  })
})
