/** Main conversation execution provider sharing the managed Agent lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands/types'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { LlmModelReasoningInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { z } from 'zod'
import {
  AgentEngineId, mapEngineReasoning, resolveEngineEffort, type EngineReasoningOptions,
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
import { createUserMessage, textOnlyImageText, ToolCallId, type ContentBlock, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import { resolveClaudeEndpoint } from './endpoint.ts'
import { answerClaudeElicitation } from './elicitation.ts'
import { CLAUDE_UNSUPPORTED_LIFECYCLE_COMMANDS, ClaudeMainAdapter, type ClaudePromptBlock, type ClaudeTurnRunner } from './main-adapter.ts'
import { syncEngineSkillDirectories, startTeamToolBridge, type TeamToolBridge } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { mirrorUserMemory } from './user-memory.ts'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  type ClaudeCodePermissionMode,
} from './run.ts'

/** Exact-model reasoning mappings restricted to SDK effort values. */
export interface ClaudeReasoningOptions extends EngineReasoningOptions {
  /** Selectable ids mapped to SDK effort values; null explicitly disables thinking. */
  reasoningEfforts?: Record<string, Extract<NonNullable<Options['effort']>, string> | null>
}

/** Per-route aliases used by Claude's built-in model picker and internal subagents. */
export interface ClaudeProviderOptions extends ClaudeReasoningOptions {
  /** Wire model behind the Opus alias. */
  opusModel?: string
  /** Wire model behind the Sonnet alias. */
  sonnetModel?: string
  /** Wire model behind the Haiku alias. */
  haikuModel?: string
  /** Wire model used by Claude's internal subagents. */
  subagentModel?: string
  /** Reasoning overrides keyed by exact model id; each overrides provider defaults. */
  models?: Record<string, ClaudeReasoningOptions>
}

/** Deployment-owned configuration for the Claude main engine. */
export interface ClaudeEngineConfig {
  /** Executable path or PATH name; omitted to detect the host CLI before using the SDK payload. */
  pathToClaudeCodeExecutable?: string
  /** Native Claude model fixed for this instance; omitted to preserve Claude settings. */
  model?: string
  /** Alias mappings keyed by registered LLM provider route. */
  providers?: Record<string, ClaudeProviderOptions>
  /** Explicit environment entries layered over the subprocess seam's scrub. */
  env?: Record<string, string>
  /**
   * Provider route the engine runs against. Required only when more than one
   * configured provider serves the `anthropic-api` endpoint; the engine then
   * fails loudly instead of guessing.
   */
  provider?: string
  /** Grace in milliseconds between subprocess managed-range termination tiers. */
  disposeGraceMs?: number
  /** Milliseconds allowed for SDK initialization. */
  startupTimeoutMs?: number
  /** Milliseconds allowed for native interrupt settlement. */
  interruptTimeoutMs?: number
  /** Native MCP call deadline in milliseconds; defaults to 3,660,000 to cover Team waits. */
  teamToolTimeoutMs?: number
  /** Maximum characters retained in one native activity argument/output. */
  maxActivityCharacters?: number
  /** Minimum milliseconds between progress observations for one native tool. */
  activityUpdateIntervalMs?: number
}

/**
 * The engine definition the `claude` engine registers under.
 * @param factory - optional factory for executable registration.
 * @returns endpoint selection and advertised engine capabilities.
 */
export function claudeEngineDefinition(factory?: AgentFactory): AgentEngineDefinition {
  return {
    name: 'Claude',
    capabilities: {
      textStream: 'delta',
      steering: 'unsupported',
      resume: 'native',
      fork: 'unsupported',
      approval: true,
      userInput: true,
      attachment: true,
    },
    endpoints: ['anthropic-api'],
    ...(factory === undefined ? {} : { factory }),
  }
}

/** One pending prompt and the turn driving it. */
interface PendingTurn {
  readonly message: UserMessage
  readonly signal: AbortController
}

