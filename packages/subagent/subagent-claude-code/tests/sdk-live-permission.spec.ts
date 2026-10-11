/**
 * Probe the Claude Agent SDK's live sandbox surface on a real streaming-input
 * query. The harness rebuilds its managed CLI process whenever a session
 * permission preset changes; replacing that with live control requests is only
 * sound when the CLI re-reads the sandbox settings for commands that start
 * later, so these cases drive the pinned real CLI against a loopback Messages
 * fixture and assert the filesystem rather than CLI logs.
 *
 * The single tool call writes one file outside the workspace. A process without
 * the sandbox option proves the target is writable; the other cases toggle
 * `sandbox.enabled` through `applyFlagSettings`.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Query, SDKUserMessage, Settings } from '@anthropic-ai/claude-agent-sdk'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { startMessagesFixture, type MessagesFixture } from './messages-fixture.ts'

const sdkRoot = dirname(fileURLToPath(
  import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
))
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const claudeBin = join(
  resolve(sdkRoot, '..', platformPackage.split('/')[1]!),
  process.platform === 'win32' ? 'claude.exe' : 'claude',
)
const fakeKey = 'dsh-fake-anthropic-key'
const settingsModel = 'dsh-live-permission-marker'

const roots: string[] = []
const fixtures: MessagesFixture[] = []
const outsideFiles: string[] = []

afterAll(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const file of outsideFiles.splice(0)) rmSync(file, { force: true })
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** Streaming-input queue: the SDK control requests require streaming input. */
class PushableInput implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | undefined
  private ended = false

  push(message: SDKUserMessage): void {
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: message, done: false })
      return
    }
    this.queue.push(message)
  }

  end(): void {
    this.ended = true
    this.waiter?.({ value: undefined, done: true })
    this.waiter = undefined
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => { this.waiter = resolve })
  }
}

/** Sandbox block matching the engine's workspace-write policy. */
type SandboxSettings = NonNullable<Settings['sandbox']>

/** One live probe: a real CLI process whose only write is outside the workspace. */
interface Probe {
  readonly query: Query
  readonly fixture: MessagesFixture
  readonly outside: string
  /** Push the probe prompt and drain the query until its turn settles. */
  run(): Promise<void>
  close(): Promise<void>
}

/** Start-time choices a probe may vary. */
interface ProbeOptions {
  /** Sandbox option for the process; omitted starts it unconfined. */
  readonly sandbox?: SandboxSettings
  /** Start-time bypass grant (`allowDangerouslySkipPermissions`). */
  readonly bypassGrant?: boolean
  /** Whether the tool permission prompt allows the call; false denies it. */
  readonly permit?: boolean
}

/**
 * Start one probe process.
 * @param options - start-time sandbox, bypass grant, and prompt decision.
 * @returns the live query plus its outside-write target.
 */
