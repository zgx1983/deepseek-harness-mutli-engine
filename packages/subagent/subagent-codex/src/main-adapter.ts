/**
 * Codex main-chat adapter: the app-server protocol layer for a persistent
 * main-agent thread. Owns the managed child process and one thread through
 * the validated wire; a DSH main engine drives turns through it and emits
 * provider-neutral engine events for observable content.
 *
 * @module @deepseek-ai/dsh-subagent-codex/main-adapter
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { CodexPermissionMode } from './run.ts'
import { CodexAppServerWire } from './wire.ts'
import { CodexMainWire, type CodexMainWireOptions, type CodexCommandSkill } from './main-wire.ts'

interface CodexPackageManifest {
  readonly bin: { readonly codex: string }
}

/** One ordered app-server user input block. Image URLs use data URLs so the private attachment store is never exposed as a path. */
export type CodexMainInput = string | { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly url: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }

/**
 * Absolute package-local Codex wrapper selected by the pinned manifest.
 * @returns absolute path of the pinned CLI wrapper.
 */
export function codexWrapperPath(): string {
  const packageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
  const manifest = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ) as CodexPackageManifest
  return resolve(dirname(packageJsonPath), manifest.bin.codex)
}

/**
 * Fixed package-local app-server command, independent of the host `PATH`.
 * @returns Node, the official wrapper, and the fixed app-server arguments.
 */
export function codexAppServerArgv(): string[] {
  return [process.execPath, codexWrapperPath(), 'app-server', '--stdio']
}

/**
 * The app-server command with one `-c key=value` configuration override
 * inserted before the subcommand, so the engine can pin a resolved provider
 * without writing a `config.toml`. Each entry is one Codex `-c` pair.
 * @param configArgs - `key=value` entries, one per element, in application order.
 * @returns Node, the wrapper, the config flags, then `app-server --stdio`.
 */
export function codexAppServerArgvWith(configArgs: readonly string[]): string[] {
  const flags = configArgs.flatMap(entry => ['-c', entry])
  return [process.execPath, codexWrapperPath(), ...flags, 'app-server', '--stdio']
}

/** Fully resolved inputs for one Codex main-chat adapter instance. */
export interface CodexMainAdapterSpec {
  /** Workspace the app-server child runs in; also passed to `thread/start`. */
  readonly cwd: string
  /** Native Codex permission mode for the thread. */
  readonly permissionMode: CodexPermissionMode
  /** Deployment environment layered over the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace in milliseconds. */
  readonly disposeGraceMs: number
  /** Native model fixed for this engine; omitted to preserve Codex settings. */
  readonly model?: string
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Absolute app-server command; defaults to the official package wrapper. */
  readonly argv?: string[]
  /** Main-thread protocol options; one-shot policy is never inherited. */
  readonly wireOptions?: CodexMainWireOptions
  /** Deadline for stopping a native turn before managed termination. */
  readonly interruptTimeoutMs?: number
  /** Observe persistent native thread identity. */
  readonly onThreadId?: (id: string) => void
}

/**
 * The turn surface a Codex main agent drives. Kept narrow so the agent can be
 * driven by a scripted wire in tests while the real adapter owns the process.
 */
export interface CodexTurnRunner {
  /**
   * Run one turn with the given text blocks and settle its observable output.
   * @param input - non-empty text and image prompt blocks.
   * @param signal - caller cancellation for the turn.
   * @returns the collected assistant output blocks after the turn completes.
   */
  runTurn(input: readonly CodexMainInput[], signal: AbortSignal): Promise<ContentBlock[]>
  /** Interrupt the active turn without closing the child. */
  interrupt(): void
  /** Compact the persistent native thread through app-server. */
  compact?(signal: AbortSignal): Promise<void>
}

/**
 * One managed app-server child plus one Codex thread. A main engine calls
 * `start`, then `runTurn` per prompt, and `close` on disposal. The wire is
 * created by the spec's spawn so tests may substitute a scripted wire.
 */
export class CodexMainAdapter implements CodexTurnRunner {
  private readonly argv: string[]
  private readonly controller = new AbortController()
  private wire: CodexAppServerWire | CodexMainWire | undefined
  private child: SubprocessHandle | undefined

  /**
   * @param spec - workspace, environment, process service, and wire policy.
   * @param wireFactory - scripted-wire replacement for protocol tests; the
   *   default builds the real wire over the spawned child's stdio.
   */
  constructor(
    private readonly spec: CodexMainAdapterSpec,
    private readonly wireFactory: (
      input: NonNullable<SubprocessHandle['stdout']>,
      output: NonNullable<SubprocessHandle['stdin']>,
      permissionMode: CodexPermissionMode,
      model: string | undefined,
    ) => CodexAppServerWire | CodexMainWire = (input, output, permissionMode, model) =>
      CodexMainWire.overStreams(input, output, spec.wireOptions ?? {
        thread: { approvalPolicy: permissionMode === 'never' ? 'never' : 'on-request',
          sandbox: permissionMode === 'dangerously-bypass-approvals-and-sandbox' ? 'danger-full-access' : 'workspace-write',
          ...model === undefined ? {} : { model },
        },
        startupTimeoutMs: spec.disposeGraceMs,
        onRequest: () => Promise.reject(new Error('No Codex interaction answerer is configured')),
      }),
  ) {
    this.argv = spec.argv ?? codexAppServerArgv()
  }

