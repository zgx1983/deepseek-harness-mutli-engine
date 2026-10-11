import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { resolveCodexEndpoint } from '../src/index.ts'

function provider(id: string, endpoints: LlmProviderInfo['endpoints']): LlmProviderInfo {
  return { id, name: id, ...endpoints === undefined ? {} : { endpoints } }
}

const openai = (url: string, credentialRef?: string): LlmProviderInfo => provider('openai', [{
  id: 'openai-compatible',
  name: 'OpenAI-compatible',
  baseUrl: url,
  ...credentialRef === undefined ? {} : { credentialRef },
}])

function ctxWith(providers: LlmProviderInfo[], resolve: (ref: string) => string | undefined): Context {
  const ctx = new Context()
  ctx.provide('llm', { listProviders: () => providers } as never)
  ctx.provide('credentials', {
    resolve: async (ref: string) => resolve(ref) === undefined
      ? undefined
      : { value: resolve(ref), source: 'test' },
  } as never)
  return ctx
}

describe('resolveCodexEndpoint', () => {
  it('resolves the unique provider, its URL, and its credential name and value', async () => {
    const ctx = ctxWith([openai('https://codex.test/v1', 'OPENAI_API_KEY')], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, undefined)).resolves.toEqual({
      provider: 'openai',
      baseUrl: 'https://codex.test/v1',
      credential: { ref: 'OPENAI_API_KEY', value: 'secret' },
    })
  })

  it('returns undefined when no provider serves the endpoint', async () => {
    const ctx = ctxWith([provider('anthropic', [{ id: 'anthropic-api', name: 'Anthropic API' }])], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, undefined)).resolves.toBeUndefined()
  })

  it('fails loudly when several providers serve the endpoint without an override', async () => {
    const ctx = ctxWith([
      openai('https://a.test/v1'),
      provider('acme', [{ id: 'openai-compatible', name: 'OpenAI-compatible', baseUrl: 'https://b.test/v1' }]),
    ], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, undefined)).rejects.toThrow(/2 providers serve "openai-compatible"/)
  })

  it('honors a cordis.yml provider override', async () => {
    const ctx = ctxWith([
      openai('https://a.test/v1'),
      provider('acme', [{ id: 'openai-compatible', name: 'OpenAI-compatible', baseUrl: 'https://b.test/v1' }]),
    ], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, 'acme')).resolves.toEqual({
      provider: 'acme',
      baseUrl: 'https://b.test/v1',
    })
  })

  it('rejects an override naming a provider that does not serve the endpoint', async () => {
    const ctx = ctxWith([openai('https://a.test/v1')], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, 'acme')).rejects.toThrow(/does not serve "openai-compatible"/)
  })

  it('omits the credential when the endpoint names no reference', async () => {
    const ctx = ctxWith([openai('https://a.test/v1')], () => 'secret')
    await expect(resolveCodexEndpoint(ctx, undefined)).resolves.toEqual({
      provider: 'openai',
      baseUrl: 'https://a.test/v1',
    })
  })

  it('fails loudly when the named credential is not set', async () => {
    const ctx = ctxWith([openai('https://a.test/v1', 'OPENAI_API_KEY')], () => undefined)
    await expect(resolveCodexEndpoint(ctx, undefined)).rejects.toThrow(/no credential for provider "openai"/)
  })
})
