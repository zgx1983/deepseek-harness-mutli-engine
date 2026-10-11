/**
 * Claude main-chat adapter: the official Claude Agent SDK protocol layer for
 * a persistent main-agent session. One managed CLI process per live session,
 * driven in streaming-input mode so turns continue in the same process; the
 * SDK's custom-spawn hook keeps the child under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/main-adapter
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { EngineActivityRecord, EngineSubagentPatch } from '@deepseek-ai/dsh-agent/types'
import {
  query as officialQuery,
  type ModelUsage,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
  type SpawnOptions,
  type PermissionMode,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { engineWait, EngineTurnSettledError } from '@deepseek-ai/dsh-agent'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** The turn surface a Claude main agent drives; scripted in tests. */
export interface ClaudeTurnRunner {
  /**
   * Run one turn with the given text blocks and settle its observable output.
   * @param input - non-empty text and image prompt blocks.
   * @param signal - caller cancellation for the turn.
   * @returns the collected assistant output blocks after the turn completes.
   */
  runTurn(input: readonly (string | ClaudePromptBlock)[], signal: AbortSignal): Promise<ContentBlock[]>
  /** Interrupt the active turn without closing the child. */
  interrupt(): void
  /** Query the commands registered by this native Claude session. */
  supportedCommands?(): Promise<SlashCommand[]>
  /**
   * Switch the native permission mode for subsequent turns.
   * @param mode - native permission mode to apply to the live query.
   * @param signal - caller cancellation for the switch.
   */
  setPermissionMode?(mode: PermissionMode, signal: AbortSignal): Promise<void>
  /**
   * Replace the live sandbox flag layer for commands that start later.
   * @param settings - complete sandbox block; `undefined` disables confinement.
   * @param signal - caller cancellation for the switch.
   */
  applySandboxSettings?(settings: NonNullable<Settings['sandbox']> | undefined, signal: AbortSignal): Promise<void>
}

/** Anthropic Messages input blocks supported by the Claude SDK's streaming user input. */
export type ClaudePromptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: ImageMediaType; readonly data: string } }

/** Fully resolved inputs for one Claude main-chat adapter instance. */
export interface ClaudeMainAdapterSpec {
  /** Resolved host CLI path; omitted to use the SDK payload. */
  readonly pathToClaudeCodeExecutable?: string
  /** Workspace the CLI child runs in. */
  readonly cwd: string
  /**
   * Native Claude Code permission mode for the session; omitted to let the
   * native CLI resolve its mode from settings (`defaultMode` and friends).
   */
  readonly permissionMode?: PermissionMode
  /**
   * Whether the deployment still permits the native bypass mode while the
   * session starts in a recorded dynamic mode such as `plan`. Defaults to the
   * startup `permissionMode` decision.
   */
  readonly bypassAllowed?: boolean
  /** Deployment environment layered over the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace in milliseconds. */
  readonly disposeGraceMs: number
  /** Native model fixed for this engine; omitted to preserve Claude settings. */
  readonly model?: string
  /**
   * Provider-owned context capacity for the fixed model; when known, the
   * adapter sets that native capacity and a 90% auto-compact window so compaction
   * lands ahead of the provider's hard limit.
   */
  readonly contextWindow?: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Scripted SDK query replacement for tests; defaults to the official one. */
  /** Stable native identity for a new session or a resume. */
  readonly nativeSessionId?: string
  /** Resume the identity rather than creating it. */
  readonly resume?: boolean
  /** Engine-native reasoning effort. */
  readonly effort?: Options['effort']
  /** Explicit thinking enablement; disabled maps the selectable off effort. */
  readonly thinking?: Options['thinking']
  /** Engine-native sandbox policy. */
  readonly sandbox?: Options['sandbox']
  /** Restrict available tools for a read-only native policy. */
  readonly tools?: Options['tools']
  /** Process-owned Harness tool server connections. */
  readonly mcpServers?: Options['mcpServers']
  /** MCP tools routed through the Harness execution policy pipeline. */
  readonly allowedTools?: Options['allowedTools']
  /**
   * Filesystem setting sources forwarded to the SDK; omitted to keep the SDK
   * default (all sources, matching the native CLI), `[]` for full isolation.
   */
  readonly settingSources?: Options['settingSources']
  /** Route native permission requests to the owning DSH interaction. */
  readonly canUseTool?: Options['canUseTool']
  /** Route MCP user input to the owning DSH interaction. */
  readonly onElicitation?: Options['onElicitation']
  /** Maximum characters retained while a tool input streams. */
  readonly maxActivityCharacters?: number
  /** Minimum milliseconds between progress observations for one native tool. */
  readonly activityUpdateIntervalMs?: number
  /** Deadline for process readiness. */
  readonly startupTimeoutMs?: number
  /** Deadline for interrupted native settlement. */
  readonly interruptTimeoutMs?: number
  /** Persist a native identity when observed. */
  readonly onSessionId?: (id: string) => void
  /** Invalidate the client catalog when the SDK reports updated native commands. */
  readonly onCommandsChange?: () => void
  /** Persist native child lifecycle outside foreground turn ownership. */
  readonly onSubagent?: (id: string, patch: EngineSubagentPatch) => void
  /** Mark native children unconfirmed when their process observation ends. */
  readonly onSubagentDisconnect?: () => void
  /** Queue one logged parent continuation when a background child settles between turns. */
  readonly onBackgroundSubagentComplete?: (id: string, summary: string) => void
  /** Observe SDK-owned tool activity without executing it in DSH. */
  readonly onActivity?: (id: string, value: Partial<EngineActivityRecord>) => void
  readonly query?: (params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }) => Query
}

