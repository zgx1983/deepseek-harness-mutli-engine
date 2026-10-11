/**
 * Process-shared Codex app-server host: one managed child whose protocol
 * connection multiplexes every main conversation as its own native thread.
 * Attachments own per-thread state; the shared router forwards notifications
 * and server requests by thread ownership and never mixes sessions.
 *
 * @module @deepseek-ai/dsh-subagent-codex/shared-server
 */

import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { CODEX_CLIENT_INFO, CodexMainWire, type CodexMainWireOptions, type CodexProtocolEndpoint } from './main-wire.ts'
import type { CodexModelCatalog } from './model-catalog.ts'

type JsonObject = Record<string, unknown>

/** One provider route registered on the shared child at startup. */
export interface CodexSharedRoute {
  /** Session-visible provider route id. */
  readonly id: string
  /** Native `model_providers` key threads select through `modelProvider`. */
  readonly nativeName: string
}

/** Fully resolved inputs for one shared app-server child. */
export interface CodexSharedServerSpec {
  /** Stable shared CODEX_HOME owning native state for every thread. */
  readonly home: string
  /** Child working directory; per-thread workspaces come from thread/start. */
  readonly cwd: string
  /** Child environment layered over the deployment environment. */
  readonly env: Record<string, string>
  /** Full native command including process-level configuration overrides. */
  readonly argv: string[]
  /** Registered provider routes in deterministic order. */
  readonly routes: readonly CodexSharedRoute[]
  /** Model ids expected from native discovery after initialization. */
  readonly expectedModelIds: readonly string[]
  /** Merged route catalog backing thread model metadata lookups. */
  catalog: CodexModelCatalog
  /** Credential values the child environment carries, for failure redaction. */
  readonly secrets: readonly string[]
  /** Deployment-owned configuration key; a changed key requires a restart. */
  readonly configKey: string
  /** Grace in milliseconds between managed termination tiers. */
  readonly disposeGraceMs: number
  /** Deadline for handshake and thread-startup replies in milliseconds. */
  readonly startupTimeoutMs: number
  /** Shared subprocess spawn seam. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/** One thread wire attached to the shared connection. */
interface SharedAttachment {
  readonly wire: CodexMainWire
  readonly endpoint: SharedThreadEndpoint
}

/**
 * Per-attachment endpoint view over the one shared transport; close detaches
 * only this attachment's registrations.
 */
class SharedThreadEndpoint implements CodexProtocolEndpoint {
  private observer: ((method: string, params: JsonObject) => void) | undefined
  private handler: ((method: string, params: JsonObject) => Promise<unknown>) | undefined
  private attachment: SharedAttachment | undefined

  constructor(
    private readonly transport: JsonRpcLineTransport,
    private readonly onDetach: (endpoint: SharedThreadEndpoint) => void,
  ) {}

  request(method: string, params: JsonObject): Promise<unknown> {
    return this.transport.request(method, params)
  }

  onNotification(observer: (method: string, params: JsonObject) => void): () => void {
    this.observer = observer
    return () => { if (this.observer === observer) this.observer = undefined }
  }

  onRequest(handler: (method: string, params: JsonObject) => Promise<unknown>): () => void {
    this.handler = handler
    return () => { if (this.handler === handler) this.handler = undefined }
  }

  notify(method: string, params?: object): void { this.transport.notify(method, params) }

  close(): void { this.onDetach(this) }

  /** Deliver one notification routed to this attachment. */
  dispatch(method: string, params: JsonObject): void {
    if (this.observer === undefined) return
    try {
      this.observer(method, params)
    } catch (error: unknown) {
      this.attachment?.wire.abort(error)
    }
  }

  /** Answer one server request routed to this attachment. */
  receive(method: string, params: JsonObject): Promise<unknown> {
    if (this.handler === undefined) return Promise.reject(new Error('Codex thread has no request handler'))
    return this.handler(method, params)
  }

