import { Context } from '@deepseek-ai/cordis'
import {
  AgentEngineId,
  AgentRegistry,
} from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ModelUsage, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { Config as MainConfig } from '../src/startup.ts'
import { resolveClaudeReasoning, resolveClaudePermissionMode } from '../src/engine.ts'
import {
  ClaudeMainAdapter,
  ClaudeMainAgent,
  claudeEngineDefinition,
  registerClaudeEngine,
  type ClaudeTurnRunner,
} from '../src/index.ts'

const sessionId = (raw: string): SessionId => SessionId(raw)

function scriptedRunner(output: ContentBlock[]): ClaudeTurnRunner & { turns: string[][] } {
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

/** One result-message per-model usage row with the given context capacity. */
function modelUsageRow(contextWindow: number): ModelUsage {
  return {
    inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0, contextWindow, maxOutputTokens: 64000,
  }
}

/**
 * A scripted official query: consumes the adapter's streaming input and
 * answers each user message with one assistant text block and one success
 * result carrying the given session id.
 */
function scriptedQuery(sessionIdValue = 'session-123', modelUsage?: Record<string, ModelUsage>, onInput?: (input: SDKUserMessage) => void) {
  return (params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: unknown
  }) => {
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      for await (const user of params.prompt as AsyncIterable<SDKUserMessage>) {
        onInput?.(user)
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'message-1',
            role: 'assistant',
            usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: 'hello from claude' }],
          },
        } as SDKMessage
        yield {
          type: 'result',
          subtype: 'success',
          result: 'done',
          session_id: sessionIdValue,
          total_cost_usd: 0.01,
          duration_ms: 100,
          duration_api_ms: 90,
          num_turns: 1,
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: modelUsage ?? { 'claude-sonnet-4-5': modelUsageRow(200000) },
        } as SDKMessage
      }
    })()
    return Object.assign(generator, {
      initializationResult: async () => ({}),
      supportedCommands: async () => [{ name: 'my:skill', description: 'Run a project skill', argumentHint: '<topic>' }],
      interrupt: async () => {},
      setPermissionMode: async () => {},
    })
  }
}