/** Native lifecycle commands requiring Harness session rebinding before they can be exposed. */
export const CLAUDE_UNSUPPORTED_LIFECYCLE_COMMANDS: readonly string[] = ['clear', 'reset', 'resume', 'rewind', 'fork', 'exit', 'quit']

/** One in-flight turn collecting observable assistant blocks until its result settles. */
interface ActiveTurn {
  readonly inputId: string
  readonly blocks: ContentBlock[]
  readonly emit: ((chunk: StreamChunk) => void) | undefined
  readonly signal: AbortSignal
  readonly indices: Map<string, number>
  readonly partial: Set<number>
  readonly completed: Set<number>
  readonly tools: Map<number, { id: string; argsRaw: string }>
  readonly activityTimes: Map<string, number>
  readonly commandName?: string
  compactionId?: string
  compactionCompleted: boolean
  compactionFailed: boolean
  commandOutput: boolean
  contextInputTokens?: number
  currentMessageId: string
  finished: boolean
  nextIndex: number
  readonly settled: PromiseWithResolvers<ContentBlock[]>
}

/**
 * Read the context capacity a result reports for the served model.
 * @param modelUsage - per-model usage keyed by the native model id.
 * @param model - configured model, when fixed.
 * @returns the exact route's capacity, the sole entry's capacity, or undefined
 * when several models served and none matches the configured route.
 */
function modelContextWindow(
  modelUsage: Record<string, ModelUsage>, model: string | undefined,
): number | undefined {
  if (model !== undefined) {
    const exact = modelUsage[model]
    if (exact !== undefined) return exact.contextWindow
  }
  const entries = Object.values(modelUsage)
  return entries.length === 1 ? entries[0]?.contextWindow : undefined
}

/**
 * Sum the engine-reported cumulative whole-session token total across every
 * model the query pipeline called (main loop, subagents, sidechains, compaction).
 * Thinking tokens are already inside each model's `outputTokens`, so they are
 * not added again.
 * @param modelUsage - per-model cumulative usage for the session.
 * @returns billed input plus output tokens for the session, or 0 when the CLI
 * reported no usage.
 */
function sessionTotalTokens(modelUsage: Record<string, ModelUsage>): number {
  let total = 0
  for (const usage of Object.values(modelUsage)) {
    total += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens + usage.outputTokens
  }
  return total
}

/**
 * A pushable async iterable fed to the SDK's streaming-input prompt. The
 * adapter pushes one user message per turn; the CLI queries and settles with
 * one result message per turn.
 */
class PushableInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = []
  private ended = false

  /** Queue one user message for the next SDK read. */
  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('subagent-claude-code: adapter input is closed')
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: message, done: false })
    else this.queue.push(message)
  }

  /** End the input stream; pending reads resolve done. */
  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const message = this.queue.shift()
    if (message !== undefined) return Promise.resolve({ value: message, done: false })
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }
}

