import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG_INSTRUCTIONS, resolveCodexModelCatalog, writeCodexModelCatalog } from '../src/model-catalog.ts'

it('projects only the selected route and snapshots native coding instructions and metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'gateway', name: 'Gateway',
    endpoints: [{ id: 'openai-compatible', name: 'Responses' }] }])
  vi.spyOn(ctx.llm, 'listModels').mockResolvedValue([
    { provider: 'gateway', id: 'large[1m]', name: 'Large', endpoints: ['openai-compatible'] },
    { provider: 'gateway', id: 'small', name: 'Small' },
    { provider: 'gateway', id: 'claude-only', name: 'Claude only', endpoints: ['anthropic-api'] },
  ])
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id,
    context: { contextWindow: 200000 }, inputModalities: ['text'],
  }))
  const defaults = { instructions: DEFAULT_CATALOG_INSTRUCTIONS, truncationTokenLimit: 10000 }
  const options = { models: { 'large[1m]': { modelContextWindow: 1000000, modelInstructions: 'Use the workspace tools.' } } }
  try {
    const catalog = await resolveCodexModelCatalog(ctx, 'gateway', 'large[1m]', defaults, options)
    expect(catalog.modelIds).toEqual(['large[1m]', 'small'])
    expect(catalog.contextWindows).toEqual({ 'large[1m]': 1000000, small: 200000 })
    await expect(catalog.contents).toMatchFileSnapshot('./expected/model-catalog.json')
    expect(await resolveCodexModelCatalog(ctx, 'gateway', 'small', defaults, options)).toEqual(catalog)
    await expect(resolveCodexModelCatalog(ctx, 'missing', 'small', defaults)).rejects.toThrow('is unavailable')
    const home = await mkdtemp(join(tmpdir(), 'dsh-codex-catalog-'))
    try {
      const path = await writeCodexModelCatalog(home, catalog.contents)
      expect(await readFile(path, 'utf8')).toBe(catalog.contents)
      await writeCodexModelCatalog(home, '{"models":[]}\n')
      expect(await readFile(path, 'utf8')).toBe('{"models":[]}\n')
      expect(await readdir(home)).toEqual(['models.json'])
    } finally { await rm(home, { recursive: true, force: true }) }
  } finally { await ctx.fiber.dispose() }
})

it('includes an unlisted selected model unchanged when route metadata is unavailable', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'gateway', name: 'Gateway',
    endpoints: [{ id: 'openai-compatible', name: 'Responses' }] }])
  vi.spyOn(ctx.llm, 'listModels').mockResolvedValue([
    { provider: 'gateway', id: 'listed-model', name: 'Listed model' },
  ])
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => {
    if (id === 'display name alias') throw new Error('provider has no metadata for this alias')
    return { provider, id, name: id }
  })
  try {
    const catalog = await resolveCodexModelCatalog(ctx, 'gateway', 'display name alias', {
      instructions: 'Work', truncationTokenLimit: 1000,
    })
    expect(catalog.modelIds).toEqual(['listed-model', 'display name alias'])
    const native = JSON.parse(catalog.contents) as { models: Array<{ slug: string }> }
    expect(native.models.map(model => model.slug)).toEqual(['listed-model', 'display name alias'])
  } finally { await ctx.fiber.dispose() }
})


it('uses protocol effort values and exact-model defaults in the native model catalog', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'gateway', name: 'Gateway', endpoints: [{ id: 'openai-compatible', name: 'Responses' }] }])
  vi.spyOn(ctx.llm, 'listModels').mockResolvedValue(['large', 'small'].map(id => ({ provider: 'gateway', id, name: id })))
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id,
    reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Maximum', wireValue: 'xhigh' }], defaultEffort: ReasoningEffortId('max') },
  }))
  try {
    const catalog = await resolveCodexModelCatalog(ctx, 'gateway', 'large', { instructions: 'Work', truncationTokenLimit: 1000 }, {
      models: { small: { reasoningEfforts: { off: null, high: 'low' }, defaultReasoningEffort: 'high' } },
    })
    const parsed = JSON.parse(catalog.contents) as { models: Array<{
      slug: string
      default_reasoning_level: string
      supported_reasoning_levels: Array<{ effort: string }>
    }> }
    expect(parsed.models.map(model => ({ model: model.slug, default: model.default_reasoning_level, efforts: model.supported_reasoning_levels.map(effort => effort.effort) }))).toMatchInlineSnapshot(`
      [
        {
          "default": "xhigh",
          "efforts": [
            "xhigh",
          ],
          "model": "large",
        },
        {
          "default": "low",
          "efforts": [
            "none",
            "low",
          ],
          "model": "small",
        },
      ]
    `)
  } finally {
    await ctx.fiber.dispose()
  }
})