  /**
   * Spawn the child, initialize the app-server protocol, and open the thread.
   * @param signal - caller cancellation for startup.
   * @returns after the thread exists and the child is publishing frames.
   * @throws when spawn, initialization, or thread creation fails.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (this.controller.signal.aborted) {
      throw new Error('subagent-codex: adapter was disposed before startup')
    }
    const child = this.spec.spawn({
      argv: this.argv,
      cwd: this.spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.spec.disposeGraceMs,
      env: this.spec.env,
    })
    this.child = child
    child.stderr?.on('data', () => { /* Drain SDK diagnostics without exposing credential-bearing output. */ })
    const wire = this.wireFactory(
      child.stdout as NonNullable<SubprocessHandle['stdout']>,
      child.stdin as NonNullable<SubprocessHandle['stdin']>,
      this.spec.permissionMode,
      this.spec.model,
    )
    this.wire = wire
    wire.start()
    const startup = AbortSignal.any([signal, AbortSignal.timeout(this.spec.wireOptions?.startupTimeoutMs ?? this.spec.disposeGraceMs)])
    try {
      await wire.initialize(startup)
      await wire.startThread(this.spec.cwd, startup)
      if ('capturedThreadId' in wire) {
        const id = wire.capturedThreadId()
        if (id !== undefined) this.spec.onThreadId?.(id)
      }
    } catch (error: unknown) {
      await this.close()
      throw error
    }
    void child.done.then(() => { wire.close() }, () => { wire.close() })
  }

  /**
   * Run one turn with the given text blocks and settle its observable output.
   * @param input - non-empty text and image prompt blocks.
   * @param signal - caller cancellation for the turn.
   * @param emit - optional live stream observer.
   * @param inputId - stable accepted DSH input identity.
   * @returns the collected assistant output blocks after the turn completes.
   * @throws when the adapter is not started or the turn fails.
   */
  async runTurn(
    input: readonly CodexMainInput[], signal: AbortSignal, emit?: (chunk: StreamChunk) => void, inputId?: string,
  ): Promise<ContentBlock[]> {
    const wire = this.wire
    if (wire === undefined) throw new Error('subagent-codex: adapter is not started')
    signal.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopping: Promise<void> | undefined
    const onAbort = (): void => {
      wire.interrupt()
      timer = setTimeout(() => { stopping = this.close() }, this.spec.interruptTimeoutMs ?? this.spec.disposeGraceMs)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (wire instanceof CodexMainWire) await wire.runTurn(input, signal, emit, inputId)
      else await wire.runTurn(input.map((item) => {
        if (typeof item === 'string') return item
        if (item.type === 'skill') throw new Error('Codex skills require the main-thread wire')
        return item.type === 'text' ? item.text : item.url
      }), signal)
      return wire.collectOutput()
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
      if (stopping !== undefined) await stopping
    }
  }

  /** Interrupt the active turn without closing the child. */
  interrupt(): void {
    this.wire?.interrupt()
  }

  /**
   * Read the context capacity the main wire observed, when any.
   * @returns context window in tokens, or undefined before a native report.
   */
  contextWindow(): number | undefined {
    return this.wire instanceof CodexMainWire ? this.wire.contextWindow() : undefined
  }

  /**
   * Read enabled skills from the prepared native workspace.
   * @returns native skill names, descriptions and invocation paths.
   */
  async listSkills(): Promise<readonly CodexCommandSkill[]> {
    if (!(this.wire instanceof CodexMainWire)) throw new Error('Codex skill discovery is unavailable on this wire')
    return this.wire.listSkills(this.controller.signal)
  }

  /**
   * Query native collaboration-mode presets advertised by the app-server.
   * @param signal - cancellation during discovery.
   * @returns the advertised native mode ids, including `plan` when supported.
   */
  async listCollaborationModes(signal: AbortSignal): Promise<readonly string[]> {
    if (!(this.wire instanceof CodexMainWire)) throw new Error('Codex collaboration modes are unavailable on this wire')
    return this.wire.listCollaborationModes(signal)
  }

  /**
   * Select the collaboration mode carried by every subsequent turn.
   * @param mode - native mode id such as `plan` or `default`.
   */
  setCollaborationMode(mode: string): void {
    if (!(this.wire instanceof CodexMainWire)) throw new Error('Codex collaboration modes are unavailable on this wire')
    this.wire.setCollaborationMode(mode)
  }

  /** Start native compaction with cancellation owned until its terminal notification. */
  async compact(signal: AbortSignal): Promise<void> {
    const wire = this.wire
    if (!(wire instanceof CodexMainWire)) throw new Error('subagent-codex: native compaction is unavailable on this wire')
    signal.throwIfAborted()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopping: Promise<void> | undefined
    const onAbort = (): void => {
      wire.interrupt()
      timer = setTimeout(() => { stopping = this.close() }, this.spec.interruptTimeoutMs ?? this.spec.disposeGraceMs)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await wire.compact(signal)
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
      if (stopping !== undefined) await stopping
    }
  }

  /**
   * Close the wire and terminate the managed child, awaiting quiescence.
   * @returns after the child process owner proves it is quiescent.
   */
  async close(): Promise<void> {
    this.controller.abort()
    const wire = this.wire
    const child = this.child
    this.wire = undefined
    this.child = undefined
    if (wire !== undefined) wire.close()
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
  }
}