/**
 * One managed Claude CLI process plus one persistent SDK session. A main
 * engine calls `start`, then `runTurn` per prompt, and `close` on disposal.
 */
export class ClaudeMainAdapter implements ClaudeTurnRunner {
  private readonly input = new PushableInput()
  private readonly controller = new AbortController()
  private query: Query | undefined
  private readonly skillNames = new Set<string>()
  private child: SubprocessHandle | undefined
  private active: ActiveTurn | undefined
  private draining: Promise<void> | undefined
  private failure: Error | undefined
  private sessionId: string | undefined
  private contextWindowValue: number | undefined

  /**
   * @param spec - workspace, environment, process service, and SDK policy.
   */
  constructor(private readonly spec: ClaudeMainAdapterSpec) {}

  /**
   * Open the SDK query in streaming-input mode; the child spawns through the
   * shared subprocess owner and stays alive for subsequent turns.
   * @param signal - caller cancellation for startup.
   * @returns after the native CLI acknowledges initialization.
   * @throws when the adapter was disposed before startup.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (this.controller.signal.aborted) {
      throw new Error('subagent-claude-code: adapter was disposed before startup')
    }
    const queryFn = this.spec.query ?? officialQuery
    this.query = queryFn({
      prompt: this.input,
      options: this.buildOptions(),
    })
    this.draining = this.drain(this.query, signal)
    const readySignal = AbortSignal.any([signal, AbortSignal.timeout(this.spec.startupTimeoutMs ?? this.spec.disposeGraceMs)])
    try {
      await engineWait(this.query.initializationResult(), readySignal)
      if (this.failure !== undefined) throw this.failure
      if (this.spec.nativeSessionId !== undefined) {
        this.sessionId = this.spec.nativeSessionId
        this.spec.onSessionId?.(this.sessionId)
      }
    } catch (error: unknown) {
      await this.close()
      throw error
    }
  }

  /**
   * Inspect whether this process can accept another turn.
   * @returns false after stream failure, native exit, or disposal.
   */
  isReady(): boolean {
    return this.query !== undefined && this.failure === undefined && !this.controller.signal.aborted
  }

