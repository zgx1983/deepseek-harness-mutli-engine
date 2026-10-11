/**
 * Deployment resolution for the process-shared Codex app-server child: the
 * provider routes pinned at startup, the merged native model catalog, and the
 * shared CODEX_HOME every conversation thread attaches through.
 *
 * @module @deepseek-ai/dsh-subagent-codex/shared-host
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { DEFAULT_DISPOSE_GRACE_MS } from './run.ts'
import type { CodexEngineConfig } from './engine.ts'
import { resolveCodexEndpoint } from './endpoint.ts'
import { resolveCodexProviderSpec, type CodexProviderOptions } from './provider-config.ts'
import { resolveCodexModelCatalog, writeCodexModelCatalog, mergeCodexModelCatalogs,
  DEFAULT_CATALOG_INSTRUCTIONS, DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT,
  type CodexModelCatalog } from './model-catalog.ts'
import { DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES } from './user-config.ts'
import { codexAppServerArgvWith } from './main-adapter.ts'
import { prepareSharedCodexHome } from './storage.ts'
import { CodexSharedServerHost, type CodexSharedServerSpec } from './shared-server.ts'

/** Native agent defaults carried once at process level, never per route. */
const SHARED_AGENT_OPTIONS = [
  ['subagentModel', 'agents.default_subagent_model'],
  ['subagentReasoningEffort', 'agents.default_subagent_reasoning_effort'],
] as const

/** Route-level options that survive shared-child resolution; per-model process pins stay catalog-only. */
function sharedRouteOptions(options: CodexProviderOptions | undefined): CodexProviderOptions {
  const picked: CodexProviderOptions = {}
  if (options?.httpHeaders !== undefined) picked.httpHeaders = options.httpHeaders
  if (options?.headerCredentialRefs !== undefined) picked.headerCredentialRefs = options.headerCredentialRefs
  if (options?.queryParams !== undefined) picked.queryParams = options.queryParams
  if (options?.requestMaxRetries !== undefined) picked.requestMaxRetries = options.requestMaxRetries
  if (options?.streamMaxRetries !== undefined) picked.streamMaxRetries = options.streamMaxRetries
  if (options?.streamIdleTimeoutMs !== undefined) picked.streamIdleTimeoutMs = options.streamIdleTimeoutMs
  if (options?.supportsWebsockets !== undefined) picked.supportsWebsockets = options.supportsWebsockets
  return picked
}

/**
 * The engine-facing shared host: owns the process-wide child through
 * {@link CodexSharedServerHost} and the per-route retained unlisted models
 * that survive child restarts.
 */
export class CodexEngineSharedHost {
  private readonly host: CodexSharedServerHost
  private readonly retained = new Map<string, Set<string>>()
  private writtenContents: string | undefined

  /**
   * @param ctx - context carrying the LLM registry, credential seam, profile
   *   home, and subprocess service.
   * @param config - main-engine deployment configuration.
   * @param startChild - child construction seam; tests substitute a scripted
   *   server while resolution and restart gating stay real.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: CodexEngineConfig,
    startChild?: (spec: CodexSharedServerSpec, signal: AbortSignal) => Promise<CodexSharedAppServerRef>,
  ) {
    this.host = new CodexSharedServerHost(
      signal => this.resolveSpec(signal),
      (reason) => { ctx.logger.warn(`subagent-codex: ${reason}`) },
      startChild,
    )
  }

  /**
   * Return the live shared server, starting or restarting its child on
   * configuration drift; see {@link CodexSharedServerHost.ensureStarted}.
   * @param signal - caller cancellation checked at entry.
   * @returns the shared server accepting thread attachments.
   */
  ensureStarted(signal: AbortSignal): Promise<CodexSharedAppServerRef> {
    return this.host.ensureStarted(signal)
  }

  /**
   * Retain a session-selected model missing from its route listing and refresh
   * the shared catalog metadata in place; the child restarts only on real
   * configuration drift, never for unlisted models.
   * @param route - provider route the model was selected on.
   * @param model - exact selected model id absent from the route listing.
   * @param signal - caller cancellation for the metadata refresh.
   */
  async noteUnlistedModel(route: string, model: string, signal: AbortSignal): Promise<void> {
    const models = this.retained.get(route)
    if (models?.has(model) === true) return
    if (models === undefined) this.retained.set(route, new Set([model]))
    else models.add(model)
    await this.host.ensureStarted(signal)
  }

  /** Stop the shared child; attached conversations fail with its failure. */
  close(): Promise<void> {
    return this.host.close()
  }

