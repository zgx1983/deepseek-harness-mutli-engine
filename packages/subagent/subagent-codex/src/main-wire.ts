/** Interactive, persistent Codex main-thread protocol over the shared JSON-RPC transport. */
import type { EngineSubagentPatch } from '@deepseek-ai/dsh-agent/types'
import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { engineWait, EngineTurnSettledError } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CodexMainInput } from './main-adapter.ts'

type JsonObject = Record<string, unknown>

/** Client identity presented to the native app-server during initialization. */
export const CODEX_CLIENT_INFO = { name: 'deepseek-harness', version: '0.1.7-rc.2' } as const

/** One enabled skill reported by the native app-server for the current workspace. */
export interface CodexCommandSkill {
  readonly name: string
  readonly description: string
  readonly path: string
}

/** Validated inputs for a persistent main thread and its interactive callbacks. */
export interface CodexMainWireOptions {
  /** Exact configured model ids required in native discovery after initialization. */
  readonly expectedModelIds?: readonly string[]
  /** Native thread settings, including explicit approval and sandbox parameters. */
  readonly thread: JsonObject
  /** Per-turn model, effort, and permission overrides. */
  readonly turn?: JsonObject
  /** Stored thread identity; omission creates a persistent thread. */
  readonly resumeThreadId?: string
  /** Exact validated native history path in the owning session home. */
  readonly resumeThreadPath?: string
  /** Deadline for handshake and turn-start replies. */
  readonly startupTimeoutMs: number
  /** Callback for a validated server request tied to this active turn. */
  readonly onRequest: (method: string, params: JsonObject, signal: AbortSignal) => Promise<unknown>
  /** Callback for native item lifecycle and tool progress. */
  /** Observe engine children without mixing them into the parent transcript. */
  /** Maximum retained child text, resolved by the engine deployment config. */
  readonly maxActivityCharacters?: number
  /** Minimum interval between child output observations. */
  readonly activityUpdateIntervalMs?: number
  readonly onSubagent?: (id: string, patch: EngineSubagentPatch) => void
  /** Invalidate live child states when the protocol connection closes. */
  readonly onSubagentDisconnect?: () => void
  readonly onActivity?: (method: string, params: JsonObject) => void
  /** Observe native turn and compaction activity for shared-server busy tracking. */
  readonly onTurnActive?: (active: boolean) => void
  /** Invalidate the client command directory when native skills change. */
  readonly onCommandsChange?: () => void
  /** Persist discovered invocation paths before a skill can enter native input. */
  readonly onCommandCatalog?: (skills: readonly CodexCommandSkill[]) => void
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Codex ${label}`)
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid Codex ${label}`)
  return value
}

function delta(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Codex stream delta')
  return value
}

interface ActiveTurn {
  turnId: string | undefined
  readonly signal: AbortSignal
  readonly done: PromiseWithResolvers<void>
  readonly emit: ((chunk: StreamChunk) => void) | undefined
  readonly indices: Map<string, number>
  readonly streamed: Set<string>
  readonly blocks: ContentBlock[]
}

/**
 * Notification and request exchange between one thread state machine and its
 * app-server connection. A dedicated child hands over its JSON-RPC transport;
 * the shared app-server multiplexes one connection across thread wires.
 */
export interface CodexProtocolEndpoint {
  /** Send one protocol request and await its correlated response. */
  request(method: string, params: JsonObject): Promise<unknown>
  /** Subscribe to notifications; returns the unsubscriber. */
  onNotification(observer: (method: string, params: JsonObject) => void): () => void
  /** Register the server-request handler; returns the unsubscriber. */
  onRequest(handler: (method: string, params: JsonObject) => Promise<unknown>): () => void
  /** Send one client notification, such as `initialized`. */
  notify?(method: string, params?: object): void
  /** Barrier over prior writes, when the endpoint supports one. */
  flush?(): Promise<void>
  /** Begin reading protocol frames; a shared endpoint is always reading. */
  start?(): void
  /** Release the connection resources this wire alone owns. */
  close?(): void
}

/** Single-owner endpoint over one dedicated child's JSON-RPC transport. */
export class CodexTransportEndpoint implements CodexProtocolEndpoint {
  constructor(private readonly transport: JsonRpcLineTransport) {}

