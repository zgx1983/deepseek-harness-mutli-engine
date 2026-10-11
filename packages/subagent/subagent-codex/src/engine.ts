/** Main conversation execution provider sharing the managed Agent lifecycle. */

import { syncEngineSkillDirectories, startTeamToolBridge, type TeamToolBridge } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands/types'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { z } from 'zod'
import {
  AgentEngineId, resolveEngineEffort,
  acknowledgeUncertainEngineInputs, engineFailure, nativeBindingFor, recordNativeBinding, engineActivityRecorder, engineSubagentRecorder,
  enginePlanModeFor, recordEnginePlanMode,
  type EngineTurnDriver, type ModelSelection,
  type AgentEngineCommand,
  type AgentEngineDefinition,
  type Agent,
  type AgentCancelCause,
  type AgentFactory,
  type AgentHandle,
  type AgentStatus,
  type CancelOptions,
  type CreateAgentOptions,
  type Inbox,
  type InboxTarget,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { textOnlyImageText, type ContentBlock, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveCodexEndpoint } from './endpoint.ts'
import { resolveCodexProviderSpec, resolveCodexReasoning, DEFAULT_AUTO_COMPACT_CONTEXT_RATIO, type CodexProviderOptions } from './provider-config.ts'
import { prepareCodexHome, prepareSharedCodexHome, writeTeamTaskPermissionProfile, type CodexSessionStorage } from './storage.ts'
import { DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES, type CodexPermissionSettings } from './user-config.ts'
import { resolveCodexModelCatalog, writeCodexModelCatalog,
  DEFAULT_CATALOG_INSTRUCTIONS, DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT } from './model-catalog.ts'
import { CodexMainAdapter, codexAppServerArgvWith, type CodexMainInput, type CodexTurnRunner } from './main-adapter.ts'
import type { CodexCommandSkill, CodexMainWire, CodexMainWireOptions } from './main-wire.ts'
import type { CodexSharedAppServer } from './shared-server.ts'
import { CodexEngineSharedHost } from './shared-host.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  type CodexPermissionMode,
} from './run.ts'

/** Deployment-owned configuration for the Codex main engine. */
export interface CodexEngineConfig {
  /** Native coding instructions used by generated model catalogs. */
  catalogInstructions?: string
  /** Native tool-output truncation token budget used unless a model overrides it. */
  catalogTruncationTokenLimit?: number
  /** Default model when the session names none; omission preserves native settings. */
  model?: string
  /** Extra native settings keyed by the registered LLM provider route; session selection chooses the row. */
  providers?: Record<string, CodexProviderOptions>
  /** Explicit environment entries layered over the subprocess seam's scrub. */
  env?: Record<string, string>
  /**
   * Provider route the engine runs against. Required only when more than one
   * configured provider serves the `openai-compatible` endpoint; the engine
   * then fails loudly instead of guessing.
   */
  provider?: string
  /** Legacy standalone adapter permission mode; managed execution uses session policy. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
  /** Milliseconds allowed for handshake and thread/turn startup. */
  startupTimeoutMs?: number
  /** Milliseconds allowed for native interrupt settlement. */
  interruptTimeoutMs?: number
  /** Native MCP call deadline in milliseconds; defaults to 3,660,000 to cover Team waits. */
  teamToolTimeoutMs?: number
  /** Maximum characters retained in one native activity argument/output. */
  /** Minimum interval between native child output updates. */
  activityUpdateIntervalMs?: number
  maxActivityCharacters?: number
  /**
   * Mirror the host's `~/.codex/AGENTS.md` into the per-session CODEX_HOME so
   * native global instructions load as they do for a direct CLI run. Defaults
   * to true; set false to keep session homes free of user instructions.
   */
  mirrorUserInstructions?: boolean
  /**
   * Project instruction filenames Codex falls back to when a workspace has no
   * `AGENTS.md`. Defaults to `CLAUDE.md`.
   */
  projectDocFallbackFilenames?: string[]
  /**
   * Fraction of the selected model's resolved context window used as the native
   * `model_auto_compact_token_limit` when neither route configuration nor an
   * exact-model override names one. Defaults to 0.9, matching the Claude
   * engine's compaction window. The resolved window itself is always passed as
   * `model_context_window` unless route configuration pins one.
   */
  autoCompactContextRatio?: number
}

/**
 * The engine definition the `codex` engine registers under.
 * @param factory - optional factory for executable registration.
 * @returns endpoint selection and advertised engine capabilities.
 */
export function codexEngineDefinition(factory?: AgentFactory): AgentEngineDefinition {
  return {
    name: 'Codex',
    capabilities: {
      textStream: 'delta',
      steering: 'unsupported',
      resume: 'native',
      fork: 'unsupported',
      approval: true,
      userInput: true,
      attachment: true,
    },
    endpoints: ['openai-compatible'],
    ...(factory === undefined ? {} : { factory }),
  }
}

/** One pending prompt and the turn driving it. */
interface PendingTurn {
  readonly message: UserMessage
  readonly signal: AbortController
}