  private async resolveSpec(signal: AbortSignal): Promise<CodexSharedServerSpec> {
    signal.throwIfAborted()
    const { ctx, config } = this
    const home = ctx.get('profileContext')?.home
    if (home === undefined) throw new Error('Codex needs the Harness home for persistent threads')
    const routes = resolveSharedRoutes(ctx, config)
    const routeSpecs: Array<{ args: string[]; env: Record<string, string>; secrets: string[] }> = []
    for (const [index, route] of routes.entries()) {
      const endpoint = await resolveCodexEndpoint(ctx, route)
      if (endpoint === undefined) {
        throw new Error(`subagent-codex: provider "${route}" does not serve the Codex endpoint`)
      }
      const spec = await resolveCodexProviderSpec(ctx, endpoint, undefined,
        sharedRouteOptions(config.providers?.[route]), {}, { index })
      routeSpecs.push({ args: spec.configArgs, env: spec.env, secrets: spec.secrets })
    }
    const defaults = {
      instructions: config.catalogInstructions ?? DEFAULT_CATALOG_INSTRUCTIONS,
      truncationTokenLimit: config.catalogTruncationTokenLimit ?? DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT,
    }
    const routeCatalogs = []
    for (const route of routes) {
      routeCatalogs.push({ routeId: route, catalog: await resolveCodexModelCatalog(ctx, route, undefined,
        defaults, config.providers?.[route] ?? {}, [...this.retained.get(route) ?? []]) })
    }
    const catalog = mergeCodexModelCatalogs(routeCatalogs)
    const sharedHome = await prepareSharedCodexHome(home, undefined, undefined, homedir(), false,
      config.mirrorUserInstructions === false ? null : join(homedir(), '.codex', 'AGENTS.md'))
    await mkdir(sharedHome.home, { recursive: true, mode: 0o700 })
    if (this.writtenContents !== catalog.contents) {
      await writeCodexModelCatalog(sharedHome.home, catalog.contents)
      this.writtenContents = catalog.contents
    }
    const env: Record<string, string> = { ...config.env, CODEX_HOME: sharedHome.home,
      CODEX_SQLITE_HOME: join(sharedHome.home, 'sqlite') }
    for (const route of routeSpecs) Object.assign(env, route.env)
    const configArgs = [...routeSpecs.flatMap(route => route.args), ...sharedAgentArgs(config, routes),
      `model_catalog_json=${JSON.stringify(join(sharedHome.home, 'models.json'))}`,
      `sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`,
      `log_dir=${JSON.stringify(join(sharedHome.home, 'log'))}`,
      ...projectDocArgs(config)]
    const cwd = homedir()
    return {
      home: sharedHome.home,
      cwd,
      env,
      argv: codexAppServerArgvWith(configArgs),
      routes: routes.map((id, index) => ({ id, nativeName: index === 0 ? 'dsh_engine' : `dsh_engine_${index}` })),
      expectedModelIds: catalog.modelIds,
      catalog,
      secrets: routeSpecs.flatMap(route => route.secrets),
      configKey: JSON.stringify({ routes, configArgs, env, cwd,
        catalog: listedCatalogDigest(routeCatalogs) }),
      disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      startupTimeoutMs: config.startupTimeoutMs ?? 30_000,
      spawn: spec => ctx.subprocess.spawn(spec),
    }
  }
}

/** The engine-visible alias of the shared server type. */
export type CodexSharedAppServerRef = Awaited<ReturnType<CodexSharedServerHost['ensureStarted']>>

/** Resolve the deterministic provider-route list pinned on the shared child. */
function resolveSharedRoutes(ctx: Context, config: CodexEngineConfig): string[] {
  const explicit = [...new Set([...Object.keys(config.providers ?? {}),
    ...config.provider === undefined ? [] : [config.provider]])].sort()
  if (explicit.length > 0) return explicit
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('subagent-codex: the Codex engine needs the LLM registry to resolve its endpoint')
  const serving = llm.listProviders().filter(provider =>
    (provider.endpoints ?? []).some(endpoint => endpoint.id === 'openai-compatible')).map(provider => provider.id).sort()
  if (serving.length > 1) {
    throw new Error(`subagent-codex: ${serving.length} providers serve "openai-compatible"`
      + ` (${serving.join(', ')}); set provider in cordis.yml`)
  }
  if (serving.length === 0) {
    throw new Error('subagent-codex: no configured provider serves "openai-compatible";'
      + ' the shared Codex app-server has nothing to run against')
  }
  return serving
}

/** Process-level native agent defaults; routes must agree on their values. */
function sharedAgentArgs(config: CodexEngineConfig, routes: readonly string[]): string[] {
  const args: string[] = []
  for (const [key, native] of SHARED_AGENT_OPTIONS) {
    let value: string | undefined
    for (const route of routes) {
      const routeValue = config.providers?.[route]?.[key]
      if (routeValue === undefined) continue
      if (value !== undefined && value !== routeValue) {
        throw new Error(`subagent-codex: providers disagree on providers.*.${key}`
          + ` ("${value}" vs "${routeValue}"); the shared Codex app-server carries one process-level default`)
      }
      value = routeValue
    }
    if (value !== undefined) args.push(`${native}=${JSON.stringify(value)}`)
  }
  return args
}

/** Digest over listed catalog entries only; retained unlisted models never restart the child. */
function listedCatalogDigest(routeCatalogs: readonly { routeId: string; catalog: CodexModelCatalog }[]): string {
  const hash = createHash('sha256')
  for (const { routeId, catalog } of routeCatalogs) {
    const unlisted = new Set(catalog.unlistedModelIds)
    const parsed = JSON.parse(catalog.contents) as { models: Array<{ slug: string }> }
    const entries = parsed.models.filter(entry => !unlisted.has(entry.slug))
    hash.update(routeId)
    hash.update(JSON.stringify(entries))
  }
  return hash.digest('hex')
}

function projectDocArgs(config: CodexEngineConfig): string[] {
  const filenames = [...config.projectDocFallbackFilenames ?? DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES]
  return filenames.length === 0 ? [] : [`project_doc_fallback_filenames=${JSON.stringify(filenames)}`]
}