/**
 * Main-chat Claude agent: a minimal but functional Agent whose turns run
 * through one managed CLI process in streaming-input mode. Observable content
 * lands in provider-neutral engine events; the dedicated conversation
 * projection is the P4 gate that renders them.
 */
export class ClaudeMainAgent implements Agent {
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
   * @param adapter - managed SDK adapter owning the CLI session.
   * @param model - configured native model, when fixed.
   * @param provider - selected provider route.
   */
  constructor(
    readonly id: SessionId,
    readonly session: Session,
    readonly ctx: Context,
    private readonly adapter: ClaudeTurnRunner,
    model: string | undefined,
    provider: string,
  ) {
    this.options = model === undefined ? { provider } : { provider, model }
    this.inbox = engineInbox(session)
  }

  /** The current lifecycle state; running while a Claude turn is active. */
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
    throw new Error('subagent-claude-code: steering is unsupported for the Claude engine')
  }

  /** Unsupported capability: reject synchronously before any queue mutation. */
  inject(_message: UserMessage): void {
    throw new Error('subagent-claude-code: injection is unsupported for the Claude engine')
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
 * Register the `claude` execution engine on the Agent registry.
 * @param ctx - context carrying the Agent registry and subprocess service.
 * @param config - model, environment, and disposal policy; the session
 * permission preset is the only permission source.
 * @returns the registration disposer.
 */
export function registerClaudeEngine(
  ctx: Context, config: ClaudeEngineConfig = {},
): ReturnType<Context['agents']['registerEngine']> {
  const factory = new ClaudeMainFactory(ctx, config)
  return ctx.agents.registerEngine(AgentEngineId('claude'), {
    ...claudeEngineDefinition(factory),
    resolveReasoning: (provider, model, reasoning) => resolveClaudeReasoning(reasoning, {
      ...config.providers?.[provider], ...config.providers?.[provider]?.models?.[model],
    }), driver: agent => new ClaudeExecutionDriver(ctx, agent, config),
  })
}

/** Main-chat Claude factory: creates one SDK-backed agent per session. */
export class ClaudeMainFactory implements AgentFactory {
  /**
   * @param _ctx - plugin registration context; execution is resolved lazily.
   * @param _config - defaults owned by the registered execution driver.
   */
  constructor(_ctx: Context, _config: ClaudeEngineConfig = {}) { void _ctx; void _config }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    return ownerCtx.agents.createManaged({ ...options, setup: async (agentCtx, agent) => {
      agent.session.append('engine/selected', { engineId: 'claude' })
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
      throw new Error('subagent-claude-code: main-chat prompts must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.length === 0) throw new Error('subagent-claude-code: main-chat prompt must not be empty')
  return texts
}

/** A minimal durable inbox that records splices for the shared projection. */
function engineInbox(session: Session): Inbox {
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

const questionSchema = z.object({
  questions: z.array(z.object({
    question: z.string(), header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    multiSelect: z.boolean().optional(),
  })).min(1),
})

/**
 * Resolve the native permission mode one session runs under. The session
 * permission preset is the only permission source: a policy that grants full
 * access with no approval translates into the native bypass mode and
 * workspace write accepts file edits while every other tool still asks;
 * read-only and ask-approval full access keep the native default prompt
 * behavior, so the harness approval service decides every action.
 * @param policy - effective session sandbox and approval policy.
 * @returns the native mode, or undefined for the native default behavior.
 */
export function resolveClaudePermissionMode(policy: PresetSpec): ClaudeCodePermissionMode | undefined {
  if (policy.sandbox === 'danger-full-access') {
    return policy.approval === 'never' ? 'bypassPermissions' : undefined
  }
  return policy.sandbox === 'workspace-write' ? 'acceptEdits' : undefined
}

/**
 * Sandbox block one effective session policy selects; full access runs with no
 * flag-layer sandbox, matching the option the engine omits at startup.
 * @param policy - effective session sandbox and approval policy.
 * @param cwd - session workspace root.
 * @returns the complete native sandbox block, or undefined for full access.
 */
function claudeSandboxSettings(
  policy: PresetSpec, cwd: string,
): NonNullable<Settings['sandbox']> | undefined {
  if (policy.sandbox === 'danger-full-access') return undefined
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: policy.sandbox === 'workspace-write' && policy.approval === 'ask',
    filesystem: { allowWrite: policy.sandbox === 'read-only' ? [] : [cwd] },
  }
}

/** Comparable identity of one sandbox block; null distinguishes full access. */
function sandboxKey(sandbox: NonNullable<Settings['sandbox']> | undefined): string {
  return JSON.stringify(sandbox ?? null)
}

/** Preserve an explicit Claude model name when optional provider metadata cannot resolve it. */
async function resolveClaudeModelInfo(
  ctx: Context,
  selection: ModelSelection,
  signal: AbortSignal,
): Promise<LlmResolvedModelInfo> {
  try {
    return await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
  } catch (error) {
    if (signal.aborted) throw error
    return { provider: selection.provider, id: selection.model, name: selection.model }
  }
}

/** Official SDK execution provider; the shared lifecycle owns its Agent and Session. */
class ClaudeExecutionDriver implements EngineTurnDriver {
  private adapter: ClaudeMainAdapter | undefined
  private configured: string | undefined
  private teamBridge: TeamToolBridge | undefined
  private credential: string | undefined
  private activeSignal: AbortSignal | undefined
  private activeTaskPermit: { taskId: import('@deepseek-ai/dsh-experimental-agent-team').TeamTaskId; generation: number } | undefined
  /** Session-policy permission mode that exits from plan mode restores. */
  private basePermissionMode: ClaudeCodePermissionMode | undefined
  /** Sandbox block currently applied to the prepared process, as JSON. */
  private liveSandbox: string | undefined
  /** Native permission mode currently applied to the prepared process. */
  private liveMode: ClaudeCodePermissionMode | undefined
  private readonly children: ReturnType<typeof engineSubagentRecorder>
  private readonly activity: ReturnType<typeof engineActivityRecorder>

  constructor(
    private readonly ctx: Context, private readonly agent: Agent, private readonly config: ClaudeEngineConfig,
  ) {
    this.children = engineSubagentRecorder(agent, 'claude', config.maxActivityCharacters ?? 65_536)
    this.activity = engineActivityRecorder(agent, config.maxActivityCharacters ?? 65_536)
  }

  async prepare(selection: ModelSelection, signal: AbortSignal): Promise<void> {
    acknowledgeUncertainEngineInputs(this.agent)
    const cwd = this.agent.session.header.cwd
    if (cwd === undefined) throw new Error('Claude needs a workspace directory')
    const endpoint = await resolveClaudeEndpoint(this.ctx, selection.provider)
    if (endpoint === undefined) throw new Error('Selected provider has no Claude Code endpoint')
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) throw new Error('Claude needs the permission preset service')
    const policy = presets.effective(this.agent.session)
    const basePermissionMode = resolveClaudePermissionMode(policy)
    const teamPermit = this.ctx.get('agentTeams')?.executionPermit(this.agent)
    const taskManaged = teamPermit?.managed === true
    const taskCanWrite = teamPermit?.authorized === true && teamPermit.writeScopes.length > 0
    // A persisted plan switch outlives adapter replacement; the deployment mode
    // stays the restore target and the signature must not track dynamic switches.
    const planMode = enginePlanModeFor(this.agent, 'claude') ?? false
    this.basePermissionMode = basePermissionMode
    const permissionMode = planMode ? 'plan' as const : taskManaged ? undefined : basePermissionMode
    const tools = policy.sandbox === 'read-only' || (taskManaged && !taskCanWrite)
      ? ['Read', 'Glob', 'Grep', 'AskUserQuestion'] : undefined
    const sandboxSettings = taskManaged ? {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: taskCanWrite ? teamPermit.writeScopes.map(scope => resolve(cwd, scope)) : [] },
    } satisfies NonNullable<Settings['sandbox']> : claudeSandboxSettings(policy, cwd)
    const metadata = await resolveClaudeModelInfo(this.ctx, selection, signal)
    const reasoning = resolveClaudeReasoning(metadata.reasoning, {
      ...this.config.providers?.[selection.provider], ...this.config.providers?.[selection.provider]?.models?.[selection.model],
    })
    const effort = resolveEngineEffort(reasoning, selection.reasoningEffort)
    const aliases = this.config.providers?.[selection.provider]
    const aliasEnv = {
      ANTHROPIC_DEFAULT_OPUS_MODEL: aliases?.opusModel ?? this.config.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? selection.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: aliases?.sonnetModel ?? this.config.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? selection.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: aliases?.haikuModel ?? this.config.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? selection.model,
      CLAUDE_CODE_SUBAGENT_MODEL: aliases?.subagentModel ?? this.config.env?.CLAUDE_CODE_SUBAGENT_MODEL ?? selection.model,
    }
    const contextWindow = metadata.context?.contextWindow
    // The signature covers only what a running process cannot change through a
    // control request; the session policy reconciles live through
    // `reconcileLivePermission` and rebuilds only when that is refused.
    const signature = JSON.stringify({
      selection, effort, endpoint, aliasEnv, contextWindow, tools: tools ?? null,
      taskManaged, taskPermit: teamPermit,
    })
    if (this.adapter?.isReady() === true && this.configured === signature
      && await this.reconcileLivePermission(planMode, basePermissionMode, sandboxSettings, signal)) return
    // The native process captures its URL and credentials at startup.
    await this.close()
    signal.throwIfAborted()
    this.credential = endpoint.credential
    const executable = await this.resolveExecutable(signal)
    const home = this.ctx.get('profileContext')?.home
    if (home === undefined) throw new Error('Claude needs the Harness home for persistent sessions')
    const storage = join(home, 'engines', 'claude')
    await mkdir(storage, { recursive: true, mode: 0o700 })
    // Host memory (not permission settings) still mirrors into the redirected
    // config home so sessions read the same instructions as a native CLI run.
    const userClaudeDir = join(homedir(), '.claude')
    await mirrorUserMemory(storage, userClaudeDir)
    await syncEngineSkillDirectories(join(storage, 'skills'), [join(userClaudeDir, 'skills'), join(home, 'skills')])
    const existing = nativeBindingFor(this.agent, 'claude')
    // oxlint-disable-next-line typescript/no-deprecated -- Native delivery determines whether initialization must resume persisted history.
    const delivered = this.agent.session.snapshotEvents().some(event =>
      event.type === 'engine/input-submitted' || event.type === 'user/message')
    if (existing === undefined && delivered) {
      throw new Error('External history has no persisted native session identity; create a new session instead of resetting its history')
    }
    // Initialization records an identity before Claude creates resumable history.
    const resume = existing !== undefined && delivered
    const nativeSessionId = existing ?? randomUUID()
    const ownedEnv = {
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
      ...endpoint.credential === undefined ? {} : { ANTHROPIC_API_KEY: endpoint.credential },
      CLAUDE_CONFIG_DIR: storage,
    }
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) {
      if (this.config.env?.[key] !== undefined) throw new Error(`Claude deployment env cannot override resolved ${key}`)
    }
    this.teamBridge = await startTeamToolBridge(this.agent, signal)
    const adapter = new ClaudeMainAdapter({
      cwd, model: selection.model,
      ...permissionMode === undefined ? {} : { permissionMode },
      bypassAllowed: !taskManaged && basePermissionMode === 'bypassPermissions',
      ...contextWindow === undefined ? {} : { contextWindow },
      ...executable === undefined ? {} : { pathToClaudeCodeExecutable: executable },
      ...tools === undefined ? {} : { tools },
      ...effort === undefined ? {} : effort === null ? { thinking: { type: 'disabled' as const } }
        : { effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).parse(effort) },
      env: { ...this.config.env, ...aliasEnv, ...ownedEnv }, nativeSessionId, resume,
      ...this.teamBridge === undefined ? {} : {
        mcpServers: { dsh_team: { type: 'http' as const, url: this.teamBridge.url,
          headers: { Authorization: this.teamBridge.authorization }, alwaysLoad: true,
          timeout: this.config.teamToolTimeoutMs ?? 3_660_000 } },
        allowedTools: ['mcp__dsh_team__*'],
      },
      disposeGraceMs: this.config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      startupTimeoutMs: this.config.startupTimeoutMs ?? 30_000,
      interruptTimeoutMs: this.config.interruptTimeoutMs ?? 10_000,
      maxActivityCharacters: this.config.maxActivityCharacters ?? 65_536,
      activityUpdateIntervalMs: this.config.activityUpdateIntervalMs ?? 100,
      onElicitation: async (request, options) => {
        const turnSignal = this.activeSignal
        const service = this.ctx.get('userQuestions')
        if (turnSignal === undefined || service === undefined) return { action: 'decline' }
        const interactionSignal = AbortSignal.any([turnSignal, options.signal])
        return answerClaudeElicitation(request, interactionSignal,
          questions => service.ask({ agent: this.agent, signal: interactionSignal, questions }))
      },
      ...sandboxSettings === undefined ? {} : { sandbox: sandboxSettings },
      canUseTool: async (name, input, options) => {
        const turnSignal = this.activeSignal
        if (turnSignal === undefined) return { behavior: 'deny', message: 'No owning turn is active.' }
        const interactionSignal = AbortSignal.any([turnSignal, options.signal])
        if (this.teamBridge !== undefined && name.startsWith('mcp__dsh_team__')) {
          return { behavior: 'allow', updatedInput: input }
        }
        if (this.activeTaskPermit !== undefined) {
          const teams = this.ctx.get('agentTeams')
          if (teams === undefined || !teams.executionPermitIsCurrent(
            this.agent, this.activeTaskPermit.taskId, this.activeTaskPermit.generation,
          )) return { behavior: 'deny', message: 'The task execution permit has expired.' }
        } else if (this.ctx.get('agentTeams')?.executionPermit(this.agent).managed === true
          && !['Read', 'Glob', 'Grep', 'AskUserQuestion'].includes(name)) {
          return { behavior: 'deny', message: 'No active, approved task execution permit is available.' }
        }
        if (name === 'AskUserQuestion') {
          const questions = questionSchema.parse(input).questions
          const service = this.ctx.get('userQuestions')
          if (service === undefined) return { behavior: 'deny', message: 'No user question service is configured.' }
          const answer = await service.ask({ agent: this.agent, signal: interactionSignal,
            questions: questions.map((question, index) => ({
              id: String(index), question: question.question,
              ...question.header === undefined ? {} : { header: question.header },
              ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
              ...question.options === undefined ? {} : { options: question.options.map(option => ({
                label: option.label, ...option.description === undefined ? {} : { description: option.description },
              })) },
            })),
          })
          interactionSignal.throwIfAborted()
          const answers = answer.answers.map((value) => {
            const question = questions[Number(value.id)]
            if (question === undefined) throw new Error('Question answer has no owning question')
            return [question.question, [...value.selected, ...value.custom === undefined ? [] : [value.custom]].join(', ')] as const
          })
          return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(answers) } }
        }
        // The policy is read per call: a live permission switch must govern the
        // very next operation, not only the process built after a restart.
        if (presets.effective(this.agent.session).sandbox === 'read-only'
          && !['Read', 'Glob', 'Grep'].includes(name)) {
          return { behavior: 'deny', message: 'The selected execution policy is read-only.' }
        }
        const approval = this.ctx.get('approval')
        if (approval === undefined) return { behavior: 'deny', message: 'No approval service is configured.' }
        const outcome = await approval.request({ agent: this.agent, toolName: name,
          reason: JSON.stringify(input), signal: interactionSignal,
        })
        if (interactionSignal.aborted || outcome !== 'allowed-once') return { behavior: 'deny', message: 'Operation was not approved.' }
        return { behavior: 'allow', updatedInput: input }
      },
      onSessionId: (id) => { recordNativeBinding(this.agent, 'claude', id) },
      onCommandsChange: () => { this.ctx.emit('commands/change') },
      onSubagent: (id, patch) => { this.children.update(id, patch) },
      onSubagentDisconnect: () => { this.children.disconnect() },
      onBackgroundSubagentComplete: (id, summary) => {
        if (this.adapter !== adapter) return
        const notice = `Claude background subagent ${id} completed.`
        this.agent.followup(createUserMessage({
          source: { kind: 'tool', callId: ToolCallId(id) },
          content: [{ type: 'text', text: `${notice}\n${summary}\nContinue the parent task using this result and summarize the outcome for the user.` }],
        }))
      },
      onActivity: (id, payload) => { this.activity(id, payload) },
      spawn: spec => this.ctx.subprocess.spawn(spec),
    })
    try { await adapter.start(signal) } catch (error: unknown) {
      await adapter.close()
      await this.teamBridge?.close()
      this.teamBridge = undefined
      throw engineFailure(error, this.credential)
    }
    this.adapter = adapter
    this.configured = signature
    this.liveSandbox = sandboxKey(sandboxSettings)
    this.liveMode = permissionMode
    this.agent.session.append('engine/item-settled', {
      nativeItemId: 'claude-model-selection', revision: 1, category: 'model-selection',
      payload: { engineId: 'claude', ...selection },
    })
  }

  /**
   * Reconcile a changed session policy with the prepared process through the
   * SDK's live control requests instead of restarting the CLI. A non-plan
   * process reconciles only where the policy differs; plan mode owns the native
   * mode and its restore target, so it keeps the restart path. A refused
   * control request — the CLI rejects a bypass mode the process was never
   * launched with — returns false so the caller rebuilds and the policy still
   * takes effect.
   * @param planMode - whether the persisted plan switch owns the native mode.
   * @param mode - native permission mode the effective policy selects.
   * @param sandbox - sandbox block the effective policy selects.
   * @param signal - caller cancellation for the switches.
   * @returns true when the live process already matches the policy, or the
   * control requests applied it.
   */
  private async reconcileLivePermission(
    planMode: boolean,
    mode: ClaudeCodePermissionMode | undefined,
    sandbox: NonNullable<Settings['sandbox']> | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (planMode) return false
    const adapter = this.adapter
    if (adapter?.applySandboxSettings === undefined || adapter.setPermissionMode === undefined) return false
    const sandboxChanged = sandboxKey(sandbox) !== this.liveSandbox
    const modeChanged = mode !== this.liveMode
    if (!sandboxChanged && !modeChanged) return true
    try {
      if (sandboxChanged) await adapter.applySandboxSettings(sandbox, signal)
      if (modeChanged) await adapter.setPermissionMode(mode ?? 'default', signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      return false
    }
    this.liveSandbox = sandboxKey(sandbox)
    this.liveMode = mode
    return true
  }

  /** Native-reported context capacity, once a settled result carries one. */
  contextWindow(): number | undefined {
    return this.adapter?.contextWindow()
  }

  /** Return the native commands reported by this prepared Claude session. */
  async commands(): Promise<readonly AgentEngineCommand[]> {
    const commands = await this.adapter?.supportedCommands() ?? []
    const lifecycle = new Set(CLAUDE_UNSUPPORTED_LIFECYCLE_COMMANDS)
    const plan: AgentEngineCommand = {
      name: 'plan', description: 'Toggle the native plan permission mode', argumentHint: '[off]', execution: 'action',
    }
    return [plan, ...commands.filter(command => !lifecycle.has(command.name) && command.name !== 'plan')
      .flatMap(command => [command.name, ...(command.aliases ?? [])]
        .filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$/u.test(name) && !lifecycle.has(name) && name !== 'plan')
        .map(name => ({ name, description: command.description,
          ...this.adapter?.isSkill(command.name) ? { kind: 'skill' as const } : {},
          ...command.argumentHint.trim() === ''
            ? {} : { argumentHint: command.argumentHint }, execution: 'prompt' as const })))]
  }

  /**
   * Toggle the native plan permission mode on the live query.
   * @param name - supported control command name.
   * @param args - `off` restores the session-policy permission mode; anything else enters plan.
   * @param signal - caller cancellation for the switch.
   */
  async executeCommand(name: string, args: string, signal: AbortSignal): Promise<void> {
    if (name !== 'plan') throw new Error(`Unsupported Claude engine command /${name}`)
    if (this.adapter === undefined) throw new Error('Claude was not prepared')
    const enter = args.trim() !== 'off'
    try {
      await this.adapter.setPermissionMode(enter ? 'plan' : this.basePermissionMode ?? 'default', signal)
      this.liveMode = enter ? 'plan' : this.basePermissionMode
    } catch (error: unknown) {
      throw engineFailure(error, this.credential)
    }
    recordEnginePlanMode(this.agent, 'claude', enter)
  }

  async run(messages: readonly UserMessage[], signal: AbortSignal, emit: Parameters<EngineTurnDriver['run']>[2]): Promise<void> {
    if (this.adapter === undefined) throw new Error('Claude was not prepared')
    const interaction = new AbortController()
    this.activeSignal = AbortSignal.any([signal, interaction.signal])
    const permit = this.ctx.get('agentTeams')?.executionPermit(this.agent)
    this.activeTaskPermit = permit?.managed === true && permit.authorized === true
      && permit.taskId !== undefined && permit.generation !== undefined
      ? { taskId: permit.taskId, generation: permit.generation } : undefined
    const finishTools = this.teamBridge?.beginTurn(this.activeSignal)
    try {
      const input: ClaudePromptBlock[] = []
      for (const message of messages) {
        for (const block of message.content) {
          if (block.type === 'text') input.push({ type: 'text', text: block.text })
          else if (block.type === 'image') {
            if (block.offloaded === true) {
              input.push({ type: 'text', text: textOnlyImageText(block.attachment) })
              continue
            }
            const stored = await this.ctx.attachments.readImage(block.attachment, signal)
            input.push({ type: 'image', source: {
              type: 'base64', media_type: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64'),
            } })
          } else if (block.type === 'file') {
            throw new Error('Claude main conversations do not support file attachments')
          }
        }
      }
      if (input.length === 0) throw new Error('Claude main conversation input must not be empty')
      await this.adapter.runTurn(input, signal, emit, messages[0]?.id)
    } catch (error: unknown) {
      throw engineFailure(error, this.credential)
    } finally {
      await finishTools?.()
      this.activity.finish()
      interaction.abort(new Error('Claude turn interaction expired'))
      this.activeSignal = undefined
      this.activeTaskPermit = undefined
    }
  }

  async close(): Promise<void> {
    this.children.disconnect()
    const adapter = this.adapter
    this.adapter = undefined
    await this.teamBridge?.close()
    this.teamBridge = undefined
    await adapter?.close()
    this.configured = undefined
    this.liveSandbox = undefined
    this.liveMode = undefined
    this.credential = undefined
  }

  private async resolveExecutable(signal: AbortSignal): Promise<string | undefined> {
    const configured = this.config.pathToClaudeCodeExecutable
    if (configured !== undefined) {
      return this.ctx.subprocess.resolveExecutable(configured, this.config.env, signal)
    }
    const candidates = ['claude', join(homedir(), '.npm-global', 'bin', 'claude')]
    for (const candidate of candidates) {
      try {
        return await this.ctx.subprocess.resolveExecutable(candidate, this.config.env, signal)
      } catch (error: unknown) {
        signal.throwIfAborted()
        if (!(error instanceof SubprocessExecutableNotFoundError)) throw error
      }
    }
    return undefined
  }
}


/**
 * Resolve Claude SDK reasoning parameters for one exact model.
 * @param reasoning - model reasoning metadata and protocol mappings.
 * @param options - provider defaults merged with exact-model overrides.
 * @returns SDK-compatible selectable efforts, including explicit disabled thinking.
 */
export function resolveClaudeReasoning(
  reasoning: LlmModelReasoningInfo | undefined, options: EngineReasoningOptions = {},
): LlmModelReasoningInfo | undefined {
  return mapEngineReasoning(reasoning, options, value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value), null)
}
