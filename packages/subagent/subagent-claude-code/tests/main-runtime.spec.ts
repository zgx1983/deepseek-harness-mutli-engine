/** Real SDK and CLI against an isolated Messages server; no paid requests. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeMainAdapter } from '../src/main-adapter.ts'
import { startMessagesFixture, type MessagesBehavior } from './messages-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness(behavior: MessagesBehavior) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-main-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const fixture = await startMessagesFixture(behavior)
  cleanups.push(() => fixture.close())
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => ctx.fiber.dispose())
  const handles: SubprocessHandle[] = []
  const nativeSessionId = randomUUID()
  const base = {
    cwd: workspace, model: 'claude-sonnet-4-6', nativeSessionId,
    permissionMode: 'default' as const, disposeGraceMs: 1000,
    startupTimeoutMs: 30_000, interruptTimeoutMs: 10_000,
    env: {
      ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: fixture.baseUrl,
      CLAUDE_CONFIG_DIR: join(root, 'config'), HOME: root,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
    },
    spawn: (spec: Parameters<typeof ctx.subprocess.spawn>[0]) => {
      const handle = ctx.subprocess.spawn(spec)
      handles.push(handle)
      return handle
    },
  }
  const create = (overrides: Partial<ConstructorParameters<typeof ClaudeMainAdapter>[0]> = {}) => {
    const adapter = new ClaudeMainAdapter({ ...base, ...overrides })
    cleanups.push(() => adapter.close())
    return adapter
  }
  return { create, fixture, handles, workspace, env: base.env }
}

describe('Claude main runtime with real SDK and CLI', () => {
  it('uses configured capacity for a gateway model in the native process', async () => {
    const { create } = await harness({ kind: 'complete', text: 'capacity-answer' })
    const adapter = create({ model: 'gateway-custom-model', contextWindow: 1_048_576 })
    await adapter.start(new AbortController().signal)
    const output = await adapter.runTurn(['Report a short answer'], new AbortController().signal)
    expect({ output, contextWindow: adapter.contextWindow() }).toMatchInlineSnapshot(`
      {
        "contextWindow": 786432,
        "output": [
          {
            "text": "capacity-answer",
            "type": "text",
          },
        ],
      }
    `)
    await adapter.close()
  }, 60_000)

  it('accepts the first prompt after initialization-only process replacement', async () => {
    const { create } = await harness({ kind: 'complete', text: 'first-prompt-answer' })
    const initial = create()
    await initial.start(new AbortController().signal)
    await initial.close()
    const replacement = create({ resume: false })
    await replacement.start(new AbortController().signal)
    expect(await replacement.runTurn(['First prompt'], new AbortController().signal))
      .toEqual([{ type: 'text', text: 'first-prompt-answer' }])
    await replacement.close()
  }, 60_000)

  it('streams two turns, resumes the native session and awaits owned child exit', async () => {
    const { create, fixture, handles } = await harness({ kind: 'complete', text: 'main-runtime-answer' })
    const adapter = create()
    await adapter.start(new AbortController().signal)
    const chunks: StreamChunk[] = []
    expect(await adapter.runTurn(['Remember first-turn-marker'], new AbortController().signal, chunk => chunks.push(chunk)))
      .toEqual([{ type: 'text', text: 'main-runtime-answer' }])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    await adapter.runTurn(['Second turn'], new AbortController().signal)
    expect(JSON.stringify(fixture.requests.at(-1)?.body)).toContain('first-turn-marker')
    const identity = adapter.capturedSessionId()
    await adapter.close()
    const resumed = create({ resume: true })
    await resumed.start(new AbortController().signal)
    await resumed.runTurn(['After process restart'], new AbortController().signal)
    expect(resumed.capturedSessionId()).toBe(identity)
    expect(JSON.stringify(fixture.requests.at(-1)?.body)).toContain('first-turn-marker')
    await resumed.close()
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('continues native history in a new process using a different endpoint', async () => {
    const { create, fixture, handles, env } = await harness({ kind: 'complete', text: 'first-endpoint' })
    const first = create()
    await first.start(new AbortController().signal)
    await first.runTurn(['Remember endpoint-switch-marker'], new AbortController().signal)
    const identity = first.capturedSessionId()
    await first.close()
    await expect(handles[0]?.waitForExit()).resolves.toBe(true)
    const secondFixture = await startMessagesFixture({ kind: 'complete', text: 'second-endpoint' })
    cleanups.push(() => secondFixture.close())
    const second = create({ resume: true, env: { ...env, ANTHROPIC_BASE_URL: secondFixture.baseUrl,
      ANTHROPIC_API_KEY: 'second-fixture-key' } })
    await second.start(new AbortController().signal)
    expect(await second.runTurn(['Continue after endpoint change'], new AbortController().signal))
      .toEqual([{ type: 'text', text: 'second-endpoint' }])
    expect(second.capturedSessionId()).toBe(identity)
    expect(JSON.stringify(secondFixture.requests.at(-1)?.body)).toContain('endpoint-switch-marker')
    expect(JSON.stringify(fixture.requests.map(request => request.body))).not.toContain('Continue after endpoint change')
    await second.close()
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it.each([true, false])('maps a native Write permission answer %s to an actual file effect', async (allowed) => {
    const { create, workspace } = await harness({ kind: 'tool-use', toolName: 'Write',
      input: { file_path: 'approval.txt', content: 'approved-content' }, finalText: 'write-finished' })
    const permission = Promise.withResolvers<undefined>()
    const adapter = create({ canUseTool: async (name, input) => {
      expect(name).toBe('Write')
      permission.resolve(undefined)
      return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied by test user' }
    } })
    await adapter.start(new AbortController().signal)
    await adapter.runTurn(['Perform the requested write'], new AbortController().signal)
    await permission.promise
    if (allowed) expect(await readFile(join(workspace, 'approval.txt'), 'utf8')).toBe('approved-content')
    else await expect(readFile(join(workspace, 'approval.txt'), 'utf8')).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('loads user and project instruction files like the native CLI', async () => {
    const { create, fixture, workspace, env } = await harness({ kind: 'complete', text: 'memory-loaded' })
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
    await writeFile(join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), 'user-memory-marker-7f3a')
    await writeFile(join(workspace, 'CLAUDE.md'), 'project-memory-marker-9b2c')
    const adapter = create({ settingSources: ['user', 'project', 'local'] })

    await adapter.start(new AbortController().signal)
    await adapter.runTurn(['Summarize your instructions'], new AbortController().signal)

    const body = JSON.stringify(fixture.requests.at(-1)?.body)
    expect(body).toContain('user-memory-marker-7f3a')
    expect(body).toContain('project-memory-marker-9b2c')
    await adapter.close()
  })

  it('interrupts a waiting request and permits the process to close', async () => {
    const { create, fixture, handles } = await harness({ kind: 'hold' })
    const adapter = create()
    await adapter.start(new AbortController().signal)
    const controller = new AbortController()
    const turn = adapter.runTurn(['Wait for cancellation'], controller.signal)
    const rejected = expect(turn).rejects.toThrow()
    await fixture.requestStarted
    controller.abort()
    await rejected
    await adapter.close()
    for (const handle of handles) await expect(handle.waitForExit()).resolves.toBe(true)
  })
})