  request(method: string, params: JsonObject): Promise<unknown> {
    return this.transport.request(method, params)
  }

  onNotification(observer: (method: string, params: JsonObject) => void): () => void {
    this.transport.onNotification(observer)
    return () => {}
  }

  onRequest(handler: (method: string, params: JsonObject) => Promise<unknown>): () => void {
    this.transport.onRequest(handler)
    return () => {}
  }

  flush(): Promise<void> { return this.transport.flush() }

  notify(method: string, params?: object): void { this.transport.notify(method, params) }

  start(): void { this.transport.start() }

  close(): void { this.transport.close() }
}

/** Persistent main-thread wire; one-shot subagent protocol remains independent. */
export class CodexMainWire {
  private readonly endpoint: CodexProtocolEndpoint
  private readonly detachEndpoint: () => void
  private threadId: string | undefined
  private cwd: string | undefined
  private actionSettings: string | undefined
  /** Collaboration mode carried by subsequent turns; undefined keeps native defaults. */
  private collaborationMode: string | undefined
  private active: ActiveTurn | undefined
  private output: ContentBlock[] = []
  private readonly lifetime = new AbortController()
  private failure: Error | undefined
  private contextWindowValue: number | undefined
  private readonly closedTurns = new Set<string>()
  private readonly commandSkills = new Map<string, CodexCommandSkill>()

  /**
   * @param endpoint - protocol connection carrying this thread's frames.
   * @param options - resolved policy, native identity and owning callbacks.
   */
  constructor(endpoint: CodexProtocolEndpoint, private readonly options: CodexMainWireOptions) {
    this.endpoint = endpoint
    const offNotification = endpoint.onNotification((method, params) => {
      try { this.observe(method, params) } catch (error: unknown) { this.fail(error) }
    })
    const offRequest = endpoint.onRequest(async (method, params) => {
      const active = this.active
      if (typeof params.threadId === 'string' && this.childThreads.has(params.threadId)) {
        return this.options.onRequest(method, params, this.lifetime.signal)
      }
      if (active === undefined || active.signal.aborted) throw new Error('Codex request has no active owning turn')
      if (params.threadId !== this.threadId || typeof params.turnId !== 'string') throw new Error('Codex request belongs to another thread')
      this.associateTurn(active, params.turnId)
      const result = await this.options.onRequest(method, params, active.signal)
      this.assertOwningTurn(active)
      return result
    })
    this.detachEndpoint = () => { offNotification(); offRequest() }
  }

  /**
   * Wire over one dedicated child's streams; stream failures abort the wire.
   * @param input - managed child protocol output.
   * @param output - managed child protocol input.
   * @param options - resolved policy, native identity and owning callbacks.
   * @returns the wire reading the child's frames.
   */
  static overStreams(input: Readable, output: Writable, options: CodexMainWireOptions): CodexMainWire {
    const wire = new CodexMainWire(new CodexTransportEndpoint(new JsonRpcLineTransport(input, output)), options)
    const fail = (error: Error): void => { wire.abort(error) }
    input.on('error', fail)
    input.on('end', () => { fail(new Error('Codex protocol stream ended')) })
    output.on('error', fail)
    return wire
  }

  /** Begin reading protocol frames. */
  start(): void { this.endpoint.start?.() }