/**
 * Main-chat Codex agent: a minimal but functional Agent whose turns run
 * through one managed app-server thread. Observable content lands in
 * provider-neutral engine events; the dedicated conversation projection is
 * the P4 gate that renders them.
 */
export class CodexMainAgent implements Agent {
  readonly options: Agent['options']
  readonly inbox: Inbox
  private statusValue: AgentStatus = 'idle'
  private activity: Promise<void> = Promise.resolve()
  private queue: PendingTurn[] = []
  private turnNumber = 0

  /**
   * @param id - shared agent/session identity.
   * @param session - the published DSH session this agent drives.
   * @param ctx - caller-owned context the agent registers listeners on.
   * @param adapter - managed app-server adapter owning the thread.
   * @param provider - configured provider route for the agent options.
   * @param model - configured native model, when fixed.
   */
  constructor(
    readonly id: SessionId,
    readonly session: Session,
    readonly ctx: Context,
    private readonly adapter: CodexTurnRunner,
    model: string | undefined,
    provider: string,
  ) {
    this.options = model === undefined ? { provider } : { provider, model }
    this.inbox = codexInbox(session)
  }

  /** The current lifecycle state; running while a Codex turn is active. */
  get status(): AgentStatus {
    return this.statusValue
  }

  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void {
    this.queue.push({ message, signal: new AbortController() })
    this.drive()
  }

  /** Unsupported capability: reject synchronously before any queue mutation. */
  steer(_message: UserMessage): void {
    throw new Error('subagent-codex: steering is unsupported for the Codex engine')
  }

  /** Unsupported capability: reject synchronously before any queue mutation. */
  inject(_message: UserMessage): void {
    throw new Error('subagent-codex: injection is unsupported for the Codex engine')
  }

  /** Route identified input to the next-turn inbox boundary and wake the driver. */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (target === 'next-step') {
      this.inbox.append('next-step', message)
      return
    }
    this.inbox.append('next-turn', message)
    if (wakeup) this.followup(message)
  }

  /** Interrupt the active turn; the first cause wins. */
  cancel(_cause: AgentCancelCause, _options?: CancelOptions): void {
    for (const turn of this.queue) turn.signal.abort()
    this.adapter.interrupt()
  }

  /** Resolve after the current whole-agent activity reaches quiescence. */
  whenIdle(): Promise<void> {
    return this.activity
  }

  /** Run one non-turn maintenance task from the true idle phase. */
  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = this.activity.then(() => task(new AbortController().signal))
    this.activity = result.then(() => undefined, () => undefined)
    return result
  }

  private drive(): void {
    this.activity = this.activity.then(() => this.driveLoop())
  }

  private async driveLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const pending = this.queue.shift()
      if (pending === undefined) break
      await this.runTurn(pending)
    }
  }

  private async runTurn(pending: PendingTurn): Promise<void> {
    const message = pending.message
    const inputId = randomUUID()
    this.statusValue = 'running'
    this.session.append('engine/input-submitted', {
      inputId,
      attemptId: randomUUID(),
      contentRef: 'text',
      operation: 'prompt',
    })
    this.session.append('turn/start', { turn: ++this.turnNumber })
    try {
      const texts = textBlocks(message.content)
      const output = await this.adapter.runTurn(texts, pending.signal.signal)
      this.session.append('engine/item-settled', {
        nativeItemId: inputId,
        revision: 1,
        category: 'assistant-text',
        payload: output,
      })
      this.session.append('engine/turn-settled', {
        turnId: inputId,
        outcome: 'completed',
      })
      this.session.append('turn/end', { turn: this.turnNumber, reason: { kind: 'completed' } })
    } catch (error: unknown) {
      this.session.append('engine/turn-settled', {
        turnId: inputId,
        outcome: 'error',
      })
      this.session.append('turn/end', {
        turn: this.turnNumber,
        reason: {
          kind: 'error',
          error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' },
        },
      })
    } finally {
      this.statusValue = 'idle'
    }
  }
}

/**
 * Register the `codex` execution engine on the Agent registry together with
 * the process-shared app-server host. The host pre-warms its child without
 * blocking registration; a failed prewarm retries on the first prepared turn,
 * which fails loud when the deployment cannot serve the engine.
 * @param ctx - context carrying the Agent registry and subprocess service.
 * @param config - model, environment, and disposal policy; the session
 * permission preset is the only permission source.
 * @param host - shared-server host override for tests; omission builds the
 * deployment host from `ctx` and `config`.
 * @returns the registration disposer.
 */
export function registerCodexEngine(
  ctx: Context, config: CodexEngineConfig = {}, host: CodexEngineSharedHost = new CodexEngineSharedHost(ctx, config),
): ReturnType<Context['agents']['registerEngine']> {
  void host.ensureStarted(new AbortController().signal).catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    ctx.logger.warn(`subagent-codex: shared app-server prewarm failed; the first prepared turn retries: ${failure.message}`)
  })
  ctx.effect(() => () => host.close(), 'subagent-codex.shared-host()')
  return ctx.agents.registerEngine(AgentEngineId('codex'), {
    ...codexEngineDefinition(new CodexMainFactory(ctx, config)),
    resolveReasoning: (provider, model, reasoning) => resolveCodexReasoning(reasoning, {
      ...config.providers?.[provider], ...config.providers?.[provider]?.models?.[model],
    }), driver: agent => new CodexExecutionDriver(ctx, agent, config, host),
  })
}