async function startProbe(options: ProbeOptions = {}): Promise<Probe> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-permission-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const claudeConfig = join(root, 'claude-config')
  const xdgConfig = join(root, 'xdg')
  mkdirSync(workspace)
  mkdirSync(claudeConfig)
  mkdirSync(xdgConfig)
  writeFileSync(
    join(claudeConfig, 'settings.json'),
    `${JSON.stringify({
      model: settingsModel,
      permissions: { defaultMode: 'default' },
    }, null, 2)}\n`,
  )
  // The host process runs under DSH's own workspace-write file sandbox, so the
  // outside target must stay inside the session workspace while remaining
  // outside the CLI's temporary cwd.
  const outsideDir = join(process.cwd(), `.dsh-live-permission-${randomUUID()}`)
  mkdirSync(outsideDir)
  roots.push(outsideDir)
  const outside = join(outsideDir, 'outside.txt')
  outsideFiles.push(outside)
  const fixture = await startMessagesFixture({
    kind: 'tool-use',
    toolName: 'Bash',
    input: { command: `printf probe > '${outside}'` },
    finalText: 'LIVE_PERMISSION_PROBE_DONE',
  })
  fixtures.push(fixture)
  const env = {
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: fixture.baseUrl,
    CLAUDE_CONFIG_DIR: claudeConfig,
    HOME: root,
    XDG_CONFIG_HOME: xdgConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const input = new PushableInput()
  const active = query({
    prompt: input,
    options: {
      abortController: new AbortController(),
      cwd: workspace,
      env,
      pathToClaudeCodeExecutable: claudeBin,
      persistSession: true,
      permissionMode: 'default',
      canUseTool: async (_name, toolInput) => options.permit === false
        ? { behavior: 'deny', message: 'Probe denies this call.' }
        : { behavior: 'allow', updatedInput: toolInput },
      ...options.bypassGrant === true ? { allowDangerouslySkipPermissions: true } : {},
      ...options.sandbox === undefined ? {} : { sandbox: options.sandbox },
      maxTurns: 3,
    },
  })
  return {
    query: active,
    fixture,
    outside,
    async run(): Promise<void> {
      input.push({
        type: 'user',
        uuid: randomUUID(),
        message: { role: 'user', content: 'Run the probe command.' },
        parent_tool_use_id: null,
        shouldQuery: true,
      })
      for await (const message of active) {
        if (message.type === 'result') break
      }
    },
    async close(): Promise<void> {
      input.end()
      await active.return(undefined)
    },
  }
}

/** The engine's workspace-write sandbox block. */
function workspaceWriteSandbox(workspace: string): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    filesystem: { allowWrite: [workspace] },
  }
}

describe('Claude SDK live sandbox control requests', () => {
  it('writes the outside file when the process starts unconfined', async () => {
    const probe = await startProbe()
    await probe.query.initializationResult()
    await probe.run()

    expect(existsSync(probe.outside)).toBe(true)
    await probe.close()
  }, 60_000)

  it('blocks the outside write under a start-time sandbox', async () => {
    const probe = await startProbe({ sandbox: workspaceWriteSandbox(tmpdir()) })
    await probe.query.initializationResult()
    await probe.run()

    expect(existsSync(probe.outside)).toBe(false)
    await probe.close()
  }, 60_000)

  it('applies a live sandbox disable to a command that starts later', async () => {
    const probe = await startProbe({ sandbox: workspaceWriteSandbox(tmpdir()) })
    await probe.query.initializationResult()
    await probe.query.applyFlagSettings({ sandbox: { enabled: false } })
    await probe.run()

    // True means the flag layer owns the confinement of later commands.
    expect(existsSync(probe.outside)).toBe(true)
    await probe.close()
  }, 60_000)

  it('applies a live sandbox enable to a command that starts later', async () => {
    const probe = await startProbe()
    await probe.query.initializationResult()
    await probe.query.applyFlagSettings({ sandbox: workspaceWriteSandbox(tmpdir()) })
    await probe.run()

    expect(existsSync(probe.outside)).toBe(false)
    await probe.close()
  }, 60_000)
})

describe('Claude SDK live permission-mode control requests', () => {
  it('denies the command while the prompt denies it', async () => {
    const probe = await startProbe({ permit: false })
    await probe.query.initializationResult()
    await probe.run()

    expect(existsSync(probe.outside)).toBe(false)
    await probe.close()
  }, 60_000)

  it('applies a live bypass switch when the start-time grant is present', async () => {
    const probe = await startProbe({ permit: false, bypassGrant: true })
    await probe.query.initializationResult()
    await probe.query.setPermissionMode('bypassPermissions')
    await probe.run()

    // The accepted bypass mode skips the prompt that would deny the call.
    expect(existsSync(probe.outside)).toBe(true)
    await probe.close()
  }, 60_000)

  it('rejects a live bypass switch without the start-time grant', async () => {
    const probe = await startProbe({ permit: false })
    await probe.query.initializationResult()
    await expect(probe.query.setPermissionMode('bypassPermissions')).rejects.toThrow(
      /not launched with --dangerously-skip-permissions/u,
    )
    await probe.run()

    // The rejected switch leaves the prompt in charge, so the call stays denied.
    expect(existsSync(probe.outside)).toBe(false)
    await probe.close()
  }, 60_000)
})