  /**
   * Run one turn: push the prompt, collect assistant text until the SDK
   * settles the turn with its single result message.
   * @param input - non-empty text and image prompt blocks.
   * @param signal - caller cancellation for the turn.
   * @param emit - optional live transcript stream observer.
   * @param inputId - stable accepted DSH input identity.
   * @returns the collected assistant output blocks.
   * @throws when the adapter is not started or the turn fails.
   */
  async runTurn(
    input: readonly (string | ClaudePromptBlock)[], signal: AbortSignal, emit?: (chunk: StreamChunk) => void, inputId?: string,
  ): Promise<ContentBlock[]> {
    signal.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    const query = this.query
    if (query === undefined) throw new Error('subagent-claude-code: adapter is not started')
    if (this.active !== undefined) {
      throw new Error('subagent-claude-code: a turn is already active')
    }
    const uuid = inputId === undefined ? randomUUID() : z.uuid().parse(inputId) as ReturnType<typeof randomUUID>
    const first = input[0]
    const text = typeof first === 'string' ? first : first?.type === 'text' ? first.text : undefined
    const commandName = text?.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_:.-]*)(?:\s|$)/u)?.[1]
    if (commandName !== undefined && CLAUDE_UNSUPPORTED_LIFECYCLE_COMMANDS.includes(commandName)) {
      throw new Error(`Claude command /${commandName} requires Harness session lifecycle support`)
    }
    const active: ActiveTurn = {
      inputId: uuid,
      ...commandName === undefined ? {} : { commandName }, commandOutput: false, compactionCompleted: false, compactionFailed: false,
      blocks: [], settled: Promise.withResolvers(), emit, signal,
      indices: new Map(), partial: new Set(), completed: new Set(), currentMessageId: '', nextIndex: 0,
      tools: new Map(),
      activityTimes: new Map(), finished: false,
    }
    this.active = active
    if (commandName === 'compact') {
      active.compactionId = `${uuid}:compact`
      this.spec.onActivity?.(active.compactionId, { name: '/compact', argsRaw: '{}', status: 'running' })
    }
    this.input.push({
      type: 'user',
      uuid,
      message: { role: 'user', content: input.every(item => typeof item === 'string')
        ? input.join('\n')
        : input.map(item => typeof item === 'string' ? { type: 'text' as const, text: item } : item) },
      parent_tool_use_id: null,
      shouldQuery: true,
    })
    let cancellation: Promise<void> | undefined
    const onAbort = (): void => {
      cancellation ??= (async () => {
        try {
          await engineWait((async () => {
            await query.interrupt()
            await active.settled.promise.catch(() => undefined)
          })(), AbortSignal.timeout(this.spec.interruptTimeoutMs ?? this.spec.disposeGraceMs))
        } catch (error: unknown) {
          this.failure = error instanceof Error ? error : new Error(String(error))
          await this.close()
          active.settled.reject(this.failure)
        }
      })()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const output = await active.settled.promise
      if (signal.aborted) throw new EngineTurnSettledError('Claude turn interruption acknowledged')
      return output
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (cancellation !== undefined) await cancellation
      if (this.active === active) this.active = undefined
    }
  }

  /** Interrupt the active turn without closing the child. */
  interrupt(): void {
    void this.query?.interrupt().catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.active?.settled.reject(this.failure)
    })
  }

  /**
   * Close the SDK query input and terminate the managed child, awaiting
   * quiescence.
   * @returns after the child process owner proves it is quiescent.
   */
  async close(): Promise<void> {
    this.controller.abort()
    this.input.end()
    this.active?.settled.reject(new Error('Claude execution closed'))
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      try {
        child.stdin?.end()
      } catch (error: unknown) {
        // A concurrent stream close can reject stdin.end; process exit is still awaited.
        void error
      }
      child.terminate()
      try {
        await child.waitForExit()
      } catch (error: unknown) {
        // waitForExit rejection does not replace the managed done observation.
        void error
      }
      await child.done.catch((error: unknown) => {
        // Rejected native exit still represents a settled managed child.
        void error
      })
    }
    await this.draining
    this.query = undefined
  }

  /**
   * Read the acknowledged SDK Session identity.
   * @returns the native identity after initialization or a result.
   */
  capturedSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * Read the context capacity the latest settled result reported.
   * @returns context window in tokens, or undefined before the first report.
   */
  contextWindow(): number | undefined {
    return this.contextWindowValue
  }

  /**
   * Identify a skill reported by the native initialization catalog.
   * @param name - native command name without a slash.
   * @returns whether initialization reported this name as a skill.
   */
  isSkill(name: string): boolean { return this.skillNames.has(name) }

  /**
   * Read slash commands reported by this live Claude Code process.
   * @returns the native command catalog.
   */
  supportedCommands(): Promise<SlashCommand[]> {
    const query = this.query
    if (query === undefined) throw new Error('subagent-claude-code: adapter is not started')
    return query.supportedCommands()
  }

  /**
   * Switch the native permission mode on the live streaming-input query.
   * @param mode - native permission mode for subsequent turns.
   * @param signal - caller cancellation for the switch.
   * @returns after the SDK acknowledges the switch.
   */
  async setPermissionMode(mode: PermissionMode, signal: AbortSignal): Promise<void> {
    const query = this.query
    if (query === undefined) throw new Error('subagent-claude-code: adapter is not started')
    await engineWait(query.setPermissionMode(mode), signal)
  }

  /**
   * Replace the sandbox flag layer of the live streaming-input query. The
   * control request merges one complete `sandbox` object, so callers pass the
   * whole block; a changed block governs every command that starts afterwards.
   * @param settings - complete sandbox block; `undefined` sends the disabled
   * block, matching the engine's full-access startup (no flag-layer sandbox).
   * @param signal - caller cancellation for the switch.
   * @returns after the SDK acknowledges the switch.
   */
  async applySandboxSettings(
    settings: NonNullable<Settings['sandbox']> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const query = this.query
    if (query === undefined) throw new Error('subagent-claude-code: adapter is not started')
    await engineWait(query.applyFlagSettings({ sandbox: settings ?? { enabled: false } }), signal)
  }

  private buildOptions(): Options {
    const env = { ...scrubbedParentEnv(), ...this.spec.env }
    // Main-session model selection owns this override, including inherited values.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    if (this.spec.contextWindow !== undefined) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(this.spec.contextWindow)
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.floor(this.spec.contextWindow * 0.9))
    }
    return {
      abortController: this.controller,
      cwd: this.spec.cwd,
      ...(this.spec.model === undefined ? {} : { model: this.spec.model }),
      env,
      ...this.spec.pathToClaudeCodeExecutable === undefined ? {} : {
        pathToClaudeCodeExecutable: this.spec.pathToClaudeCodeExecutable,
      },
      persistSession: true,
      ...this.spec.permissionMode === undefined ? {} : { permissionMode: this.spec.permissionMode },
      // The flag only permits bypass mode; with a delegated (omitted) mode the
      // settings files own whether bypass is actually selected. A session that
      // starts in a recorded dynamic mode keeps the deployment's bypass grant.
      allowDangerouslySkipPermissions: this.spec.bypassAllowed
        ?? (this.spec.permissionMode === undefined || this.spec.permissionMode === 'bypassPermissions'),
      includePartialMessages: true,
      ...this.spec.settingSources === undefined ? {} : { settingSources: this.spec.settingSources },
      ...(this.spec.tools === undefined ? {} : { tools: this.spec.tools }),
      ...this.spec.mcpServers === undefined ? {} : { mcpServers: this.spec.mcpServers },
      ...this.spec.allowedTools === undefined ? {} : { allowedTools: this.spec.allowedTools },
      ...(this.spec.effort === undefined ? {} : { effort: this.spec.effort }),
      ...(this.spec.thinking === undefined ? {} : { thinking: this.spec.thinking }),
      ...(this.spec.sandbox === undefined ? {} : { sandbox: this.spec.sandbox }),
      ...(this.spec.nativeSessionId === undefined ? {} : this.spec.resume
        ? { resume: this.spec.nativeSessionId }
        : { sessionId: this.spec.nativeSessionId }),
      canUseTool: this.spec.canUseTool ?? (() => Promise.resolve({
        behavior: 'deny' as const, message: 'No permission answerer is configured.',
      })),
      onElicitation: this.spec.onElicitation ?? (() => Promise.resolve({ action: 'decline' as const })),
      onUserDialog: () => Promise.resolve({ behavior: 'cancelled' as const }),
      supportedDialogKinds: [],
      spawnClaudeCodeProcess: (options: SpawnOptions) => {
        const child = this.spec.spawn(claudeSpawnSpec(options, this.spec.disposeGraceMs))
        this.child = child
        return new ManagedClaudeCodeProcess(child)
      },
    }
  }

  private async drain(query: Query, signal: AbortSignal): Promise<void> {
    try {
      for await (const message of query) {
        await this.observe(message)
      }
    } catch (error: unknown) {
      if (signal.aborted || this.controller.signal.aborted) {
        this.failure = new Error('subagent-claude-code: turn cancelled')
      } else {
        this.failure = error instanceof Error ? error : new Error(String(error))
      }
    } finally {
      this.spec.onSubagentDisconnect?.()
      this.failure ??= new Error('Claude SDK stream ended; resume the native session before sending another turn')
      if (!this.controller.signal.aborted && this.child !== undefined) {
        // A failed observation stream cannot leave unobserved native tools running.
        this.child.terminate()
        await this.child.done.catch((error: unknown) => {
          // Managed native exit rejection still acknowledges process quiescence.
          void error
        })
      }
      if (this.active !== undefined) {
        this.active.settled.reject(this.failure)
      }
    }
  }

  private readonly knownChildren = new Set<string>()
  private readonly childTaskIds = new Map<string, string>()
  private readonly childOutput = new Map<string, string>()
  private readonly backgroundChildren = new Set<string>()
  private readonly deliveredCompletions = new Set<string>()

  private async observe(message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'task_started') {
      if (message.ambient || (message.task_type !== undefined && message.task_type !== 'local_agent')) return
      if (message.task_type === undefined && message.subagent_type === undefined
        && (message.tool_use_id === undefined || !this.knownChildren.has(message.tool_use_id))) return
      const id = message.tool_use_id ?? message.task_id
      this.knownChildren.add(id)
      this.childTaskIds.set(message.task_id, id)
      this.spec.onSubagent?.(id, { title: message.description, status: 'running',
        progress: message.subagent_type ?? '' })
      return
    }
    if (message.type === 'system' && message.subtype === 'task_progress') {
      const id = this.childTaskIds.get(message.task_id) ?? message.tool_use_id
      if (id !== undefined && this.knownChildren.has(id)) this.spec.onSubagent?.(id, { title: message.description,
        progress: message.summary ?? message.last_tool_name ?? '' })
      return
    }
    if (message.type === 'system' && message.subtype === 'task_updated') {
      const id = this.childTaskIds.get(message.task_id)
      if (id !== undefined) {
        const status = message.patch.status
        this.spec.onSubagent?.(id, {
          ...message.patch.description === undefined ? {} : { title: message.patch.description },
          ...status === undefined ? {} : { status: status === 'killed' ? 'stopped' : status === 'paused' ? 'pending' : status },
        })
      }
      return
    }
    if (message.type === 'system' && message.subtype === 'task_notification') {
      const id = this.childTaskIds.get(message.task_id) ?? message.tool_use_id
      if (id !== undefined && this.knownChildren.has(id) && !message.ambient) {
        this.spec.onSubagent?.(id, { status: message.status, output: message.summary, progress: '' })
        const completion = `${message.task_id}:${message.status}`
        if (message.status === 'completed' && (this.active === undefined || this.active.finished) && !this.deliveredCompletions.has(completion)) {
          this.deliveredCompletions.add(completion)
          this.spec.onBackgroundSubagentComplete?.(id, message.summary.slice(0, this.spec.maxActivityCharacters ?? 65_536))
        }
      }
      return
    }
    if ((message.type === 'assistant' || message.type === 'stream_event' || message.type === 'user')
      && message.parent_tool_use_id !== null) {
      const id = message.parent_tool_use_id
      this.knownChildren.add(id)
      if (message.type === 'assistant') {
        const texts = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const output = ((this.childOutput.get(id) ?? '') + texts).slice(-(this.spec.maxActivityCharacters ?? 65_536))
        this.childOutput.set(id, output)
        const tool = message.message.content.find(block => block.type === 'tool_use')
        this.spec.onSubagent?.(id, { output, ...tool?.type === 'tool_use' ? { progress: tool.name } : {} })
      }
      return
    }

    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result' || !this.knownChildren.has(block.tool_use_id)) continue
        const id = block.tool_use_id
        const result = z.object({
          status: z.enum(['completed', 'async_launched']), agentId: z.string().optional(),
          resolvedModel: z.string().optional(),
          content: z.array(z.looseObject({ type: z.literal('text'), text: z.string() })).optional(),
        }).loose().safeParse(message.tool_use_result)
        if (result.success && result.data.agentId !== undefined) this.childTaskIds.set(result.data.agentId, id)
        if (result.success && result.data.status === 'async_launched') this.backgroundChildren.add(id)
        const output = result.success && result.data.content !== undefined
          ? result.data.content.map(item => item.text).join('\n')
          : typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? [])
        const terminal = block.is_error === true || (result.success && result.data.status === 'completed')
          || (!this.backgroundChildren.has(id) && !(result.success && result.data.status === 'async_launched'))
        this.spec.onSubagent?.(id, {
          ...terminal ? { status: block.is_error === true ? 'failed' : 'completed', output, progress: '' } : { status: 'running' },
          ...result.success && result.data.resolvedModel !== undefined ? { model: result.data.resolvedModel } : {},
        })
      }
    }

    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.spec.onCommandsChange?.()
      return
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.skillNames.clear()
      for (const name of message.skills) this.skillNames.add(name)
      if (this.spec.nativeSessionId !== undefined && message.session_id !== this.spec.nativeSessionId) {
        throw new Error('Claude resumed a different native session')
      }
      this.sessionId = message.session_id
      this.spec.onSessionId?.(message.session_id)
      return
    }
    const active = this.active
    if (active === undefined) return
    if (message.type === 'system' && message.subtype === 'status') {
      if (message.status === 'compacting') {
        active.compactionId ??= `${active.inputId}:compact`
        this.spec.onActivity?.(active.compactionId, { name: 'contextCompaction', argsRaw: '{}', status: 'running' })
      } else if (message.compact_result !== undefined && active.compactionId !== undefined
        && !active.compactionCompleted && !active.compactionFailed) {
        active.compactionFailed = message.compact_result === 'failed'
        active.compactionCompleted = message.compact_result === 'success'
        this.spec.onActivity?.(active.compactionId, { status: message.compact_result === 'failed' ? 'failed' : 'completed',
          ...message.compact_error === undefined ? {} : { output: message.compact_error } })
      }
      return
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      active.compactionCompleted = true
      active.compactionFailed = false
      active.compactionId ??= `${active.inputId}:compact`
      this.spec.onActivity?.(active.compactionId, { name: 'contextCompaction', argsRaw: '{}',
        output: JSON.stringify(message.compact_metadata), status: 'completed' })
      return
    }
    if (message.type === 'system' && (message.subtype === 'local_command_output' || message.subtype === 'informational')) {
      active.commandOutput = true
      this.spec.onActivity?.(message.uuid, { name: active.commandName === undefined ? 'engineNotice' : `/${active.commandName}`,
        argsRaw: '{}', output: message.content, status: 'completed' })
      return
    }
    if (message.type === 'tool_progress') {
      this.observeActivityProgress(message.tool_use_id, {
        name: message.tool_name, status: 'running',
        output: JSON.stringify({ elapsedTimeSeconds: message.elapsed_time_seconds }),
      })
      return
    }
    const indexFor = (messageId: string, blockIndex: number): number => {
      const key = `${messageId}:${blockIndex}`
      let index = active.indices.get(key)
      if (index === undefined) {
        index = active.nextIndex++
        active.indices.set(key, index)
      }
      return index
    }
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') active.currentMessageId = event.message.id
      if (event.type === 'content_block_start') {
        const index = indexFor(active.currentMessageId, event.index)
        active.partial.add(index)
        if (event.content_block.type === 'text') active.emit?.({ type: 'block-start', index, blockType: 'text' })
        if (event.content_block.type === 'thinking') active.emit?.({ type: 'block-start', index, blockType: 'reasoning' })
        if (event.content_block.type === 'tool_use') {
          active.tools.set(index, { id: event.content_block.id, argsRaw: '' })
          this.spec.onActivity?.(event.content_block.id, {
            name: event.content_block.name, argsRaw: '', status: 'running',
          })
        }
      }
      if (event.type === 'content_block_delta') {
        const index = indexFor(active.currentMessageId, event.index)
        if (event.delta.type === 'text_delta') active.emit?.({ type: 'text-delta', index, text: event.delta.text })
        if (event.delta.type === 'thinking_delta') active.emit?.({ type: 'reasoning-delta', index, text: event.delta.thinking })
        if (event.delta.type === 'input_json_delta') {
          const tool = active.tools.get(index)
          if (tool !== undefined) {
            tool.argsRaw = (tool.argsRaw + event.delta.partial_json).slice(0, this.spec.maxActivityCharacters ?? 65_536)
            this.observeActivityProgress(tool.id, { argsRaw: tool.argsRaw, status: 'running' })
          }
        }
      }
      return
    }
    if (message.type === 'assistant') {
      const usage = message.message.usage
      active.contextInputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      active.emit?.({ type: 'usage', usage: {
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      } })
      message.message.content.forEach((block, blockIndex) => {
        const pending = [...active.indices].find(([key, index]) => key.startsWith(`${message.message.id}:`) && !active.completed.has(index))
        const index = pending?.[1] ?? indexFor(message.message.id, blockIndex)
        if (active.completed.has(index)) return
        active.completed.add(index)
        if (block.type === 'text') {
          active.blocks.push({ type: 'text', text: block.text })
          if (!active.partial.has(index)) {
            active.emit?.({ type: 'block-start', index, blockType: 'text' })
            active.emit?.({ type: 'text-delta', index, text: block.text })
          }
          active.emit?.({ type: 'block-end', index, block: { type: 'text', text: block.text } })
        }
        if (block.type === 'thinking') {
          if (!active.partial.has(index)) {
            active.emit?.({ type: 'block-start', index, blockType: 'reasoning' })
            active.emit?.({ type: 'reasoning-delta', index, text: block.thinking })
          }
          active.emit?.({ type: 'block-end', index, block: { type: 'reasoning', text: block.thinking } })
        }
        if (block.type === 'tool_use') {
          if (block.name === 'Agent' || block.name === 'Task') {
            this.knownChildren.add(block.id)
            const input = z.looseObject({
              description: z.string().optional(), prompt: z.string().optional(),
              model: z.string().optional(), run_in_background: z.boolean().optional(),
            }).parse(block.input)
            if (input.run_in_background === true) this.backgroundChildren.add(block.id)
            this.spec.onSubagent?.(block.id, { title: input.description ?? input.prompt ?? block.name, status: 'running',
              ...input.model === undefined ? {} : { model: input.model },
            })
          }
          this.spec.onActivity?.(block.id, { name: block.name, argsRaw: JSON.stringify(block.input), status: 'running' })
        }
      })
      return
    }
    if (message.type === 'user') {
      const content = message.message.content
      if (Array.isArray(content)) for (const block of content) {
        if (block.type === 'tool_result') this.spec.onActivity?.(block.tool_use_id, {
          status: block.is_error === true ? 'failed' : 'completed',
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? []),
        })
      }
      return
    }
    if (message.type !== 'result') return
    const inputIds = message.user_message_uuids
      ?? (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid])
    if (inputIds !== undefined && !inputIds.includes(active.inputId)) return
    if (this.sessionId !== undefined && message.session_id !== this.sessionId) {
      throw new Error('Claude returned a result for a different native session')
    }
    this.sessionId = message.session_id
    this.spec.onSessionId?.(message.session_id)
    active.finished = true
    if (message.subtype === 'success' && !message.is_error) {
      if (active.compactionId !== undefined && !active.compactionFailed && !active.compactionCompleted) {
        this.spec.onActivity?.(active.compactionId, { status: 'completed',
          name: '/compact', output: message.result })
      }
      if (active.compactionId === undefined && !active.commandOutput && !active.blocks.some(block => block.type === 'text' && block.text.trim() !== '') && message.result.trim() !== '') {
        if (active.commandName !== undefined) {
          this.spec.onActivity?.(`${active.inputId}:result`, { name: `/${active.commandName}`, argsRaw: '{}',
            output: message.result, status: 'completed' })
        } else {
          const index = active.nextIndex++
          const block: ContentBlock = { type: 'text', text: message.result }
          active.emit?.({ type: 'block-start', index, blockType: 'text' })
          active.emit?.({ type: 'text-delta', index, text: message.result })
          active.emit?.({ type: 'block-end', index, block })
          active.blocks.push(block)
        }
      }
      const context = await this.resolveContextUsage(active.signal)
      const contextWindow = context.contextWindow ?? modelContextWindow(message.modelUsage, this.spec.model)
      if (contextWindow !== undefined) this.contextWindowValue = contextWindow
      active.emit?.({ type: 'usage', usage: {
        inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens,
        ...context.totalTokens === undefined
          ? active.contextInputTokens === undefined ? {} : { contextInputTokens: active.contextInputTokens }
          : { contextInputTokens: context.totalTokens },
        sessionTotalTokens: sessionTotalTokens(message.modelUsage),
      } })
      active.settled.resolve([...active.blocks])
    } else {
      const detail = message.subtype === 'success' ? message.result : message.errors.join('\n')
      if (active.compactionId !== undefined && !active.compactionFailed) this.spec.onActivity?.(active.compactionId, {
        name: 'contextCompaction', argsRaw: '{}', status: 'failed', output: detail,
      })
      active.settled.reject(new EngineTurnSettledError(`Claude turn failed (${message.subtype}): ${detail}`))
    }
  }

  /**
   * Best-effort structured context-usage reading: the current window occupancy
   * and the resolved compaction window, when the CLI supports the control
   * request. Falls back to the empty result so the caller keeps its per-call
   * prompt size and raw model window.
   * @param signal - owner cancellation for the control request.
   */
  private async resolveContextUsage(signal: AbortSignal): Promise<{ totalTokens?: number; contextWindow?: number }> {
    const query = this.query
    if (query === undefined || typeof query.getContextUsage !== 'function') return {}
    try {
      const usage = await engineWait(query.getContextUsage({ detail: 'summary' }), signal)
      return { totalTokens: usage.totalTokens, contextWindow: usage.maxTokens }
    } catch (error: unknown) {
      // Unsupported CLIs and control-request failures keep the raw fallbacks.
      void error
      return {}
    }
  }

  private observeActivityProgress(id: string, patch: Partial<EngineActivityRecord>): void {
    const active = this.active
    if (active === undefined) return
    const now = Date.now()
    const previous = active.activityTimes.get(id)
    if (previous !== undefined && now - previous < (this.spec.activityUpdateIntervalMs ?? 100)) return
    active.activityTimes.set(id, now)
    this.spec.onActivity?.(id, patch)
  }
}