/** Main-chat Codex factory: creates one app-server-backed agent per session. */
export class CodexMainFactory implements AgentFactory {
  /**
   * @param _ctx - plugin registration context; execution is resolved lazily.
   * @param _config - defaults owned by the registered execution driver.
   */
  constructor(_ctx: Context, _config: CodexEngineConfig = {}) { void _ctx; void _config }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    return ownerCtx.agents.createManaged({ ...options, setup: async (agentCtx, agent) => {
      agent.session.append('engine/selected', { engineId: 'codex' })
      return options.setup?.(agentCtx, agent)
    } })
  }

  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return ownerCtx.agents.resumeManaged(options)
  }
}

/**
 * Extract the non-empty text block sequence of a prompt.
 * @param content - prompt blocks; non-text blocks and empty input are rejected.
 * @returns prompt text in block order.
 */
export function textBlocks(content: readonly ContentBlock[]): string[] {
  const texts: string[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: main-chat prompts must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.length === 0) throw new Error('subagent-codex: main-chat prompt must not be empty')
  return texts
}

/** A minimal durable inbox that records splices for the shared projection. */
function codexInbox(session: Session): Inbox {
  let nextTurn: UserMessage[] = []
  let nextStep: UserMessage[] = []
  const splice = (target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] => {
    const list = target === 'next-turn' ? nextTurn : nextStep
    const removed = list.splice(start, deleteCount, ...inserted)
    session.append('agent/inbox/spliced', { target, start, inserted, removedCount: removed.length })
    return removed
  }
  return {
    get nextTurn() { return nextTurn },
    get nextStep() { return nextStep },
    clear() {
      nextStep = []
      nextTurn = []
    },
    append(target, message) {
      splice(target, (target === 'next-turn' ? nextTurn : nextStep).length, 0, [message])
    },
    prepend(target, message) {
      splice(target, 0, 0, [message])
    },
    replace(messageId: MessageId, newMessage: UserMessage) {
      for (const target of ['next-turn', 'next-step'] as const) {
        const list = target === 'next-turn' ? nextTurn : nextStep
        const index = list.findIndex(message => message.id === messageId)
        if (index === -1) continue
        splice(target, index, 1, [newMessage])
        return true
      }
      return false
    },
    remove(messageId: MessageId) {
      for (const target of ['next-turn', 'next-step'] as const) {
        const list = target === 'next-turn' ? nextTurn : nextStep
        const index = list.findIndex(message => message.id === messageId)
        if (index === -1) continue
        splice(target, index, 1, [])
        return true
      }
      return false
    },
    splice,
  }
}

const codexQuestions = z.object({
  questions: z.array(z.object({
    id: z.string(), header: z.string(), question: z.string(), isSecret: z.boolean(),
    options: z.array(z.object({ label: z.string(), description: z.string() })).nullable(),
  })).min(1),
})

/** Session mode of the prepared execution: dedicated child or shared thread. */
interface PreparedShared {
  readonly server: CodexSharedAppServer
  readonly wire: CodexMainWire
}

/** Persistent interactive Codex provider under the shared Agent lifecycle. */
class CodexExecutionDriver implements EngineTurnDriver {
  private adapter: CodexMainAdapter | undefined
  private shared: PreparedShared | undefined
  private turnOptions: Record<string, unknown> | undefined
  private configured: string | undefined
  private teamBridge: TeamToolBridge | undefined
  private catalogContextWindow: number | undefined
  /** Whether the prepared connection advertised the native plan collaboration mode. */
  private planSupported = false
  private secrets: string[] = []
  private readonly children: ReturnType<typeof engineSubagentRecorder>
  private readonly activity: ReturnType<typeof engineActivityRecorder>
  private commandCatalogDigest: string | undefined
  private readonly unlistedModels = new Map<string, Set<string>>()
  private readonly activityOutput = new Map<string, string>()
  private activeTaskPermit: { taskId: import('@deepseek-ai/dsh-experimental-agent-team').TeamTaskId; generation: number } | undefined

  constructor(
    private readonly ctx: Context, private readonly agent: Agent, private readonly config: CodexEngineConfig,
    private readonly host: CodexEngineSharedHost,
  ) {
    this.children = engineSubagentRecorder(agent, 'codex', config.maxActivityCharacters ?? 65_536)
    this.activity = engineActivityRecorder(agent, config.maxActivityCharacters ?? 65_536)
  }