  /** @internal bind the endpoint to its attachment after wire construction. */
  bind(attachment: SharedAttachment): void { this.attachment = attachment }
}

/**
 * One shared app-server child and the threads attached to it. The child is
 * created by {@link startCodexSharedAppServer}; threads attach through
 * {@link attach} and survive as native threads even when this wire detaches.
 */
export class CodexSharedAppServer {
  private readonly transport: JsonRpcLineTransport
  private readonly attachments = new Set<SharedAttachment>()
  private readonly threadsByAttachment = new Map<SharedAttachment, string>()
  private readonly routesById = new Map<string, CodexSharedRoute>()
  private activeTurns = 0
  private closed = false
  private failure: Error | undefined
  private planModeValue = false

  private constructor(
    readonly spec: CodexSharedServerSpec,
    private readonly child: SubprocessHandle,
    stderr: Readable | undefined,
  ) {
    this.transport = new JsonRpcLineTransport(
      child.stdout as NonNullable<SubprocessHandle['stdout']>,
      child.stdin as NonNullable<SubprocessHandle['stdin']>,
    )
    this.transport.onNotification((method, params) => { this.routeNotification(method, params) })
    this.transport.onRequest(async (method, params) => this.routeRequest(method, params))
    stderr?.on('data', () => { /* Drain SDK diagnostics without exposing credential-bearing output. */ })
    const onStreamFailure = (error: Error): void => { this.failAll(error) }
    ;(child.stdout as NonNullable<SubprocessHandle['stdout']>).on('error', onStreamFailure)
    ;(child.stdout as NonNullable<SubprocessHandle['stdout']>).on('end', () => {
      onStreamFailure(new Error('Codex shared app-server protocol stream ended'))
    })
    ;(child.stdin as NonNullable<SubprocessHandle['stdin']>).on('error', onStreamFailure)
    void child.done.then(() => {
      this.failAll(new Error('Codex shared app-server exited'))
    }, () => {
      this.failAll(new Error('Codex shared app-server exited'))
    })
    for (const route of spec.routes) this.routesById.set(route.id, route)
  }

  /**
   * Spawn the child, complete the protocol handshake, validate native model
   * discovery, and probe collaboration modes.
   * @param spec - fully resolved shared child inputs.
   * @param signal - startup cancellation.
   * @returns the shared server accepting thread attachments.
   * @throws when spawn, handshake, or discovery validation fails; the child is
   *   terminated before rethrowing.
   */
  static async start(spec: CodexSharedServerSpec, signal: AbortSignal): Promise<CodexSharedAppServer> {
    const child = spec.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
    const server = new CodexSharedAppServer(spec, child, child.stderr)
    const startup = AbortSignal.any([signal, AbortSignal.timeout(spec.startupTimeoutMs)])
    try {
      server.transport.start()
      await server.transport.request('initialize', {
        clientInfo: CODEX_CLIENT_INFO,
        capabilities: { experimentalApi: true },
      }, startup)
      server.transport.notify('initialized')
      await server.transport.flush()
      const expected = new Set(spec.expectedModelIds)
      if (expected.size > 0) {
        const available = new Set<string>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const response = server.object(await server.transport.request('model/list', {
            includeHidden: false, ...cursor === undefined ? {} : { cursor },
          }, startup), 'model catalog response')
          if (!Array.isArray(response.data)) throw new Error('Invalid Codex model catalog entries')
          for (const model of response.data) {
            available.add(server.string(server.object(model, 'model entry').model, 'model id'))
          }
          cursor = response.nextCursor === null || response.nextCursor === undefined
            ? undefined : server.string(response.nextCursor, 'catalog cursor')
          if (cursor !== undefined && cursors.has(cursor)) throw new Error('Codex model catalog pagination repeated a cursor')
          if (cursor !== undefined) cursors.add(cursor)
        } while (cursor !== undefined)
        if ([...expected].some(id => !available.has(id))) {
          throw new Error('Codex did not load the configured model catalog')
        }
      }
      try {
        const modes = server.object(await server.transport.request('collaborationMode/list', {}, startup),
          'collaboration modes response')
        server.planModeValue = Array.isArray(modes.data) && modes.data.some(entry =>
          server.object(entry, 'collaboration mode entry').mode === 'plan')
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // An app-server without the collaboration-mode surface keeps every
        // other command; /plan stays unregistered instead of failing turns.
      }
      return server
    } catch (error: unknown) {
      await server.close()
      throw error
    }
  }