describe('Claude engine registration', () => {
  it('registers the claude engine with its endpoint and capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const dispose = registerClaudeEngine(ctx, { model: 'claude-sonnet-4-5' })

    const engine = ctx.agents.getEngine(AgentEngineId('claude'))
    expect(engine).toMatchObject({
      name: 'Claude',
      endpoints: ['anthropic-api'],
      capabilities: {
        textStream: 'delta',
        steering: 'unsupported',
        resume: 'native',
        fork: 'unsupported',
        approval: true,
      },
    })
    expect(ctx.agents.resolveEngineId(AgentEngineId('claude'))).toBe(AgentEngineId('claude'))
    await dispose()
    expect(ctx.agents.getEngine(AgentEngineId('claude'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('defines the engine without requiring a factory for catalog listing', () => {
    const definition = claudeEngineDefinition()
    expect(definition.factory).toBeUndefined()
    expect(definition.endpoints).toEqual(['anthropic-api'])
  })
})

describe('Claude main adapter', () => {
  it.each([1_048_576, 256_000, undefined])('passes capacity and its 75 percent compaction threshold to Claude: %s', async (contextWindow) => {
    let env: Options['env']
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace', disposeGraceMs: 100,
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' },
      ...contextWindow === undefined ? {} : { contextWindow },
      spawn: () => undefined as never,
      query: ((params) => {
        env = params.options?.env
        return scriptedQuery()(params) as never
      }),
    })
    await adapter.start(new AbortController().signal)
    if (contextWindow === undefined) {
      expect(env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
    } else {
      expect(env).toMatchObject({
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.floor(contextWindow * 0.9)),
      })
    }
    await adapter.close()
  })

  it('runs a turn through the scripted SDK and captures the session id', async () => {
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      query: scriptedQuery('session-abc') as never,
    })

    await adapter.start(new AbortController().signal)
    const output = await adapter.runTurn(['hi'], new AbortController().signal)

    expect(output).toEqual([{ type: 'text', text: 'hello from claude' }])
    expect(adapter.capturedSessionId()).toBe('session-abc')
    expect(adapter.contextWindow()).toBe(200000)
    await adapter.close()
  })

  it.each([
    { model: 'claude-a', modelUsage: { 'claude-a': modelUsageRow(100000), other: modelUsageRow(200000) }, expected: 100000 },
    { model: 'claude-a', modelUsage: { zzz: modelUsageRow(300000) }, expected: 300000 },
    { model: 'claude-a', modelUsage: { x: modelUsageRow(1), y: modelUsageRow(2) }, expected: undefined },
    { model: undefined, modelUsage: { only: modelUsageRow(400000) }, expected: 400000 },
    { model: undefined, modelUsage: { x: modelUsageRow(1), y: modelUsageRow(2) }, expected: undefined },
  ])('reads the served model capacity from result modelUsage: $expected', async ({ model, modelUsage, expected }) => {
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      ...model === undefined ? {} : { model },
      query: scriptedQuery('session-usage', modelUsage) as never,
    })

    await adapter.start(new AbortController().signal)
    await adapter.runTurn(['hi'], new AbortController().signal)

    expect(adapter.contextWindow()).toBe(expected)
    await adapter.close()
  })

  it('reads current context occupancy and the resolved window from getContextUsage', async () => {
    const query = (params: { prompt: unknown }) => Object.assign(scriptedQuery('session-ctx')(params as never), {
      getContextUsage: async () => ({ totalTokens: 50_000, maxTokens: 180_000 }),
    })
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      query: query as never,
    })

    await adapter.start(new AbortController().signal)
    const chunks: import('@deepseek-ai/dsh-llm').StreamChunk[] = []
    await adapter.runTurn(['hi'], new AbortController().signal, (chunk) => { chunks.push(chunk) })

    expect(chunks.filter(chunk => chunk.type === 'usage').at(-1)).toEqual({
      type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextInputTokens: 50_000, sessionTotalTokens: 2 },
    })
    expect(adapter.contextWindow()).toBe(180_000)
    await adapter.close()
  })

  it('falls back to the per-call prompt and raw window when getContextUsage is unavailable', async () => {
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      query: scriptedQuery('session-ctx-fallback') as never,
    })

    await adapter.start(new AbortController().signal)
    const chunks: import('@deepseek-ai/dsh-llm').StreamChunk[] = []
    await adapter.runTurn(['hi'], new AbortController().signal, (chunk) => { chunks.push(chunk) })

    expect(chunks.filter(chunk => chunk.type === 'usage').at(-1)).toEqual({
      type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextInputTokens: 1, sessionTotalTokens: 2 },
    })
    expect(adapter.contextWindow()).toBe(200000)
    await adapter.close()
  })

  it('forwards resolved setting sources and omits them when unset', async () => {
    const seen: unknown[] = []
    const query = (params: { prompt: unknown; options?: unknown }) => {
      seen.push(params.options)
      return scriptedQuery()(params as never)
    }
    const base = {
      cwd: '/workspace', permissionMode: 'dontAsk' as const, env: {}, disposeGraceMs: 100,
      spawn: () => undefined as never,
    }

    const withSources = new ClaudeMainAdapter({ ...base, settingSources: ['user'], query: query as never })
    await withSources.start(new AbortController().signal)
    await withSources.close()
    expect((seen[0] as { settingSources?: unknown }).settingSources).toEqual(['user'])

    const withoutSources = new ClaudeMainAdapter({ ...base, query: query as never })
    await withoutSources.start(new AbortController().signal)
    await withoutSources.close()
    expect(seen[1]).not.toHaveProperty('settingSources')
  })

  it('rejects a turn before the adapter starts', async () => {
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      query: scriptedQuery() as never,
    })
    await expect(adapter.runTurn(['hi'], new AbortController().signal))
      .rejects.toThrow(/not started/)
  })

  it('switches the live permission mode through the SDK query after start', async () => {
    const modes: string[] = []
    const adapter = new ClaudeMainAdapter({
      cwd: '/workspace',
      permissionMode: 'dontAsk',
      env: {},
      disposeGraceMs: 100,
      spawn: () => undefined as never,
      query: ((params: { prompt: unknown }) => Object.assign(scriptedQuery()(params as never), {
        setPermissionMode: async (mode: string) => { modes.push(mode) },
      })) as never,
    })
    await expect(adapter.setPermissionMode('plan', new AbortController().signal)).rejects.toThrow(/not started/)
    await adapter.start(new AbortController().signal)
    await adapter.setPermissionMode('plan', new AbortController().signal)
    expect(modes).toEqual(['plan'])
    await adapter.close()
  })
})