  /**
   * Complete initialize/initialized before creating or resuming a thread.
   * @param signal - startup cancellation.
   * @returns after the protocol handshake is acknowledged.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    await engineWait(this.endpoint.request('initialize', {
      clientInfo: { name: 'deepseek-harness', version: '0.1.7-rc.2' },
      capabilities: { experimentalApi: true },
    }), signal)
    this.endpoint.notify?.('initialized')
    await this.endpoint.flush?.()
    if (this.options.expectedModelIds !== undefined) {
      const available = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const response = object(await engineWait(this.endpoint.request('model/list', {
          includeHidden: false, ...cursor === undefined ? {} : { cursor },
        }), signal), 'model catalog response')
        if (!Array.isArray(response.data)) throw new Error('Invalid Codex model catalog entries')
        for (const model of response.data) available.add(string(object(model, 'model entry').model, 'model id'))
        cursor = response.nextCursor === null || response.nextCursor === undefined
          ? undefined : string(response.nextCursor, 'catalog cursor')
        if (cursor !== undefined && cursors.has(cursor)) throw new Error('Codex model catalog pagination repeated a cursor')
        if (cursor !== undefined) cursors.add(cursor)
      } while (cursor !== undefined)
      if (this.options.expectedModelIds.some(id => !available.has(id))) {
        throw new Error('Codex did not load the configured model catalog')
      }
    }
  }

  /**
   * Bind a persistent native thread, preserving its identity on resume.
   * @param cwd - validated Workspace directory.
   * @param signal - startup cancellation.
   * @returns after a native thread is acknowledged.
   */
  async startThread(cwd: string, signal: AbortSignal): Promise<void> {
    const saved = this.options.resumeThreadId
    const response = object(await engineWait(this.endpoint.request(saved === undefined ? 'thread/start' : 'thread/resume', {
      ...this.options.thread, cwd,
      ...saved === undefined ? { ephemeral: false } : { threadId: saved,
        ...this.options.resumeThreadPath === undefined ? {} : { path: this.options.resumeThreadPath },
      },
    }), signal), 'thread response')
    const thread = object(response.thread, 'thread')
    const id = string(thread.id, 'thread id')
    if (thread.ephemeral === true || (saved !== undefined && id !== saved)) throw new Error('Codex did not bind the requested persistent thread')
    this.threadId = id
    this.cwd = cwd
    this.actionSettings = JSON.stringify(this.options.turn)
    if (Array.isArray(thread.turns)) for (const entry of thread.turns) {
      const turn = object(entry, 'restored turn')
      if (Array.isArray(turn.items)) for (const item of turn.items) {
        this.observeChildren('item/completed', { threadId: id, item }, true)
      }
    }
  }

