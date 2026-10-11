import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveCodexProviderSpec, CodexProviderOptionsSchema } from '../src/provider-config.ts'

describe('Codex route-specific native settings', () => {
  it('maps selected model metadata, retries and private headers without credentials in argv', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => ({ value: 'header-secret', source: 'fixture' }) } as never)
    const spec = await resolveCodexProviderSpec(ctx, { provider: 'gateway', baseUrl: 'https://gateway.test/v1',
      credential: { ref: 'KEY', value: 'api-secret' } }, 'model-b', {
      subagentModel: 'small-model', subagentReasoningEffort: 'low',
      httpHeaders: { 'X-Tenant': 'tenant-a' }, headerCredentialRefs: { 'api-key': 'GATEWAY_KEY' },
      queryParams: { 'api-version': '2026-01-01' }, requestMaxRetries: 0, streamMaxRetries: 2,
      streamIdleTimeoutMs: 45000, supportsWebsockets: false, modelContextWindow: 200000,
      models: { 'model-b': { modelContextWindow: 1000000, modelReasoningSummary: 'none', modelVerbosity: 'low' } },
    })
    expect(spec.configArgs).toEqual(expect.arrayContaining([
      'model_providers.dsh_engine.request_max_retries=0', 'model_providers.dsh_engine.stream_max_retries=2',
      'model_providers.dsh_engine.stream_idle_timeout_ms=45000', 'model_providers.dsh_engine.supports_websockets=false',
      'model_providers.dsh_engine.query_params."api-version"="2026-01-01"',
      'agents.default_subagent_model="small-model"', 'agents.default_subagent_reasoning_effort="low"',
      'model_context_window=1000000', 'model_reasoning_summary="none"', 'model_verbosity="low"',
    ]))
    expect(Object.values(spec.env)).toEqual(expect.arrayContaining(['api-secret', 'header-secret', 'tenant-a']))
    expect(spec.configArgs.join(' ')).not.toMatch(/api-secret|header-secret|tenant-a/)
  })

  it('leaves absent extras to native defaults', async () => {
    const spec = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm')
    expect(spec.env).toEqual({})
    expect(spec.configArgs).not.toEqual(expect.arrayContaining([expect.stringContaining('request_max_retries')]))
  })

  it('rejects a missing header credential instead of dropping authentication', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    await expect(resolveCodexProviderSpec(ctx, { provider: 'p', baseUrl: 'https://p.test' }, 'm', {
      headerCredentialRefs: { 'api-key': 'MISSING' },
    })).rejects.toThrow('Missing Codex header credential')
  })

  it.each([{ httpHeaders: { 'bad header': 'value' } }, { httpHeaders: { X: 'bad\r\nvalue' } },
    { httpHeaders: { X: 'one', x: 'two' } }, { httpHeaders: { X: 'one' }, headerCredentialRefs: { x: 'KEY' } },
  ])('rejects invalid or conflicting headers %j', async (options) => {
    await expect(resolveCodexProviderSpec(new Context(), { provider: 'p', baseUrl: 'https://p.test' }, 'm', options)).rejects.toThrow()
  })

  it.each([{ requestMaxRetries: -1 }, { streamIdleTimeoutMs: 0 }, { modelContextWindow: 1.5 },
    { modelReasoningSummary: 'unsupported' }, { models: { m: { modelAutoCompactTokenLimit: -1 } } },
  ])('rejects invalid native settings at configuration parsing %j', (options) => {
    expect(() => CodexProviderOptionsSchema(options as never)).toThrow()
  })
})

describe('Codex resolved model limits', () => {
  it('passes the resolved context window and derives the auto-compaction limit', async () => {
    const spec = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm', {},
      { contextWindow: 256_000 })

    expect(spec.configArgs).toEqual(expect.arrayContaining([
      'model_context_window=256000', 'model_auto_compact_token_limit=230400',
    ]))
  })

  it('lets route configuration and an exact-model override pin both limits', async () => {
    const spec = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm', {
      modelContextWindow: 100, models: { m: { modelAutoCompactTokenLimit: 7 } },
    }, { contextWindow: 256_000 })

    expect(spec.configArgs).toEqual(expect.arrayContaining(['model_context_window=100', 'model_auto_compact_token_limit=7']))
  })

  it('applies a deployment ratio and never emits a non-positive limit', async () => {
    const derived = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm', {},
      { contextWindow: 200_000, autoCompactContextRatio: 0.5 })
    const tiny = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm', {},
      { contextWindow: 1, autoCompactContextRatio: 0.75 })

    expect(derived.configArgs).toEqual(expect.arrayContaining(['model_auto_compact_token_limit=100000']))
    expect(tiny.configArgs).toEqual(expect.arrayContaining(['model_context_window=1', 'model_auto_compact_token_limit=1']))
  })

  it('leaves both limits to native defaults when no context window is known', async () => {
    const spec = await resolveCodexProviderSpec(new Context(), { provider: 'local', baseUrl: 'http://localhost/v1' }, 'm')

    expect(spec.configArgs.some(argument => argument.startsWith('model_context_window='))).toBe(false)
    expect(spec.configArgs.some(argument => argument.startsWith('model_auto_compact_token_limit='))).toBe(false)
  })
})


it('preserves disabled thinking and exact-model reasoning overrides in configuration', () => {
  expect(CodexProviderOptionsSchema({ reasoningEfforts: { off: null, max: 'xhigh' }, defaultReasoningEffort: 'max',
    models: { small: { reasoningEfforts: { off: null, high: 'low' }, defaultReasoningEffort: 'high' } },
  })).toMatchObject({ reasoningEfforts: { off: null, max: 'xhigh' }, models: { small: { reasoningEfforts: { off: null, high: 'low' } } } })
})
