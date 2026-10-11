import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import {
  AgentEngineId,
  AgentRegistry,
} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexMainAdapter,
  CodexMainAgent,
  codexEngineDefinition,
  registerCodexEngine,
  type CodexTurnRunner,
} from '../src/index.ts'

const sessionId = (raw: string): SessionId => SessionId(raw)

function scriptedRunner(output: ContentBlock[]): CodexTurnRunner & { turns: string[][] } {
  const turns: string[][] = []
  return {
    turns,
    runTurn: vi.fn(async (texts: string[], _signal: AbortSignal) => {
      turns.push(texts)
      return output
    }),
    interrupt: vi.fn(),
  }
}

describe('Codex engine registration', () => {
  it('registers the codex engine with its endpoint and capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const dispose = registerCodexEngine(ctx, { model: 'gpt-5-codex' })

    const engine = ctx.agents.getEngine(AgentEngineId('codex'))
    expect(engine).toMatchObject({
      name: 'Codex',
      endpoints: ['openai-compatible'],
      capabilities: {
        textStream: 'delta',
        steering: 'unsupported',
        resume: 'native',
        fork: 'unsupported',
        approval: true,
      },
    })
    expect(ctx.agents.resolveEngineId(AgentEngineId('codex'))).toBe(AgentEngineId('codex'))
    await dispose()
    expect(ctx.agents.getEngine(AgentEngineId('codex'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('defines the engine without requiring a factory for catalog listing', () => {
    const definition = codexEngineDefinition()
    expect(definition.factory).toBeUndefined()
    expect(definition.endpoints).toEqual(['openai-compatible'])
  })
})

describe('Codex main agent', () => {
  it('runs a turn through the runner and records observable engine events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sessionId('codex-session-1'), { meta: { cwd: '/workspace' } })
    const runner = scriptedRunner([{ type: 'text', text: 'hello from gpt' }])
    const agent = new CodexMainAgent(sessionId('codex-session-1'), session, ctx, runner, undefined, 'codex')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(runner.turns).toEqual([['hi']])
    const events = session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual([
      'engine/input-submitted',
      'turn/start',
      'engine/item-settled',
      'engine/turn-settled',
      'turn/end',
    ])
    const settled = events.find(event => event.type === 'engine/item-settled')
    expect(settled?.data).toMatchObject({ category: 'assistant-text', revision: 1 })
    const ended = events.find(event => event.type === 'turn/end')
    expect(ended?.data).toMatchObject({ reason: { kind: 'completed' } })
    await ctx.fiber.dispose()
  })

  it('rejects unsupported steering and injection before queue mutation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sessionId('codex-session-2'))
    const agent = new CodexMainAgent(sessionId('codex-session-2'), session, ctx, scriptedRunner([]), undefined, 'codex')
    const message = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })

    expect(() => { agent.steer(message) }).toThrow(/steering is unsupported/)
    expect(() => { agent.inject(message) }).toThrow(/injection is unsupported/)
  })

  it('interrupts the runner on cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sessionId('codex-session-3'))
    const interrupt = vi.fn()
    const runner = { ...scriptedRunner([]), interrupt }
    const agent = new CodexMainAgent(sessionId('codex-session-3'), session, ctx, runner, undefined, 'codex')

    agent.cancel({ kind: 'user' })
    expect(interrupt).toHaveBeenCalled()
  })
})

describe('Codex main adapter', () => {
  function fakeChild(): SubprocessHandle {
    const stdin = new Writable({ write(_chunk, _enc, cb) { cb() } })
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    return {
      pid: 1,
      stdin: stdin as unknown as SubprocessHandle['stdin'],
      stdout: stdout,
      stderr: stderr as unknown as SubprocessHandle['stderr'],
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    } as unknown as SubprocessHandle
  }

  it('starts, runs a turn, and closes through a scripted wire', async () => {
    const spawn = vi.fn(() => fakeChild())
    const scriptedWire = {
      start: vi.fn(),
      initialize: vi.fn(async () => {}),
      startThread: vi.fn(async () => {}),
      runTurn: vi.fn(async () => {}),
      collectOutput: vi.fn(() => [{ type: 'text', text: 'ok' }]),
      interrupt: vi.fn(),
      close: vi.fn(),
      collectFailure: vi.fn(),
      endedBeforeTerminal: vi.fn(() => false),
      collectDiagnostic: vi.fn(),
    }
    const adapter = new CodexMainAdapter(
      {
        cwd: '/workspace',
        permissionMode: 'never',
        env: {},
        disposeGraceMs: 100,
        spawn,
      },
      () => scriptedWire as never,
    )

    await adapter.start(new AbortController().signal)
    expect(scriptedWire.initialize).toHaveBeenCalled()
    expect(scriptedWire.startThread).toHaveBeenCalledWith('/workspace', expect.anything())

    const output = await adapter.runTurn(['hi'], new AbortController().signal)
    expect(scriptedWire.runTurn).toHaveBeenCalledWith(['hi'], expect.anything())
    expect(output).toEqual([{ type: 'text', text: 'ok' }])

    adapter.interrupt()
    expect(scriptedWire.interrupt).toHaveBeenCalled()

    await adapter.close()
    expect(scriptedWire.close).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('rejects a turn before the adapter starts', async () => {
    const adapter = new CodexMainAdapter({
      cwd: '/workspace',
      permissionMode: 'never',
      env: {},
      disposeGraceMs: 100,
      spawn: () => fakeChild(),
    })
    await expect(adapter.runTurn(['hi'], new AbortController().signal))
      .rejects.toThrow(/not started/)
  })
})