  /**
   * Execute one turn and settle only after its terminal native notification.
   * @param input - accepted text and image prompt blocks.
   * @param signal - owning turn cancellation.
   * @param emit - live transcript observer.
   * @param inputId - stable accepted DSH input identity passed to native execution.
   * @returns after completion; interruption and provider failure reject.
   */
  async runTurn(
    input: readonly CodexMainInput[], signal: AbortSignal, emit?: (chunk: StreamChunk) => void, inputId?: string,
  ): Promise<void> {
    signal.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.threadId === undefined || this.active !== undefined) throw new Error('Codex thread is unavailable or already active')
    const first = input[0]
    const text = typeof first === 'string' ? first : first?.type === 'text' ? first.text : undefined
    const command = text?.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_:.-]*)(?:\s+([\s\S]*))?$/u)
    const review = command?.[1] === 'review'
    if (review) {
      if (input.length !== 1) throw new Error('Codex review does not accept additional input blocks')
      await this.refreshActionSettings(signal)
    }
    let nativeInput: readonly CodexMainInput[] = input
    if (command !== undefined && command !== null && !review) {
      await this.listSkills(signal)
      const skill = this.commandSkills.get(command[1] ?? '')
      if (skill === undefined) throw new Error(`Unsupported Codex prompt command /${command[1]}`)
      nativeInput = [{ type: 'text', text: `$${skill.name}${command[2] === undefined ? '' : ` ${command[2]}`}` },
        { type: 'skill', name: skill.name, path: skill.path }, ...input.slice(1)]
    }
    await this.inTurnFrame(signal, emit, 'turn', async (active) => {
      // Keep request correlation alive when cancellation races native acknowledgement.
      const response = object(await engineWait(this.endpoint.request(review ? 'review/start' : 'turn/start', review ? {
        threadId: this.threadId, delivery: 'inline', target: command[2]?.trim()
          ? { type: 'custom', instructions: command[2] } : { type: 'uncommittedChanges' },
      } : {
        threadId: this.threadId,
        input: nativeInput.map(item => typeof item === 'string'
          ? { type: 'text', text: item, text_elements: [] }
          : item.type === 'text'
            ? { type: 'text', text: item.text, text_elements: [] }
            : item.type === 'image' ? { type: 'image', url: item.url } : item),
        ...this.options.turn,
        ...inputId === undefined ? {} : { clientUserMessageId: inputId },
        ...this.collaborationModeParams(),
      }), AbortSignal.timeout(this.options.startupTimeoutMs)), 'turn response')
      if (review && response.reviewThreadId !== this.threadId) throw new Error('Codex review started on another thread')
      const turn = object(response.turn, 'turn')
      this.associateTurn(active, string(turn.id, 'turn id'))
      if (signal.aborted) this.interrupt()
      await active.done.promise
    }).then((blocks) => { this.output = blocks })
  }

  /**
   * Run one native operation inside the shared active-turn frame: register the
   * active turn, observe its activity window, and settle the frame's lifecycle.
   * @param signal - owning turn cancellation.
   * @param emit - live transcript observer, or undefined for silent operations.
   * @param label - product name used in interruption and expiry errors.
   * @param core - the native request and settlement for this operation.
   * @returns the collected output blocks after the frame settles.
   */
  private async inTurnFrame(
    signal: AbortSignal, emit: ((chunk: StreamChunk) => void) | undefined, label: string,
    core: (active: ActiveTurn) => Promise<void>,
  ): Promise<ContentBlock[]> {
    const interaction = new AbortController()
    const active: ActiveTurn = {
      turnId: undefined, signal: AbortSignal.any([signal, interaction.signal]), done: Promise.withResolvers(), emit,
      indices: new Map(), streamed: new Set(), blocks: [],
    }
    this.active = active
    this.output = []
    void active.done.promise.catch(() => undefined)
    const onAbort = (): void => { this.interrupt() }
    signal.addEventListener('abort', onAbort, { once: true })
    this.options.onTurnActive?.(true)
    try {
      await core(active)
      if (signal.aborted) throw new EngineTurnSettledError(`Codex ${label} interruption acknowledged`)
      return [...active.blocks]
    } finally {
      this.options.onTurnActive?.(false)
      interaction.abort(new Error(`Codex ${label} interaction expired`))
      signal.removeEventListener('abort', onAbort)
      if (active.turnId !== undefined) this.closedTurns.add(active.turnId)
      if (this.active === active) this.active = undefined
    }
  }

  /**
   * Query native collaboration-mode presets advertised by the app-server.
   * @param signal - cancellation during discovery.
   * @returns the advertised native mode ids, including `plan` when supported.
   */
  async listCollaborationModes(signal: AbortSignal): Promise<readonly string[]> {
    const response = object(await engineWait(this.endpoint.request('collaborationMode/list', {}),
      AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.options.startupTimeoutMs)])),
    'collaboration modes response')
    if (!Array.isArray(response.data)) throw new Error('Invalid Codex collaboration mode entries')
    return response.data.map(entry => string(object(entry, 'collaboration mode entry').mode, 'collaboration mode id'))
  }

  /**
   * Select the collaboration mode carried by every subsequent turn.
   * @param mode - native mode id such as `plan` or `default`.
   */
  setCollaborationMode(mode: string): void {
    this.collaborationMode = mode
  }

  /** Native collaboration-mode turn parameter; the mode applies from the next turn onward. */
  private collaborationModeParams(): JsonObject {
    if (this.collaborationMode === undefined) return {}
    const model = this.options.turn?.model ?? this.options.thread.model
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error('Codex collaboration mode requires a resolved thread model')
    }
    return { collaborationMode: { mode: this.collaborationMode, settings: {
      model,
      ...this.options.turn?.effort === undefined ? {} : { reasoningEffort: this.options.turn.effort },
    } } }
  }

  /**
   * Query enabled native skills and refresh their exact invocation paths.
   * @param signal - cancellation during catalog discovery.
   * @returns enabled skills for the thread workspace.
   */
  async listSkills(signal: AbortSignal): Promise<readonly CodexCommandSkill[]> {
    if (this.cwd === undefined) throw new Error('Codex skill discovery requires a prepared workspace')
    const response = object(await engineWait(this.endpoint.request('skills/list', {
      cwds: [this.cwd], forceReload: true,
    }), AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.options.startupTimeoutMs)])), 'skills response')
    if (!Array.isArray(response.data)) throw new Error('Invalid Codex skills entries')
    const skills = new Map<string, CodexCommandSkill>()
    for (const entry of response.data) {
      const group = object(entry, 'skills group')
      if (!Array.isArray(group.skills) || !Array.isArray(group.errors)) throw new Error('Invalid Codex skills group')
      if (group.errors.length > 0) throw new Error('Codex skill discovery reported workspace errors')
      for (const raw of group.skills) {
        const skill = object(raw, 'skill')
        if (skill.enabled !== true) continue
        const name = string(skill.name, 'skill name')
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$/u.test(name)) continue
        if (skills.has(name)) throw new Error(`Ambiguous Codex skill command /${name}`)
        skills.set(name, { name, description: string(skill.description, 'skill description'), path: string(skill.path, 'skill path') })
      }
    }
    this.commandSkills.clear()
    for (const [name, skill] of skills) this.commandSkills.set(name, skill)
    const catalog = [...skills.values()]
    this.options.onCommandCatalog?.(catalog)
    return catalog
  }

  /**
   * Compact the current thread and wait for the app-server turn to settle.
   * @param signal - action cancellation; native interruption is awaited.
   */
  async compact(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.threadId === undefined || this.active !== undefined) throw new Error('Codex thread is unavailable or already active')
    await this.refreshActionSettings(signal)
    await this.inTurnFrame(signal, undefined, 'compaction', async (active) => {
      object(await engineWait(this.endpoint.request('thread/compact/start', {
        threadId: this.threadId,
      }), AbortSignal.timeout(this.options.startupTimeoutMs)), 'compaction response')
      if (signal.aborted) this.interrupt()
      await active.done.promise
    }).then((blocks) => { this.output = blocks })
  }

  /** Apply changed turn selection to native operations that use thread defaults. */
  private async refreshActionSettings(signal: AbortSignal): Promise<void> {
    const settings = JSON.stringify(this.options.turn)
    if (settings === this.actionSettings) return
    const response = object(await engineWait(this.endpoint.request('thread/resume', {
      ...this.options.thread, threadId: this.threadId, cwd: this.cwd,
      ...this.options.turn?.model === undefined ? {} : { model: this.options.turn.model },
      ...this.options.turn?.effort === undefined ? {} : { reasoningEffort: this.options.turn.effort },
    }), AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.options.startupTimeoutMs)])), 'action settings response')
    if (object(response.thread, 'action settings thread').id !== this.threadId) throw new Error('Codex changed thread while applying command settings')
    this.actionSettings = settings
  }

  /** Request native interruption, including an id learned from an early notification. */
  interrupt(): void {
    const turnId = this.active?.turnId
    if (turnId === undefined || this.threadId === undefined) return
    void this.endpoint.request('turn/interrupt', { threadId: this.threadId, turnId }).catch((error: unknown) => { this.fail(error) })
  }

  /**
   * Return the final text blocks from the last completed turn.
   * @returns output belonging only to that turn.
   */
  collectOutput(): ContentBlock[] { return [...this.output] }

  /**
   * Read the context capacity the latest token-usage notification reported.
   * @returns context window in tokens, or undefined before the first report.
   */
  contextWindow(): number | undefined { return this.contextWindowValue }

  /**
   * Read the acknowledged thread identity.
   * @returns native thread id after startup.
   */
  capturedThreadId(): string | undefined { return this.threadId }

  /** Reject active work, detach from the endpoint, and release owned connection resources. */
  close(): void {
    this.fail(new Error('Codex execution closed'))
    this.detachEndpoint()
    this.endpoint.close?.()
  }

  /**
   * Abort the wire from its connection owner, such as a shared server observing
   * a stream failure that the wire itself cannot see.
   * @param error - the connection failure observed by the owner.
   */
  abort(error: unknown): void { this.fail(error) }

  /**
   * Whether the wire still carries protocol traffic for new turns.
   * @returns the latched failure, or undefined while the wire stays usable.
   */
  fatalError(): Error | undefined { return this.failure }

  /**
   * Whether a native thread id belongs to this wire's main thread or one of its
   * collaboration children.
   * @param threadId - native thread id from a notification or server request.
   * @returns `true` when this wire owns the thread's protocol traffic.
   */
  ownsThread(threadId: string): boolean {
    return threadId === this.threadId || this.childThreads.has(threadId)
  }

  private assertOwningTurn(active: ActiveTurn): void {
    if (this.active !== active || active.signal.aborted) throw new Error('Codex interaction expired before its reply')
  }

  private associateTurn(active: ActiveTurn, id: string): void {
    if (active.turnId !== undefined && active.turnId !== id) throw new Error('Codex returned a conflicting native turn id')
    active.turnId = id
  }

  private fail(error: unknown): void {
    if (this.failure === undefined) { this.lifetime.abort(error); this.options.onSubagentDisconnect?.() }
    this.failure ??= error instanceof Error ? error : new Error(String(error))
    this.active?.done.reject(this.failure)
  }

  private readonly childThreads = new Set<string>()
  private readonly childOutput = new Map<string, string>()
  private readonly childOutputAt = new Map<string, number>()

  private observeChildren(method: string, params: JsonObject, restoring = false): void {
    const related = params.threadId === this.threadId || (typeof params.threadId === 'string' && this.childThreads.has(params.threadId))
    if (!related) return
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item, 'child activity item')
      if (item.type === 'collabAgentToolCall' || item.type === 'collabToolCall') {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds
          : [item.receiverThreadId ?? item.newThreadId].filter(id => typeof id === 'string')
        for (const receiver of receivers) {
          const id = string(receiver, 'collaboration receiver')
          if (item.tool === 'spawnAgent' || item.tool === 'spawn_agent') this.childThreads.add(id)
          if (!this.childThreads.has(id)) continue
          const states = item.agentsStates
          const state = states !== null && typeof states === 'object' && !Array.isArray(states)
            ? object(states, 'agent states')[id] : item.agentStatus
          const agentState = state !== null && typeof state === 'object' ? object(state, 'agent state') : undefined
          const nativeStatus = typeof state === 'string' ? state : agentState?.status
          const status = nativeStatus === 'pendingInit' ? 'pending'
            : nativeStatus === 'running' ? 'running' : nativeStatus === 'completed' ? 'completed'
              : nativeStatus === 'errored' ? 'failed' : nativeStatus === 'interrupted' || nativeStatus === 'shutdown' ? 'stopped'
                : nativeStatus === 'notFound' ? 'unknown' : undefined
          this.options.onSubagent?.(id, {
            status: restoring && (status === 'running' || status === 'pending' || status === undefined) ? 'unknown'
              : status ?? 'pending',
            ...typeof item.prompt === 'string' ? { title: item.prompt } : {},
            ...typeof item.model === 'string' ? { model: item.model } : {},
            ...typeof agentState?.message === 'string' ? { output: agentState.message } : {},
            ...params.threadId !== this.threadId && typeof params.threadId === 'string' ? { parentId: params.threadId } : {},
          })
        }
      }
    }
    if (typeof params.threadId !== 'string' || !this.childThreads.has(params.threadId)) return
    const id = params.threadId
    if (method === 'turn/started') this.options.onSubagent?.(id, { status: 'running' })
    if (method === 'turn/completed') {
      const turn = object(params.turn, 'child turn')
      this.options.onSubagent?.(id, { ...this.childOutput.has(id) ? { output: this.childOutput.get(id) ?? '' } : {}, status: turn.status === 'completed' ? 'completed'
        : turn.status === 'interrupted' ? 'stopped' : 'failed' })
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const output = ((this.childOutput.get(id) ?? '') + params.delta).slice(-(this.options.maxActivityCharacters ?? 65_536))
      this.childOutput.set(id, output)
      const now = Date.now()
      if (now - (this.childOutputAt.get(id) ?? 0) >= (this.options.activityUpdateIntervalMs ?? 100)) {
        this.childOutputAt.set(id, now)
        this.options.onSubagent?.(id, { output })
      }
    }
    if (method === 'item/completed') {
      const item = object(params.item, 'child completed item')
      if (item.type === 'agentMessage' && typeof item.text === 'string') this.options.onSubagent?.(id, { output: item.text })
      else if (typeof item.type === 'string') this.options.onSubagent?.(id, { progress: item.type })
    }
  }

  private observe(method: string, params: JsonObject): void {
    if (this.failure !== undefined) return
    if (method === 'skills/changed') this.options.onCommandsChange?.()
    this.observeChildren(method, params)

    const active = this.active
    if (active === undefined || params.threadId !== this.threadId) return
    const turn = method === 'turn/started' || method === 'turn/completed' ? object(params.turn, 'turn notification') : undefined
    const turnId = turn === undefined ? params.turnId : turn.id
    if (typeof turnId !== 'string' || this.closedTurns.has(turnId)) return
    this.associateTurn(active, turnId)
    if (active.signal.aborted && method === 'turn/started') this.interrupt()
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = object(params.tokenUsage, 'token usage')
      const usage = object(tokenUsage.last, 'turn token usage')
      const total = object(tokenUsage.total, 'thread cumulative token usage')
      const number = (value: unknown): number => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Codex token count')
        return value
      }
      const inputTokens = number(usage.inputTokens)
      const cachedInputTokens = number(usage.cachedInputTokens)
      // Older Codex builds reported no cache-write bucket; treat its absence as 0.
      const cacheWriteInputTokens = usage.cacheWriteInputTokens === undefined ? 0 : number(usage.cacheWriteInputTokens)
      if (tokenUsage.modelContextWindow !== undefined) {
        const contextWindow = number(tokenUsage.modelContextWindow)
        if (contextWindow === 0) throw new Error('Invalid Codex context window')
        this.contextWindowValue = contextWindow
      }
      active.emit?.({ type: 'usage', usage: {
        inputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens),
        outputTokens: number(usage.outputTokens),
        cacheReadTokens: cachedInputTokens,
        cacheWriteTokens: cacheWriteInputTokens,
        sessionTotalTokens: number(total.totalTokens),
      } })
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const id = string(params.itemId, 'reasoning item id')
      let index = active.indices.get(id)
      if (index === undefined) {
        index = active.indices.size
        active.indices.set(id, index)
        active.emit?.({ type: 'block-start', index, blockType: 'reasoning' })
      }
      active.emit?.({ type: 'reasoning-delta', index, text: delta(params.delta) })
    }
    if (method === 'item/agentMessage/delta') {
      const id = string(params.itemId, 'item id')
      let index = active.indices.get(id)
      if (index === undefined) {
        index = active.indices.size
        active.indices.set(id, index)
        active.emit?.({ type: 'block-start', index, blockType: 'text' })
      }
      active.streamed.add(id)
      active.emit?.({ type: 'text-delta', index, text: delta(params.delta) })
    }
    if (method === 'item/completed') {
      const item = object(params.item, 'completed item')
      if (item.type === 'exitedReviewMode') {
        const text = delta(item.review)
        const index = active.indices.size
        active.emit?.({ type: 'block-start', index, blockType: 'text' })
        active.emit?.({ type: 'text-delta', index, text })
        active.emit?.({ type: 'block-end', index, block: { type: 'text', text } })
        active.blocks.push({ type: 'text', text })
        this.options.onActivity?.(method, params)
      } else if (item.type === 'agentMessage') {
        const id = string(item.id, 'item id')
        const text = typeof item.text === 'string' ? item.text : ''
        const index = active.indices.get(id) ?? active.indices.size
        active.indices.set(id, index)
        if (!active.streamed.has(id)) {
          active.emit?.({ type: 'block-start', index, blockType: 'text' })
          active.emit?.({ type: 'text-delta', index, text })
        }
        active.emit?.({ type: 'block-end', index, block: { type: 'text', text } })
        active.blocks.push({ type: 'text', text })
      } else this.options.onActivity?.(method, params)
    } else if (method.startsWith('item/') && method !== 'item/agentMessage/delta') {
      this.options.onActivity?.(method, params)
    }
    if (method === 'turn/completed' && turn !== undefined) {
      if (turn.status === 'completed') active.done.resolve()
      else active.done.reject(new EngineTurnSettledError(`Codex turn ended with ${String(turn.status)}: ${JSON.stringify(turn.error ?? null)}`))
    }
  }
}
