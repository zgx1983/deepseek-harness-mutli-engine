/** Project configured route models into the pinned Codex native startup catalog. */
import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { modelServesEngine, type LlmModelInfo, type LlmModelReasoningInfo, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { resolveCodexReasoning, type CodexProviderOptions } from './provider-config.ts'

/** Default native coding instructions, replaceable through main-engine configuration. */
export const DEFAULT_CATALOG_INSTRUCTIONS = 'You are a coding agent. Complete the user’s task in the workspace. '
  + 'Use available tools when needed, respect permission decisions, and report results accurately.'

/** Default native tool-output truncation budget, configurable independently of model context. */
export const DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT = 10_000

/** Explicit deployment defaults for native catalog entries. */
export interface CodexCatalogDefaults {
  /** Coding instructions used unless a route or exact model overrides them. */
  instructions: string
  /** Native tool-output truncation token budget. */
  truncationTokenLimit: number
}

/** Resolved native catalog and its expected discovery ids. */
export interface CodexModelCatalog {
  /** Native ModelsResponse JSON, terminated with one newline. */
  contents: string
  /** Exact model ids expected from the app-server discovery API. */
  modelIds: string[]
  /** Selected model names missing from the provider listing but kept for this process. */
  unlistedModelIds: string[]
  /** Resolved context window by exact model id, when configuration or metadata names one. */
  contextWindows: Record<string, number>
  /** Engine reasoning mappings resolved from the same metadata as the native catalog. */
  reasoningByModel: Record<string, LlmModelReasoningInfo>
}

/**
 * Convert one configured route's models to the native ModelsResponse JSON format.
 * @param ctx - live provider registry and metadata resolver.
 * @param providerId - session-selected provider route.
 * @param selectedModel - session-selected model name passed to the native engine unchanged; omission lists route models only.
 * @param defaults - explicit deployment instructions and output budget.
 * @param options - route defaults and exact-model overrides.
 * @param retainedUnlistedModels - earlier user-selected names kept for this process catalog.
 * @returns serialized catalog, independent of which advertised model is selected.
 */
export async function resolveCodexModelCatalog(
  ctx: Context, providerId: string, selectedModel: string | undefined, defaults: CodexCatalogDefaults,
  options: CodexProviderOptions = {}, retainedUnlistedModels: readonly string[] = [],
): Promise<CodexModelCatalog> {
  const provider = ctx.llm.listProviders().find(entry => entry.id === providerId)
  if (provider === undefined) throw new Error(`Codex provider "${providerId}" is unavailable`)
  const listedModels = (await ctx.llm.listModels(providerId)).filter(model => modelServesEngine(model, provider, ['openai-compatible']))
  const unlistedModelIds = [...new Set([...retainedUnlistedModels, ...selectedModel === undefined ? [] : [selectedModel]])]
    .filter(modelId => !listedModels.some(model => model.id === modelId))
  const models: LlmModelInfo[] = [
    ...listedModels,
    ...unlistedModelIds.map(id => ({ provider: providerId, id, name: id })),
  ]
  const reasoningByModel: Record<string, LlmModelReasoningInfo> = {}
  const entries = await Promise.all(models.map(async (model, priority) => {
    const metadata: LlmResolvedModelInfo = await resolveModelInfo(ctx, providerId, model.id, unlistedModelIds)
    const settings = { ...options, ...options.models?.[model.id] }
    const reasoning = resolveCodexReasoning(metadata.reasoning, settings)
    if (reasoning !== undefined) reasoningByModel[model.id] = reasoning
    return {
      slug: model.id, display_name: model.name, description: model.description ?? null,
      default_reasoning_level: reasoning?.efforts.find(effort => effort.id === reasoning.defaultEffort)?.wireValue ?? null,
      supported_reasoning_levels: reasoning?.efforts.map(effort => ({
        effort: effort.wireValue ?? effort.id, description: effort.description ?? effort.name,
      })) ?? [],
      shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority,
      availability_nux: null, upgrade: null,
      base_instructions: settings.modelInstructions ?? defaults.instructions,
      supports_reasoning_summary_parameter: settings.modelSupportsReasoningSummaries ?? metadata.reasoning !== undefined,
      default_reasoning_summary: settings.modelReasoningSummary ?? 'none',
      support_verbosity: settings.modelVerbosity !== undefined, default_verbosity: settings.modelVerbosity ?? null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: 'tokens', limit: settings.modelTruncationTokenLimit ?? defaults.truncationTokenLimit },
      context_window: settings.modelContextWindow ?? metadata.context?.contextWindow ?? null,
      ...settings.modelAutoCompactTokenLimit === undefined ? {} : { auto_compact_token_limit: settings.modelAutoCompactTokenLimit },
      experimental_supported_tools: [],
      input_modalities: metadata.inputModalities ?? ['text'],
    }
  }))
  const contextWindows: Record<string, number> = {}
  for (const entry of entries) {
    if (typeof entry.context_window === 'number') contextWindows[entry.slug] = entry.context_window
  }
  return {
    contents: serializeModelCatalog(entries), reasoningByModel,
    modelIds: models.map(model => model.id), unlistedModelIds, contextWindows,
  }
}

