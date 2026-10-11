/** Shared projection of the live LLM registry into the browser model catalog. */

import type { AgentEngineDefinition } from '@deepseek-ai/dsh-agent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { modelServesEngine, providerServesEngine, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @param engineEndpoints - endpoint ids the active engine routes to. An engine
 *   that filters by endpoints sees only providers and models advertising one
 *   of them; an engine that does not filter (the native loop) sees everything.
 * @param resolveReasoning - selected engine capability and protocol mapping resolver.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
  engineEndpoints: readonly string[] = [],
  resolveReasoning?: AgentEngineDefinition['resolveReasoning'],
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(async (provider) => {
    if (!providerServesEngine(provider, engineEndpoints)) return undefined
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        if (!modelServesEngine(model, provider, engineEndpoints)) return undefined
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const engineReasoning = resolveReasoning === undefined
          ? resolved.reasoning
          : resolveReasoning(provider.id, model.id, resolved.reasoning)
        const reasoning: ModelReasoning | undefined = engineReasoning === undefined
          ? undefined
          : {
            efforts: engineReasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(engineReasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: engineReasoning.defaultEffort }),
          }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(model.endpoints === undefined ? {} : { endpoints: [...model.endpoints] }),
        }
      }))
      const serving = entries.filter((entry): entry is Exclude<typeof entry, undefined> => entry !== undefined)
      return {
        kind: 'group' as const,
        group: {
          id: provider.id,
          name: provider.name,
          models: serving,
          ...(provider.endpoints === undefined ? {} : { endpoints: provider.endpoints.map(endpoint => endpoint.id) }),
        },
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  const groups = catalog.flatMap(item => item === undefined ? [] : item.kind === 'group' ? [item.group] : [])
    .filter(group => group.models.length > 0)
  return {
    default: { ...defaultSelection },
    routableProviders: groups.map(group => group.id),
    groups,
    failures: catalog.flatMap(item => item === undefined ? [] : item.kind === 'failure' ? [item.failure] : []),
  }
}

/**
 * Check a GUI selection against the current available provider catalog.
 * @param ctx - Host LLM registry.
 * @param selection - stored or explicitly requested selection.
 * @returns whether the exact model is currently advertised as available.
 */
export async function modelAvailable(ctx: Context, selection: ModelSelection): Promise<boolean> {
  if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) return false
  let models: readonly LlmModelInfo[]
  try { models = await ctx.llm.listModels(selection.provider) }
  catch (error) {
    throw new RemoteError('session/model-unavailable',
      error instanceof Error ? error.message : String(error),
      { provider: selection.provider, model: selection.model })
  }
  return models.some(model => model.id === selection.model)
}

/**
 * Check configured provider API-key references independently of model availability.
 * @param ctx - Host registry, settings, and credential services.
 * @returns whether any API-key provider has a configured credential.
 */
export async function hasProviderApiKey(ctx: Context): Promise<boolean> {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  if (settings === undefined || credentials === undefined) {
    throw new RemoteError('session/provider-credentials-unavailable', 'provider credentials are unavailable', {})
  }
  const namespaces = settings.describe({ redactSecrets: true })
  for (const provider of ctx.llm.listConfigurableProviders()) {
    if (provider.provider === 'deepseek-account') continue
    let profile = namespaces.find(namespace => namespace.ns === provider.settingsNs)?.value
    for (const key of provider.settingsPath) {
      profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    }
    if (typeof profile !== 'object' || profile === null) continue
    const ref: unknown = Reflect.get(profile, 'apiKeyEnv')
    if (typeof ref === 'string' && ref.length > 0
      && (await credentials.describe(credentialRef(ref))).configured) return true
  }
  return false
}
