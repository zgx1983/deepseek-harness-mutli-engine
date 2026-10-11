/** Per-route native configuration for isolated Codex main processes. */
import { mapEngineReasoning, type EngineReasoningOptions } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ResolvedCodexEndpoint } from './endpoint.ts'

/** Native model metadata; explicit session model and effort remain authoritative. */
export interface CodexModelOptions extends EngineReasoningOptions {
  /** Native coding instructions for this model. */
  modelInstructions?: string
  /** Native tool-output truncation token budget. */
  modelTruncationTokenLimit?: number
  /** Native context token capacity. */
  modelContextWindow?: number
  /** Native automatic compaction token threshold. */
  modelAutoCompactTokenLimit?: number
  /** Whether the model accepts reasoning-summary metadata. */
  modelSupportsReasoningSummaries?: boolean
  /** Native reasoning-summary detail. */
  modelReasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none'
  /** Native response verbosity. */
  modelVerbosity?: 'low' | 'medium' | 'high'
}

/** Extra configuration for one registered LLM route, never a provider selection. */
export interface CodexProviderOptions extends CodexModelOptions {
  /** Native internal subagent model; omitted to inherit the parent model. */
  subagentModel?: string
  /** Reasoning effort for native internal subagents. */
  subagentReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** Static HTTP headers; secrets belong in headerCredentialRefs. */
  httpHeaders?: Record<string, string>
  /** HTTP header names mapped to Harness credential references. */
  headerCredentialRefs?: Record<string, string>
  /** Non-secret query parameters appended by the native HTTP client. */
  queryParams?: Record<string, string>
  /** Maximum native HTTP request retries. */
  requestMaxRetries?: number
  /** Maximum native streaming retries. */
  streamMaxRetries?: number
  /** Native stream idle timeout in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Whether this Responses endpoint supports native WebSocket transport. */
  supportsWebsockets?: boolean
  /** Model-specific metadata overrides, keyed by the exact selected model id. */
  models?: Record<string, CodexModelOptions>
}

const modelFields = {
  reasoningEfforts: schema.dict(schema.union([schema.string().min(1), schema.const(null)])),
  defaultReasoningEffort: schema.string().min(1),
  modelInstructions: schema.string().min(1),
  modelTruncationTokenLimit: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  modelContextWindow: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  modelAutoCompactTokenLimit: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  modelSupportsReasoningSummaries: schema.boolean(),
  modelReasoningSummary: schema.union(['auto', 'concise', 'detailed', 'none']),
  modelVerbosity: schema.union(['low', 'medium', 'high']),
}

/** Configuration parser for route extras accepted by the main engine. */
export const CodexProviderOptionsSchema: schema<CodexProviderOptions> = schema.object({
  ...modelFields,
  subagentModel: schema.string().min(1),
  subagentReasoningEffort: schema.union(['minimal', 'low', 'medium', 'high', 'xhigh']),
  httpHeaders: schema.dict(schema.string()),
  headerCredentialRefs: schema.dict(schema.string().role('credential-ref')),
  queryParams: schema.dict(schema.string()),
  requestMaxRetries: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
  streamMaxRetries: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
  streamIdleTimeoutMs: schema.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  supportsWebsockets: schema.boolean(),
  models: schema.dict(schema.object(modelFields)),
})

/** Resolved native arguments and private child environment. */
export interface CodexProviderSpec {
  /** TOML assignments passed as separate CLI arguments; never contain header secrets. */
  configArgs: string[]
  /** Resolved authentication and header values for this child only. */
  env: Record<string, string>
  /** Values removed from public native failure diagnostics. */
  secrets: string[]
}

/**
 * Fraction of a resolved context window used as the native auto-compaction
 * limit when neither the route configuration nor the exact-model override names
 * one. It matches the Claude engine's compaction window.
 */
export const DEFAULT_AUTO_COMPACT_CONTEXT_RATIO = 0.9

/** Values the engine resolved for the selected model before route overrides. */
export interface CodexResolvedModelLimits {
  /** Context window resolved from live model metadata, in tokens. */
  contextWindow?: number
  /** Fraction of the context window used when no explicit compaction limit exists. */
  autoCompactContextRatio?: number
}

/** Reservation of one native provider key namespace on a shared child. */
export interface CodexProviderRouteSlot {
  /** Deterministic route index; names the native provider and its env keys. */
  readonly index: number
}

/**
 * Resolve route extras and credentials before replacing an existing process.
 * The selected model's resolved context window becomes `model_context_window`
 * unless route configuration pins one, and it derives
 * `model_auto_compact_token_limit` unless configuration pins that.
 * @param ctx - credential-owning runtime.
 * @param endpoint - selected route URL and authentication.
 * @param model - exact session-selected model id; omission resolves route-level settings only.
 * @param options - route-specific settings; omission uses native defaults.
 * @param resolved - values the engine resolved for this model before route overrides.
 * @param route - shared-child route slot; omission keeps the dedicated single-provider names.
 * @returns argv-safe native overrides and private environment values.
 */