  async prepare(selection: ModelSelection, signal: AbortSignal): Promise<void> {
    acknowledgeUncertainEngineInputs(this.agent)
    const cwd = this.agent.session.header.cwd
    if (cwd === undefined) throw new Error('Codex needs a workspace directory')
    for (const key of Object.keys(this.config.env ?? {})) {
      if (['CODEX_HOME', 'CODEX_SQLITE_HOME'].includes(key)
        || /^DSH_CODEX_API_KEY/.test(key) || key.startsWith('DSH_CODEX_HEADER_')) {
        throw new Error(`Codex deployment env cannot override resolved ${key}`)
      }
    }
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) throw new Error('Codex needs the permission preset service')
    const policy = presets.effective(this.agent.session)
    const teamPermit = this.ctx.get('agentTeams')?.executionPermit(this.agent)
    const auto = presets.current(this.agent.session) === 'auto'
    // The session permission preset is the only permission source: a
    // full-access session translates straight into the native full-access
    // sandbox with no approvals, and no host config field redefines it.
    const permissions: CodexPermissionSettings = {
      sandbox: teamPermit?.managed === true ? 'read-only' : policy.sandbox,
      approvalPolicy: teamPermit?.managed === true ? 'on-request'
        : auto ? 'on-request' : policy.approval === 'never' ? 'never' : 'on-request',
      approvalsReviewer: auto ? 'auto_review' : 'user',
    }
    if (this.teamBridge === undefined) this.teamBridge = await startTeamToolBridge(this.agent, signal)
    if (this.teamBridge !== undefined) {
      // Team sessions carry a per-agent MCP bridge that only a dedicated
      // app-server child can name; they keep one child per session.
      this.closeShared()
      return this.prepareDedicated(selection, signal, cwd, { policy, auto, permissions,
        ...teamPermit === undefined ? {} : { teamPermit } })
    }
    await this.closeDedicated()
    return this.prepareShared(selection, signal, cwd, permissions)
  }

  /** Per-session child path: full restart semantics with a per-session native home. */
  private async prepareDedicated(
    selection: ModelSelection, signal: AbortSignal, cwd: string,
    policyState: {
      policy: unknown
      auto: boolean
      permissions: CodexPermissionSettings
      teamPermit?: import('@deepseek-ai/dsh-experimental-agent-team').TeamExecutionPermit
    },
  ): Promise<void> {
    const endpoint = await resolveCodexEndpoint(this.ctx, selection.provider)
    if (endpoint === undefined) throw new Error('Selected provider has no Codex Responses endpoint')
    const projectDocFallbackFilenames = [
      ...this.config.projectDocFallbackFilenames ?? DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES,
    ]
    const retainedModels = this.unlistedModels.get(selection.provider) ?? new Set<string>()
    const catalog = await resolveCodexModelCatalog(this.ctx, selection.provider, selection.model, {
      instructions: this.config.catalogInstructions ?? DEFAULT_CATALOG_INSTRUCTIONS,
      truncationTokenLimit: this.config.catalogTruncationTokenLimit ?? DEFAULT_CATALOG_TRUNCATION_TOKEN_LIMIT,
    }, this.config.providers?.[selection.provider], [...retainedModels])
    this.unlistedModels.set(selection.provider, new Set(catalog.unlistedModelIds))
    const resolvedContextWindow = catalog.contextWindows[selection.model]
    const providerSpec = await resolveCodexProviderSpec(this.ctx, endpoint, selection.model,
      this.config.providers?.[selection.provider], {
        ...resolvedContextWindow === undefined ? {} : { contextWindow: resolvedContextWindow },
        autoCompactContextRatio: this.config.autoCompactContextRatio ?? DEFAULT_AUTO_COMPACT_CONTEXT_RATIO,
      })
    const reasoning = catalog.reasoningByModel[selection.model]
    const effort = resolveEngineEffort(reasoning, selection.reasoningEffort) ?? undefined
    const signature = JSON.stringify({ dedicated: true, provider: selection.provider, effort,
      endpoint, providerSpec, policy: policyState.policy, auto: policyState.auto, catalog, permissions: policyState.permissions,
      teamPermit: policyState.teamPermit,
      projectDocFallbackFilenames })
    this.catalogContextWindow = catalog.contextWindows[selection.model]
    if (this.adapter !== undefined && signature === this.configured) {
      if (this.turnOptions === undefined) throw new Error('Codex prepared process has no turn settings')
      this.applyTurnSelection(this.turnOptions, selection, effort)
      return
    }
    await this.closeDedicated()
    signal.throwIfAborted()
    this.secrets = providerSpec.secrets
    const { saved, nativeStorage } = await this.prepareNativeHome((home, saved, hasHistory, mirror) =>
      prepareCodexHome(home, this.agent.session.id, saved, cwd, hasHistory, mirror))
    const taskProfile = policyState.teamPermit?.managed === true
      ? `dsh-task-${createHash('sha256').update(JSON.stringify({
        taskId: policyState.teamPermit.taskId ?? 'unassigned',
        generation: policyState.teamPermit.generation ?? 0,
        writeScopes: policyState.teamPermit.authorized ? policyState.teamPermit.writeScopes : [],
      })).digest('hex').slice(0, 16)}` : undefined
    if (taskProfile !== undefined) await writeTeamTaskPermissionProfile(nativeStorage.home, taskProfile,
      policyState.teamPermit?.authorized === true ? policyState.teamPermit.writeScopes : [])
    const storage = nativeStorage.home
    const catalogPath = await writeCodexModelCatalog(storage, catalog.contents)
    const ownedEnv = { ...providerSpec.env, CODEX_HOME: storage, CODEX_SQLITE_HOME: join(storage, 'sqlite') }
    const configArgs = [...providerSpec.configArgs,
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      `sqlite_home=${JSON.stringify(ownedEnv.CODEX_SQLITE_HOME)}`, `log_dir=${JSON.stringify(join(storage, 'log'))}`,
      ...projectDocFallbackFilenames.length === 0 ? []
        : [`project_doc_fallback_filenames=${JSON.stringify(projectDocFallbackFilenames)}`],
      ...effort === undefined ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`],
    ]
    const turnOptions: Record<string, unknown> = { model: selection.model, approvalPolicy: policyState.permissions.approvalPolicy,
      approvalsReviewer: policyState.permissions.approvalsReviewer,
      ...effort === undefined ? {} : { effort } }
    const bridge = this.teamBridge
    if (bridge !== undefined) {
      this.secrets.push(bridge.authorization)
      configArgs.push(`mcp_servers.dsh_team.url=${JSON.stringify(bridge.url)}`,
        'mcp_servers.dsh_team.env_http_headers={ Authorization = "DSH_TEAM_AUTHORIZATION" }',
        `mcp_servers.dsh_team.tool_timeout_sec=${(this.config.teamToolTimeoutMs ?? 3_660_000) / 1000}`,
        'mcp_servers.dsh_team.required=true',
        'mcp_servers.dsh_team.default_tools_approval_mode="approve"')
    }
    const adapter = new CodexMainAdapter({
      cwd, permissionMode: 'never', model: selection.model,
      env: { ...this.config.env, ...ownedEnv,
        ...bridge === undefined ? {} : { DSH_TEAM_AUTHORIZATION: bridge.authorization } },
      argv: codexAppServerArgvWith(configArgs),
      disposeGraceMs: this.config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      interruptTimeoutMs: this.config.interruptTimeoutMs ?? 10_000,
      onThreadId: (id) => { recordNativeBinding(this.agent, 'codex', id) },
      wireOptions: {
        ...this.wireCallbacks(cwd),
        expectedModelIds: catalog.modelIds,
        thread: { model: selection.model, modelProvider: 'dsh_engine',
          ...taskProfile === undefined ? { sandbox: policyState.permissions.sandbox } : { permissions: taskProfile },
          approvalPolicy: policyState.permissions.approvalPolicy,
          approvalsReviewer: policyState.permissions.approvalsReviewer,
        },
        turn: turnOptions,
        ...saved === undefined || nativeStorage.rolloutPath === undefined ? {}
          : { resumeThreadId: saved, resumeThreadPath: nativeStorage.rolloutPath },
        startupTimeoutMs: this.config.startupTimeoutMs ?? 30_000,
      },
      spawn: spec => this.ctx.subprocess.spawn(spec),
    })
    try {
      await adapter.start(signal)
      try {
        this.planSupported = (await adapter.listCollaborationModes(signal)).includes('plan')
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // An app-server without the collaboration-mode surface keeps every
        // other command; /plan stays unregistered instead of failing turns.
        this.planSupported = false
      }
      if (enginePlanModeFor(this.agent, 'codex') === true) adapter.setCollaborationMode('plan')
      this.agent.session.append('engine/item-settled', {
        nativeItemId: `codex-model-catalog:${createHash('sha256').update(catalog.contents).digest('hex')}`,
        revision: 1, category: 'model-catalog',
        payload: { engineId: 'codex', provider: selection.provider, contents: catalog.contents },
      })
    } catch (error: unknown) {
      await adapter.close()
      await this.teamBridge?.close()
      this.teamBridge = undefined
      throw this.failure(error)
    }
    this.adapter = adapter
    this.turnOptions = turnOptions
    this.configured = signature
    this.agent.session.append('engine/item-settled', {
      nativeItemId: 'codex-model-selection', revision: 1, category: 'model-selection',
      payload: { engineId: 'codex', ...selection },
    })
  }

  /** Shared-child path: one process-wide app-server, this session as one native thread. */
  private async prepareShared(
    selection: ModelSelection, signal: AbortSignal, cwd: string, permissions: CodexPermissionSettings,
  ): Promise<void> {
    const server = await this.host.ensureStarted(signal)
    const nativeProvider = server.nativeProviderFor(selection.provider)
    const catalog = server.catalog
    const resolvedContextWindow = catalog.contextWindows[selection.model]
    const reasoning = catalog.reasoningByModel[selection.model]
    const effort = resolveEngineEffort(reasoning, selection.reasoningEffort) ?? undefined
    const turnOptions: Record<string, unknown> = { model: selection.model, approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      ...effort === undefined ? {} : { effort } }
    this.catalogContextWindow = resolvedContextWindow
    // Model and effort travel per turn; the thread-level values pin the reattach.
    const signature = JSON.stringify({ dedicated: false, nativeProvider,
      sandbox: permissions.sandbox, approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer })
    const wire = this.shared?.wire
    // A restarted shared child invalidates the previous attachment even when
    // its wire never observed the swap.
    if (wire !== undefined && this.shared?.server === server && wire.fatalError() === undefined
      && signature === this.configured) {
      if (this.turnOptions === undefined) throw new Error('Codex prepared thread has no turn settings')
      this.applyTurnSelection(this.turnOptions, selection, effort)
      return
    }
    this.closeShared()
    signal.throwIfAborted()
    this.secrets = [...server.spec.secrets]
    const { saved, nativeStorage } = await this.prepareNativeHome((home, saved, hasHistory, mirror) =>
      prepareSharedCodexHome(home, this.agent.session.id, saved, cwd, hasHistory, mirror))
    if (!catalog.modelIds.includes(selection.model)) {
      await this.host.noteUnlistedModel(selection.provider, selection.model, signal)
    }
    const bridge = this.teamBridge
    if (bridge !== undefined) this.secrets.push(bridge.authorization)
    const nextWire = await server.attach(cwd, {
      ...this.wireCallbacks(cwd),
      thread: { model: selection.model, modelProvider: nativeProvider,
        sandbox: permissions.sandbox, approvalPolicy: permissions.approvalPolicy,
        approvalsReviewer: permissions.approvalsReviewer,
      },
      turn: turnOptions,
      ...saved === undefined || nativeStorage.rolloutPath === undefined ? {}
        : { resumeThreadId: saved, resumeThreadPath: nativeStorage.rolloutPath },
      startupTimeoutMs: this.config.startupTimeoutMs ?? 30_000,
      onTurnActive: (active) => { if (active) server.noteTurnActive(); else server.noteTurnSettled() },
    }, signal)
    const threadId = nextWire.capturedThreadId()
    if (threadId !== undefined) recordNativeBinding(this.agent, 'codex', threadId)
    this.shared = { server, wire: nextWire }
    this.turnOptions = turnOptions
    this.configured = signature
    this.planSupported = server.planSupported
    if (enginePlanModeFor(this.agent, 'codex') === true) nextWire.setCollaborationMode('plan')
    this.agent.session.append('engine/item-settled', {
      nativeItemId: `codex-model-catalog:${createHash('sha256').update(server.catalog.contents).digest('hex')}`,
      revision: 1, category: 'model-catalog',
      payload: { engineId: 'codex', provider: selection.provider, contents: server.catalog.contents },
    })
    this.agent.session.append('engine/item-settled', {
      nativeItemId: 'codex-model-selection', revision: 1, category: 'model-selection',
      payload: { engineId: 'codex', ...selection },
    })
  }

  /** Apply a changed selection onto the live turn options without reattachment. */
  private applyTurnSelection(turnOptions: Record<string, unknown>, selection: ModelSelection, effort: string | undefined): void {
    if (turnOptions.model !== selection.model) this.agent.session.append('engine/item-settled', {
      nativeItemId: 'codex-model-selection', revision: 1, category: 'model-selection',
      payload: { engineId: 'codex', ...selection },
    })
    turnOptions.model = selection.model
    if (effort === undefined) delete turnOptions.effort
    else turnOptions.effort = effort
  }

  /** Protocol callbacks shared by the dedicated child and the shared server. */
  private wireCallbacks(cwd: string): Pick<CodexMainWireOptions, 'onRequest' | 'onCommandsChange' | 'onCommandCatalog'
    | 'onSubagent' | 'onSubagentDisconnect' | 'onActivity' | 'maxActivityCharacters' | 'activityUpdateIntervalMs'> {
    return {
      onCommandsChange: () => { this.ctx.emit('commands/change') },
      onCommandCatalog: (skills) => {
        const digest = createHash('sha256').update(JSON.stringify(skills)).digest('hex')
        if (digest === this.commandCatalogDigest) return
        this.agent.session.append('engine/item-settled', {
          nativeItemId: `codex-command-catalog:${digest}`, revision: 1, category: 'command-catalog',
          payload: { engineId: 'codex', cwd, skills },
        })
        this.commandCatalogDigest = digest
      },
      onRequest: async (method, params, interactionSignal) => {
        if (method === 'item/tool/requestUserInput') {
          const questions = codexQuestions.parse(params).questions
          if (questions.some(question => question.isSecret)) throw new Error('Secret user input is not supported by the chat question UI')
          const service = this.ctx.get('userQuestions')
          if (service === undefined) throw new Error('No user question service is configured')
          const answer = await service.ask({ agent: this.agent, signal: interactionSignal,
            questions: questions.map(question => ({ id: question.id, header: question.header, question: question.question,
              ...question.options === null ? {} : { options: question.options },
            })),
          })
          return { answers: Object.fromEntries(answer.answers.map(value => [value.id,
            { answers: [...value.selected, ...value.custom === undefined ? [] : [value.custom]] },
          ])) }
        }
        const currentPermit = this.ctx.get('agentTeams')?.executionPermit(this.agent)
        if (currentPermit?.managed === true) {
          if (this.activeTaskPermit === undefined
            || !this.ctx.get('agentTeams')?.executionPermitIsCurrent(
              this.agent, this.activeTaskPermit.taskId, this.activeTaskPermit.generation,
            )) throw new Error('Codex task execution permit is absent or expired')
        }
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
          throw new Error(`Unsupported Codex interaction "${method}"`)
        }
        const approval = this.ctx.get('approval')
        const allowed = approval !== undefined && await approval.request({
          agent: this.agent, toolName: method, reason: JSON.stringify(params), signal: interactionSignal,
        }) === 'allowed-once'
        if (method === 'item/permissions/requestApproval') {
          const requested = z.object({ network: z.record(z.string(), z.unknown()).nullable(),
            fileSystem: z.record(z.string(), z.unknown()).nullable(),
          }).parse(params.permissions)
          return { permissions: allowed ? {
            ...requested.network === null ? {} : { network: requested.network },
            ...requested.fileSystem === null ? {} : { fileSystem: requested.fileSystem },
          } : {}, scope: 'turn' }
        }
        const available = params.availableDecisions
        const decision = allowed ? 'accept' : 'decline'
        if (Array.isArray(available) && !available.includes(decision)) throw new Error('Codex did not offer the requested one-shot decision')
        return { decision }
      },
      onSubagent: (id, patch) => { this.children.update(id, patch) },
      onSubagentDisconnect: () => { this.children.disconnect() },
      onActivity: (method, params) => {
        if (method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
          const id = `${String(params.threadId)}:${String(params.turnId)}:${params.itemId}`
          const output = ((this.activityOutput.get(id) ?? '') + params.delta).slice(0, this.config.maxActivityCharacters ?? 65_536)
          this.activityOutput.set(id, output)
          this.activity(id, { output, status: 'running' })
          return
        }
        const item = params.item
        if (item === null || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string'
          || !('type' in item) || typeof item.type !== 'string') return
        if (['userMessage', 'reasoning', 'plan'].includes(item.type)) return
        const id = `${String(params.threadId)}:${String(params.turnId)}:${item.id}`
        const output = 'aggregatedOutput' in item && typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput
          : 'changes' in item ? JSON.stringify(item.changes) : 'result' in item ? JSON.stringify(item.result) : ''
        this.activity(id, { name: item.type, argsRaw: JSON.stringify(item), output,
          status: method === 'item/started' ? 'running'
            : ('status' in item && ['failed', 'declined'].includes(String(item.status))) ? 'failed' : 'completed',
        })
      },
      maxActivityCharacters: this.config.maxActivityCharacters ?? 65_536,
      activityUpdateIntervalMs: this.config.activityUpdateIntervalMs ?? 100,
    }
  }

  /**
   * Resolve the session's persistent native identity and prepare its home.
   * @param prepare - the mode's home preparation over resolved identity inputs.
   * @returns the saved binding, prepared storage, and owning harness home.
   */
  private async prepareNativeHome(
    prepare: (home: string, saved: string | undefined, hasHistory: boolean, mirror: string | null)
    => Promise<CodexSessionStorage>,
  ): Promise<{ saved: string | undefined; nativeStorage: CodexSessionStorage }> {
    const home = this.ctx.get('profileContext')?.home
    if (home === undefined) throw new Error('Codex needs the Harness home for persistent threads')
    const saved = nativeBindingFor(this.agent, 'codex')
    // oxlint-disable-next-line typescript/no-deprecated -- Reject legacy external history without a recoverable native identity.
    const hasHistory = this.agent.session.snapshotEvents().some(event =>
      event.type === 'user/message' || event.type === 'engine/input-submitted')
    if (saved === undefined && hasHistory) {
      throw new Error('External history has no persisted native session identity; create a new session instead of resetting its history')
    }
    const mirror = this.config.mirrorUserInstructions === false ? null : join(homedir(), '.codex', 'AGENTS.md')
    const nativeStorage = await prepare(home, saved, hasHistory, mirror)
    await syncEngineSkillDirectories(join(nativeStorage.home, 'skills'),
      [join(homedir(), '.codex', 'skills'), join(home, 'skills')])
    return { saved, nativeStorage }
  }

  /** Close the dedicated child, awaiting quiescence. */
  private async closeDedicated(): Promise<void> {
    await this.adapter?.close()
    this.adapter = undefined
  }

  /** Detach this session's shared thread; the child and other threads stay. */
  private closeShared(): void {
    this.shared?.wire.close()
    this.shared = undefined
  }

  /** Native-reported context capacity, falling back to the prepared catalog value. */
  contextWindow(): number | undefined {
    return (this.adapter ?? this.shared?.wire)?.contextWindow() ?? this.catalogContextWindow
  }

  /** List mapped native operations and enabled workspace skills from app-server. */
  async commands(): Promise<readonly AgentEngineCommand[]> {
    const skills = await this.skills()
    const controls = new Set(['compact', 'review', 'model', 'permission'])
    return [
      ...this.planSupported
        ? [{ name: 'plan', description: 'Toggle the native plan collaboration mode', argumentHint: '[off]', execution: 'action' as const }]
        : [],
      { name: 'compact', description: 'Summarize the Codex thread to free context', execution: 'action' },
      { name: 'review', description: 'Review uncommitted changes or follow custom review instructions', argumentHint: '[instructions]', execution: 'prompt' },
      ...skills.filter(skill => !controls.has(skill.name)).map(skill => ({
        name: skill.name, kind: 'skill' as const, description: skill.description, argumentHint: '[arguments]', execution: 'prompt' as const,
      })),
    ]
  }

  /** Enabled native skills from the prepared connection. */
  private async skills(): Promise<readonly CodexCommandSkill[]> {
    if (this.adapter !== undefined) return this.adapter.listSkills()
    if (this.shared !== undefined) return this.shared.wire.listSkills(new AbortController().signal)
    throw new Error('Codex was not prepared')
  }

  /** Execute a supported app-server action command. */
  async executeCommand(name: string, args: string, signal: AbortSignal): Promise<void> {
    if (name === 'plan') {
      if (!this.planSupported) {
        throw new Error('The pinned Codex build does not support collaboration modes; upgrade Codex to use /plan')
      }
      // The mode applies from the next turn onward; the protocol carries it as a
      // per-turn parameter and validates it again at turn start.
      const enter = args.trim() !== 'off'
      const mode = enter ? 'plan' : 'default'
      if (this.adapter !== undefined) this.adapter.setCollaborationMode(mode)
      else if (this.shared !== undefined) this.shared.wire.setCollaborationMode(mode)
      else throw new Error('Codex was not prepared')
      recordEnginePlanMode(this.agent, 'codex', enter)
      return
    }
    if (name !== 'compact' || args.trim() !== '') throw new Error(`unsupported Codex command /${name}`)
    const id = randomUUID()
    this.activity(id, { name: `/${name}`, argsRaw: JSON.stringify({ args }), status: 'running' })
    try {
      if (this.adapter !== undefined) await this.adapter.compact(signal)
      else if (this.shared !== undefined) await this.shared.wire.compact(signal)
      else throw new Error('Codex was not prepared')
      this.activity(id, { status: 'completed' })
    } catch (error: unknown) {
      const failure = this.failure(error)
      this.activity(id, { status: 'failed', output: failure.message })
      throw failure
    } finally { this.activity.finish(); this.activityOutput.clear() }
  }

  async run(messages: readonly UserMessage[], signal: AbortSignal, emit: Parameters<EngineTurnDriver['run']>[2]): Promise<void> {
    if (this.adapter === undefined && this.shared === undefined) throw new Error('Codex was not prepared')
    const finishTools = this.teamBridge?.beginTurn(signal)
    const permit = this.ctx.get('agentTeams')?.executionPermit(this.agent)
    this.activeTaskPermit = permit?.managed === true && permit.authorized === true
      && permit.taskId !== undefined && permit.generation !== undefined
      ? { taskId: permit.taskId, generation: permit.generation } : undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const wire = this.shared?.wire
    const onAbort = wire === undefined ? undefined : (): void => {
      wire.interrupt()
      timer = setTimeout(() => { wire.close() }, this.config.interruptTimeoutMs ?? 10_000)
    }
    if (wire !== undefined && onAbort !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    try {
      const input: CodexMainInput[] = []
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'text') input.push({ type: 'text', text: block.text })
          else if (block.type === 'image') {
            if (block.offloaded === true) {
              input.push({ type: 'text', text: textOnlyImageText(block.attachment) })
              continue
            }
            const stored = await this.ctx.attachments.readImage(block.attachment, signal)
            input.push({ type: 'image', url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` })
          } else if (block.type === 'file') {
            throw new Error('Codex main conversations do not support file attachments')
          }
        }
      }
      if (input.length === 0) throw new Error('Codex main conversation input must not be empty')
      if (this.adapter !== undefined) await this.adapter.runTurn(input, signal, emit, messages[0]?.id)
      else if (wire !== undefined) await wire.runTurn(input, signal, emit, messages[0]?.id)
    } catch (error: unknown) {
      throw this.failure(error)
    } finally {
      if (wire !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
      await finishTools?.()
      this.activity.finish()
      this.activityOutput.clear()
      this.activeTaskPermit = undefined
    }
  }

  async close(): Promise<void> {
    this.children.disconnect()
    await this.teamBridge?.close()
    this.teamBridge = undefined
    await this.closeDedicated()
    this.closeShared()
    this.turnOptions = undefined
    this.configured = undefined
    this.planSupported = false
    this.secrets = []
  }

  private failure(error: unknown): Error {
    return this.secrets.reduce<Error>((safe, secret) => engineFailure(safe, secret), engineFailure(error, undefined))
  }
}