describe('Claude main agent', () => {
  it('runs a turn through the runner and records observable engine events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sessionId('claude-session-1'), { meta: { cwd: '/workspace' } })
    const runner = scriptedRunner([{ type: 'text', text: 'hello from claude' }])
    const agent = new ClaudeMainAgent(sessionId('claude-session-1'), session, ctx, runner, undefined, 'claude')

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
    const session = ctx.sessions.create(sessionId('claude-session-2'))
    const agent = new ClaudeMainAgent(sessionId('claude-session-2'), session, ctx, scriptedRunner([]), undefined, 'claude')
    const message = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })

    expect(() => { agent.steer(message) }).toThrow(/steering is unsupported/)
    expect(() => { agent.inject(message) }).toThrow(/injection is unsupported/)
  })

  it('interrupts the runner on cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(sessionId('claude-session-3'))
    const interrupt = vi.fn()
    const runner = { ...scriptedRunner([]), interrupt }
    const agent = new ClaudeMainAgent(sessionId('claude-session-3'), session, ctx, runner, undefined, 'claude')

    agent.cancel({ kind: 'user' })
    expect(interrupt).toHaveBeenCalled()
  })
})

describe('resolveClaudePermissionMode', () => {
  it('translates a full-access no-approval session policy into the native bypass mode', () => {
    expect(resolveClaudePermissionMode({ sandbox: 'danger-full-access', approval: 'never' }))
      .toBe('bypassPermissions')
  })

  it('maps workspace write to edit acceptance', () => {
    expect(resolveClaudePermissionMode({ sandbox: 'workspace-write', approval: 'ask' })).toBe('acceptEdits')
    expect(resolveClaudePermissionMode({ sandbox: 'workspace-write', approval: 'never' })).toBe('acceptEdits')
  })

  it('keeps the native default behavior for read-only and ask-approval full access', () => {
    expect(resolveClaudePermissionMode({ sandbox: 'read-only', approval: 'ask' })).toBeUndefined()
    expect(resolveClaudePermissionMode({ sandbox: 'read-only', approval: 'never' })).toBeUndefined()
    expect(resolveClaudePermissionMode({ sandbox: 'danger-full-access', approval: 'ask' })).toBeUndefined()
  })
})


it('passes structured image input and reads the prepared SDK command catalog', async () => {
  const seen: SDKUserMessage[] = []
  const adapter = new ClaudeMainAdapter({
    cwd: '/workspace', permissionMode: 'dontAsk', env: {}, disposeGraceMs: 100,
    spawn: () => undefined as never,
    query: scriptedQuery('image-session', undefined, (input) => { seen.push(input) }) as never,
  })
  const content = [
    { type: 'text' as const, text: 'describe' },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' } },
  ]
  try {
    await adapter.start(AbortSignal.timeout(1000))
    const chunks: import('@deepseek-ai/dsh-llm').StreamChunk[] = []
    await adapter.runTurn(content, AbortSignal.timeout(1000), (chunk) => { chunks.push(chunk) })
    expect(seen[0]?.message.content).toEqual(content)
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, contextInputTokens: 1, sessionTotalTokens: 2 } },
    ])
    expect(await adapter.supportedCommands()).toEqual([
      { name: 'my:skill', description: 'Run a project skill', argumentHint: '<topic>' },
    ])
  } finally {
    await adapter.close()
  }
})


it('preserves disabled thinking and exact-model effort overrides in main-engine configuration', () => {
  const parsed = MainConfig({ providers: { gateway: {
    reasoningEfforts: { off: null, max: 'xhigh' }, defaultReasoningEffort: 'max',
    models: { small: { reasoningEfforts: { off: null, minimal: 'low' }, defaultReasoningEffort: 'minimal' } },
  } } })
  expect(parsed.providers?.gateway?.reasoningEfforts).toEqual({ off: null, max: 'xhigh' })
  const reasoning = resolveClaudeReasoning(undefined, parsed.providers?.gateway?.models?.small)
  expect(reasoning?.defaultEffort).toBe('minimal')
  expect(reasoning?.efforts.map(effort => ({ id: effort.id, wireValue: effort.wireValue }))).toEqual([
    { id: 'off', wireValue: null }, { id: 'minimal', wireValue: 'low' },
  ])
})