  /** Whether the child advertised the native plan collaboration mode. */
  get planSupported(): boolean { return this.planModeValue }

  /** Merged route catalog backing thread model metadata lookups. */
  get catalog(): CodexModelCatalog { return this.spec.catalog }

  set catalog(value: CodexModelCatalog) { this.spec.catalog = value }

  private object(value: unknown, label: string): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid Codex ${label}`)
    }
    return value as JsonObject
  }

  private string(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid Codex ${label}`)
    return value
  }

  /**
   * Attach one conversation as a native thread of the shared child.
   * @param cwd - thread workspace passed to thread/start or thread/resume.
   * @param options - per-thread protocol options including resume identity.
   * @param signal - attachment cancellation.
   * @returns the attached wire; the caller owns it until {@link detach}.
   * @throws when thread creation or resume fails; the attachment detaches first.
   */
  async attach(cwd: string, options: CodexMainWireOptions, signal: AbortSignal): Promise<CodexMainWire> {
    if (this.closed) throw new Error('Codex shared app-server is closed')
    if (this.failure !== undefined) throw this.failure
    const endpoint = new SharedThreadEndpoint(this.transport, (target) => {
      for (const attachment of [...this.attachments]) {
        if (attachment.endpoint === target) this.remove(attachment)
      }
    })
    const wire = new CodexMainWire(endpoint, options)
    const attachment: SharedAttachment = { wire, endpoint }
    endpoint.bind(attachment)
    this.attachments.add(attachment)
    const startup = AbortSignal.any([signal, AbortSignal.timeout(this.spec.startupTimeoutMs)])
    try {
      await wire.startThread(cwd, startup)
    } catch (error: unknown) {
      this.remove(attachment)
      throw error
    }
    const threadId = wire.capturedThreadId()
    if (threadId !== undefined) this.threadsByAttachment.set(attachment, threadId)
    return wire
  }

  /**
   * Detach one attachment without touching the shared child or its threads.
   * @param wire - the attached wire to detach; unknown wires are ignored.
   */
  detach(wire: CodexMainWire): void {
    for (const attachment of this.attachments) {
      if (attachment.wire === wire) this.remove(attachment)
    }
  }

  /**
   * Resolve the native provider name registered for a session-selected route.
   * @param providerId - session-selected provider route id.
   * @returns the native `model_providers` key for thread selection.
   * @throws naming the registered routes when the route is not registered.
   */
  nativeProviderFor(providerId: string): string {
    const route = this.routesById.get(providerId)
    if (route !== undefined) return route.nativeName
    throw new Error(
      `subagent-codex: provider "${providerId}" is not registered on the shared Codex app-server`
      + ` (${[...this.routesById.keys()].join(', ') || 'no routes'});`
      + ' name the route under providers in cordis.yml and restart the process',
    )
  }

  /** Whether any attached conversation is inside a native turn or compaction. */
  get busy(): boolean { return this.activeTurns > 0 }

  /** Whether the shared child is still publishing protocol frames. */
  get alive(): boolean { return !this.closed && this.failure === undefined }

  /** Count one native turn or compaction starting on the shared child. */
  noteTurnActive(): void { this.activeTurns += 1 }

  /** Count one native turn or compaction settling on the shared child. */
  noteTurnSettled(): void { this.activeTurns = Math.max(0, this.activeTurns - 1) }

  /**
   * Terminate the shared child and fail every attachment.
   * @returns after the child process owner proves it is quiescent.
   */
  async close(): Promise<void> {
    this.closed = true
    this.failAll(new Error('Codex shared app-server closed'))
    try {
      this.child.stdin?.end()
    } catch (error: unknown) {
      // A concurrent stream close can reject stdin.end; process exit is still awaited.
      void error
    }
    this.transport.close()
    this.child.terminate()
    try {
      await this.child.waitForExit()
    } catch (error: unknown) {
      // waitForExit rejection does not replace the managed done observation.
      void error
    }
    await this.child.done.catch((error: unknown) => {
      // Rejected native exit still represents a settled managed child.
      void error
    })
  }

  private remove(attachment: SharedAttachment): void {
    this.attachments.delete(attachment)
    const threadId = this.threadsByAttachment.get(attachment)
    if (threadId !== undefined) this.threadsByAttachment.delete(attachment)
  }

  private failAll(error: Error): void {
    this.failure ??= error
    for (const attachment of [...this.attachments]) {
      attachment.wire.abort(error)
      this.remove(attachment)
    }
  }

  /** Route one notification to its owning attachment; foreign threads drop. */
  private routeNotification(method: string, params: JsonObject): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (threadId === undefined) {
      // Thread-less broadcasts, such as skills/changed, reach every thread.
      for (const attachment of [...this.attachments]) attachment.endpoint.dispatch(method, params)
      return
    }
    for (const attachment of [...this.attachments]) {
      if (attachment.wire.ownsThread(threadId)) attachment.endpoint.dispatch(method, params)
    }
  }

  /** Route one server request to its owning attachment; unknown threads error. */
  private routeRequest(method: string, params: JsonObject): Promise<unknown> {
    const threadId = params.threadId
    if (typeof threadId === 'string') {
      for (const attachment of this.attachments) {
        if (attachment.wire.ownsThread(threadId)) return attachment.endpoint.receive(method, params)
      }
    }
    return Promise.reject(new Error(`Codex request references no attached thread: ${JSON.stringify(threadId ?? null)}`))
  }
}