export async function resolveCodexProviderSpec(
  ctx: Context, endpoint: ResolvedCodexEndpoint, model: string | undefined, options: CodexProviderOptions = {},
  resolved: CodexResolvedModelLimits = {}, route?: CodexProviderRouteSlot,
): Promise<CodexProviderSpec> {
  const nativeName = route === undefined ? 'dsh_engine' : `dsh_engine_${route.index}`
  const prefix = `model_providers.${nativeName}`
  const apiKeyEnv = route === undefined ? 'DSH_CODEX_API_KEY' : `DSH_CODEX_API_KEY_${route.index}`
  const headerEnv = (serial: number): string => route === undefined
    ? `DSH_CODEX_HEADER_${serial}`
    : `DSH_CODEX_HEADER_${route.index}_${serial}`
  const configArgs = [...(route === undefined || route.index === 0) ? [`model_provider=${JSON.stringify(nativeName)}`] : [],
    `${prefix}.name=${JSON.stringify(endpoint.provider)}`, `${prefix}.base_url=${JSON.stringify(endpoint.baseUrl)}`,
    `${prefix}.wire_api="responses"`, `${prefix}.requires_openai_auth=false`]
  const env: Record<string, string> = {}
  const secrets: string[] = []
  if (endpoint.credential !== undefined) {
    env[apiKeyEnv] = endpoint.credential.value
    secrets.push(endpoint.credential.value)
    configArgs.push(`${prefix}.env_key=${JSON.stringify(apiKeyEnv)}`)
  }
  const headers = new Map<string, { name: string; value: string }>()
  for (const [name, value] of Object.entries(options.httpHeaders ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error('Invalid Codex HTTP header')
    if (headers.has(name.toLowerCase())) throw new Error(`Duplicate Codex HTTP header "${name}"`)
    headers.set(name.toLowerCase(), { name, value })
  }
  for (const [name, ref] of Object.entries(options.headerCredentialRefs ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error('Invalid Codex HTTP header name')
    if (headers.has(name.toLowerCase())) throw new Error(`Duplicate Codex HTTP header "${name}"`)
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error('Codex HTTP headers need the credential service')
    const resolved = await credentials.resolve(credentialRef(ref))
    if (resolved === undefined || resolved.value.length === 0) throw new Error(`Missing Codex header credential "${ref}"`)
    if (/[\r\n]/.test(resolved.value)) throw new Error('Invalid Codex HTTP header credential')
    headers.set(name.toLowerCase(), { name, value: resolved.value })
  }
  for (const { name, value } of headers.values()) {
    const key = headerEnv(secrets.length)
    env[key] = value
    secrets.push(value)
    configArgs.push(`${prefix}.env_http_headers.${JSON.stringify(name)}=${JSON.stringify(key)}`)
  }
  for (const [key, value] of Object.entries(options.queryParams ?? {})) {
    configArgs.push(`${prefix}.query_params.${JSON.stringify(key)}=${JSON.stringify(value)}`)
  }
  for (const [key, value] of [
    ['request_max_retries', options.requestMaxRetries], ['stream_max_retries', options.streamMaxRetries],
    ['stream_idle_timeout_ms', options.streamIdleTimeoutMs], ['supports_websockets', options.supportsWebsockets],
  ] as const) {
    if (value !== undefined) configArgs.push(`${prefix}.${key}=${JSON.stringify(value)}`)
  }
  if (options.subagentModel !== undefined) {
    configArgs.push(`agents.default_subagent_model=${JSON.stringify(options.subagentModel)}`)
  }
  if (options.subagentReasoningEffort !== undefined) {
    configArgs.push(`agents.default_subagent_reasoning_effort=${JSON.stringify(options.subagentReasoningEffort)}`)
  }
  const settings = { ...options, ...(model === undefined ? {} : options.models?.[model]) }
  const contextWindow = settings.modelContextWindow ?? resolved.contextWindow
  const autoCompactTokenLimit = settings.modelAutoCompactTokenLimit
    ?? (contextWindow === undefined
      ? undefined
      : Math.max(1, Math.floor(contextWindow * (resolved.autoCompactContextRatio ?? DEFAULT_AUTO_COMPACT_CONTEXT_RATIO))))
  for (const [key, value] of [
    ['model_context_window', contextWindow], ['model_auto_compact_token_limit', autoCompactTokenLimit],
    ['model_supports_reasoning_summaries', settings.modelSupportsReasoningSummaries],
    ['model_reasoning_summary', settings.modelReasoningSummary], ['model_verbosity', settings.modelVerbosity],
  ] as const) {
    if (value !== undefined) configArgs.push(`${key}=${JSON.stringify(value)}`)
  }
  return { configArgs, env, secrets }
}


/**
 * Resolve Codex reasoning parameters from exact-model metadata and overrides.
 * @param reasoning - model choices and protocol mappings.
 * @param options - provider defaults merged with exact-model overrides.
 * @returns app-server choices; explicit off maps to the native none value.
 */
export function resolveCodexReasoning(
  reasoning: LlmModelReasoningInfo | undefined, options: EngineReasoningOptions = {},
): LlmModelReasoningInfo | undefined {
  return mapEngineReasoning(reasoning, options, value => value.trim().length > 0, 'none')
}
