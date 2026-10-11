/**
 * Engine-endpoint resolution for the Codex main engine. The factory resolves
 * the one provider route that serves the engine's `openai-compatible` endpoint
 * immediately before spawn, together with the endpoint's base URL and the
 * credential its profile names. Nothing is cached: the registry and the
 * credential seam are re-read per creation, so a changed provider or key
 * reaches the next session without a restart.
 *
 * @module @deepseek-ai/dsh-subagent-codex/endpoint
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmEndpointInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'

/** The endpoint id the Codex engine definition routes to. */
export const CODEX_ENDPOINT_ID = 'openai-compatible'

/** One provider route serving the Codex engine, resolved before spawn. */
export interface ResolvedCodexEndpoint {
  /** Provider route key. */
  readonly provider: string
  /** The route's Codex URL. */
  readonly baseUrl: string
  /** Resolved credential name and value, when the route names a reference. */
  readonly credential?: {
    /** Environment-variable name Codex reads the key from. */
    readonly ref: string
    /** The resolved key value. */
    readonly value: string
  }
}

/** The matching provider and endpoint pair for one registry listing. */
interface EndpointMatch {
  readonly provider: LlmProviderInfo
  readonly endpoint: LlmEndpointInfo
}

function matchesFor(providers: readonly LlmProviderInfo[]): EndpointMatch[] {
  const matches: EndpointMatch[] = []
  for (const provider of providers) {
    for (const endpoint of provider.endpoints ?? []) {
      if (endpoint.id === CODEX_ENDPOINT_ID) matches.push({ provider, endpoint })
    }
  }
  return matches
}

/**
 * Resolve the provider route the Codex engine should run against, failing
 * loud on ambiguity. `undefined` means no configured provider serves the
 * endpoint, so the engine has nothing to run against.
 * @param ctx - context carrying the LLM registry and the credential seam.
 * @param providerOverride - optional cordis.yml-named route for a multi-provider deployment.
 * @returns the resolved route, URL, and credential, or undefined when unconfigured.
 */
export async function resolveCodexEndpoint(
  ctx: Context,
  providerOverride: string | undefined,
): Promise<ResolvedCodexEndpoint | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('subagent-codex: the Codex engine needs the LLM registry to resolve its endpoint')
  }
  const matches = matchesFor(llm.listProviders())
  const selected = providerOverride === undefined
    ? matches.length === 0
      ? undefined
      : matches.length > 1
        ? (() => {
          throw new Error(
            `subagent-codex: ${matches.length} providers serve "${CODEX_ENDPOINT_ID}"`
            + ` (${matches.map(match => match.provider.id).join(', ')}); set provider in cordis.yml`,
          )
        })()
        : matches[0]
    : matches.find(match => match.provider.id === providerOverride)
  if (selected === undefined) {
    if (providerOverride !== undefined) {
      throw new Error(
        `subagent-codex: provider "${providerOverride}" does not serve "${CODEX_ENDPOINT_ID}"`,
      )
    }
    return undefined
  }
  const baseUrl = selected.endpoint.baseUrl
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(`subagent-codex: provider "${selected.provider.id}" declares no Codex URL`)
  }
  if (selected.endpoint.credentialRef === undefined) {
    return { provider: selected.provider.id, baseUrl }
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error('subagent-codex: the Codex engine needs the credential seam to resolve its key')
  }
  const ref = selected.endpoint.credentialRef
  const resolved = await credentials.resolve(credentialRef(ref))
  if (resolved === undefined || resolved.value.length === 0) {
    throw new Error(
      `subagent-codex: no credential for provider "${selected.provider.id}";`
      + ` its endpoint names ${ref}, which is not set`,
    )
  }
  return {
    provider: selected.provider.id,
    baseUrl,
    credential: { ref, value: resolved.value },
  }
}
