/**
 * Engine-to-endpoint routing helpers shared by the model catalog and call
 * surfaces. An engine definition declares the endpoint ids it routes to; these
 * predicates decide which providers and models an engine offers.
 *
 * @module @deepseek-ai/dsh-llm/endpoints
 */

import type { LlmModelInfo, LlmProviderInfo } from './types.ts'

/** Endpoint ids one provider advertises, or an empty set when it advertises none. */
function providerEndpointIds(provider: LlmProviderInfo): ReadonlySet<string> {
  const declared = provider.endpoints
  if (declared === undefined || declared.length === 0) return new Set()
  const ids = new Set<string>()
  for (const endpoint of declared) ids.add(endpoint.id)
  return ids
}

/**
 * Whether one engine may route to a provider. An engine that filters by
 * endpoints (a non-empty `engineEndpoints`) reaches only providers advertising
 * one of them; an engine that does not filter (the native loop) reaches every
 * provider.
 * @param provider - registered provider metadata.
 * @param engineEndpoints - endpoint ids the active engine routes to.
 * @returns whether the engine offers the provider's models.
 */
export function providerServesEngine(
  provider: LlmProviderInfo,
  engineEndpoints: readonly string[],
): boolean {
  if (engineEndpoints.length === 0) return true
  const endpoints = providerEndpointIds(provider)
  if (endpoints.size === 0) return false
  return engineEndpoints.some(id => endpoints.has(id))
}

/**
 * Whether one model is offered to an engine. Absent model endpoints inherit
 * the owning provider's endpoints; otherwise the model is offered only when
 * its endpoint set intersects the engine's endpoints.
 * @param model - discovered model metadata.
 * @param provider - owning provider metadata.
 * @param engineEndpoints - endpoint ids the active engine routes to.
 * @returns whether the engine offers this model.
 */
export function modelServesEngine(
  model: LlmModelInfo,
  provider: LlmProviderInfo,
  engineEndpoints: readonly string[],
): boolean {
  if (engineEndpoints.length === 0) return true
  const declared = model.endpoints
  const endpoints = declared === undefined
    ? providerEndpointIds(provider)
    : new Set(declared)
  if (endpoints.size === 0) return false
  return engineEndpoints.some(id => endpoints.has(id))
}