/** Serialize catalog entries into the native ModelsResponse JSON document. */
function serializeModelCatalog(entries: readonly CatalogEntry[]): string {
  return `${JSON.stringify({ models: entries }, null, 2)}\n`
}

/** One serialized native catalog entry; fields follow the pinned Codex schema. */
interface CatalogEntry {
  readonly slug: string
  readonly [field: string]: unknown
}

/** One route's catalog bound to its provider route id for merging. */
export interface CodexRouteCatalog {
  /** Provider route id owning the catalog. */
  readonly routeId: string
  /** Resolved route catalog. */
  readonly catalog: CodexModelCatalog
}

/**
 * Merge per-route catalogs into the single shared-child catalog document.
 * @param routes - resolved route catalogs in deterministic route order.
 * @returns the merged catalog.
 * @throws naming both routes when one model slug is defined twice.
 */
export function mergeCodexModelCatalogs(routes: readonly CodexRouteCatalog[]): CodexModelCatalog {
  const entries: CatalogEntry[] = []
  const owners = new Map<string, string>()
  const modelIds: string[] = []
  const unlistedModelIds: string[] = []
  const contextWindows: Record<string, number> = {}
  const reasoningByModel: Record<string, LlmModelReasoningInfo> = {}
  for (const { routeId, catalog } of routes) {
    const parsed = JSON.parse(catalog.contents) as { models: CatalogEntry[] }
    for (const entry of parsed.models) {
      const owner = owners.get(entry.slug)
      if (owner !== undefined) {
        throw new Error(`Codex model "${entry.slug}" is served by providers "${owner}" and "${routeId}";`
          + ' shared Codex app-server routes must not define the same model id twice')
      }
      owners.set(entry.slug, routeId)
      entries.push(entry)
      if (typeof entry.context_window === 'number') contextWindows[entry.slug] = entry.context_window
    }
    modelIds.push(...catalog.modelIds)
    unlistedModelIds.push(...catalog.unlistedModelIds)
    for (const [model, reasoning] of Object.entries(catalog.reasoningByModel)) reasoningByModel[model] = reasoning
  }
  return {
    contents: serializeModelCatalog(entries), reasoningByModel,
    modelIds, unlistedModelIds, contextWindows,
  }
}

/** Keep optional provider metadata from blocking the explicitly selected model route. */
async function resolveModelInfo(
  ctx: Context,
  providerId: string,
  modelId: string,
  unlistedModelIds: readonly string[],
): Promise<LlmResolvedModelInfo> {
  try {
    return await ctx.llm.resolveModelInfo(providerId, modelId)
  } catch (error) {
    if (!unlistedModelIds.includes(modelId)) throw error
    return { provider: providerId, id: modelId, name: modelId }
  }
}

/**
 * Atomically publish a catalog after the owning old process has exited.
 * @param home - existing isolated native session directory.
 * @param contents - fully resolved native catalog JSON.
 * @returns absolute catalog path supplied to the new app-server.
 */
export async function writeCodexModelCatalog(home: string, contents: string): Promise<string> {
  const path = join(home, 'models.json')
  const staging = join(home, `models.${randomUUID()}.tmp`)
  await writeFile(staging, contents, { mode: 0o600, flag: 'wx' })
  try {
    await rename(staging, path)
  } finally {
    await unlink(staging).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
  return path
}
