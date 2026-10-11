import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import { resolveClaudeEndpoint } from '../src/index.ts'

function provider(id: string, endpoints: LlmProviderInfo['endpoints']): LlmProviderInfo {
  return { id, name: id, ...endpoints === undefined ? {} : { endpoints } }
}

const anthropic = (url: string, credentialRef?: string): LlmProviderInfo => provider('anthropic', [{
  id: 'anthropic-api',
  name: 'Anthropic API',
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

describe('resolveClaudeEndpoint', () => {
  it('resolves the unique provider, its URL, and its credential', async () => {
    const ctx = ctxWith([anthropic('https://claude.test', 'ANTHROPIC_API_KEY')], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, undefined)).resolves.toEqual({
      provider: 'anthropic',
      baseUrl: 'https://claude.test',
      credential: 'secret',
    })
  })

  it('returns undefined when no provider serves the endpoint', async () => {
    const ctx = ctxWith([provider('openai', [{ id: 'openai-compatible', name: 'OpenAI' }])], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, undefined)).resolves.toBeUndefined()
  })

  it('fails loudly when several providers serve the endpoint without an override', async () => {
    const ctx = ctxWith([
      anthropic('https://a.test'),
      provider('acme', [{ id: 'anthropic-api', name: 'Anthropic API', baseUrl: 'https://b.test' }]),
    ], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, undefined)).rejects.toThrow(/2 providers serve "anthropic-api"/)
  })

  it('honors a cordis.yml provider override', async () => {
    const ctx = ctxWith([
      anthropic('https://a.test'),
      provider('acme', [{ id: 'anthropic-api', name: 'Anthropic API', baseUrl: 'https://b.test' }]),
    ], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, 'acme')).resolves.toEqual({
      provider: 'acme',
      baseUrl: 'https://b.test',
    })
  })

  it('rejects an override naming a provider that does not serve the endpoint', async () => {
    const ctx = ctxWith([anthropic('https://a.test')], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, 'acme')).rejects.toThrow(/does not serve "anthropic-api"/)
  })

  it('omits the credential when the endpoint names no reference', async () => {
    const ctx = ctxWith([anthropic('https://a.test')], () => 'secret')
    await expect(resolveClaudeEndpoint(ctx, undefined)).resolves.toEqual({
      provider: 'anthropic',
      baseUrl: 'https://a.test',
    })
  })

  it('fails loudly when the named credential is not set', async () => {
    const ctx = ctxWith([anthropic('https://a.test', 'ANTHROPIC_API_KEY')], () => undefined)
    await expect(resolveClaudeEndpoint(ctx, undefined)).rejects.toThrow(/no credential for provider "anthropic"/)
  })
})