/**
 * Single owner of at most one live shared app-server child. Every
 * {@link ensureStarted} call re-resolves the child specification, so rotated
 * endpoints and configuration reach the next child; a configuration change
 * restarts the child only while no conversation is inside a native turn.
 */
export class CodexSharedServerHost {
  private server: CodexSharedAppServer | undefined
  private configKey: string | undefined
  private starting: Promise<CodexSharedAppServer> | undefined
  private readonly lifetime = new AbortController()

  /**
   * @param resolve - resolve the current shared child specification; runs
   *   before every start and metadata refresh so rotated configuration is observed.
   * @param onRestart - observe child restarts and exits.
   * @param startChild - child construction seam; tests substitute a scripted
   *   server while the restart and busy gating stay real.
   */
  constructor(
    private readonly resolve: (signal: AbortSignal) => Promise<CodexSharedServerSpec>,
    private readonly onRestart?: (reason: string) => void,
    private readonly startChild: (spec: CodexSharedServerSpec, signal: AbortSignal) => Promise<CodexSharedAppServer>
      = (spec, signal) => CodexSharedAppServer.start(spec, signal),
  ) {}

  /**
   * Return the live shared server, starting or restarting the child when the
   * resolved specification changed.
   * @param signal - caller cancellation checked at entry; the shared start
   *   itself runs on the host lifetime so one caller's abort never kills a
   *   start other conversations await.
   * @returns the shared server accepting thread attachments.
   * @throws when resolution, spawn, or handshake fails, or when a configuration
   *   change collides with an in-flight native turn.
   */
  async ensureStarted(signal: AbortSignal): Promise<CodexSharedAppServer> {
    signal.throwIfAborted()
    this.starting ??= this.refresh().finally(() => { this.starting = undefined })
    return this.starting
  }

  /** Stop the shared child; attached conversations fail with its failure. */
  async close(): Promise<void> {
    this.lifetime.abort()
    const server = this.server
    this.server = undefined
    this.configKey = undefined
    await server?.close()
  }

  private async refresh(): Promise<CodexSharedAppServer> {
    const spec = await this.resolve(this.lifetime.signal)
    const previous = this.server
    if (previous?.alive === true) {
      if (this.configKey === spec.configKey) {
        previous.catalog = spec.catalog
        return previous
      }
      if (previous.busy) {
        throw new Error(
          'subagent-codex: the shared Codex app-server configuration changed while a conversation'
          + ' is inside a native turn; retry after the turn settles',
        )
      }
      this.onRestart?.('shared Codex app-server configuration changed; restarting the shared child')
    } else if (previous !== undefined) {
      this.onRestart?.('previous shared Codex app-server exited; starting a new child')
    }
    await previous?.close()
    this.server = await this.startChild(spec, this.lifetime.signal)
    this.configKey = spec.configKey
    return this.server
  }
}
