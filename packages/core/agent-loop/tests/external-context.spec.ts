/**
 * External engines never prepare an LLM call, so the shared loop records their
 * driver-reported context capacity as `request/context` around each turn.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, {
  AgentEngineId,
  installModelSelection,
  type Agent,
  type EngineTurnDriver,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const ENGINE = AgentEngineId('scripted')

/** Scripted external driver; `windowValue` scripts the reported capacity. */
class ScriptedDriver implements EngineTurnDriver {
  windowValue: number | undefined
  readonly selections: ModelSelection[] = []
  constructor(private readonly behavior?: (signal: AbortSignal, emit: (chunk: StreamChunk) => void) => Promise<void>) {}

  async prepare(selection: ModelSelection): Promise<void> {
    this.selections.push(selection)
  }

  async run(_messages: readonly UserMessage[], signal: AbortSignal, emit: (chunk: StreamChunk) => void): Promise<void> {
    emit({ type: 'block-start', index: 0, blockType: 'text' })
    emit({ type: 'text-delta', index: 0, text: 'ok' })
    emit({ type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } })
    await this.behavior?.(signal, emit)
  }

  contextWindow(): number | undefined {
    return this.windowValue
  }

  async close(): Promise<void> {}
}

async function harness(driver: EngineTurnDriver) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.agents.registerEngine(ENGINE, {
    name: 'Scripted',
    capabilities: {
      textStream: 'delta', steering: 'unsupported', resume: 'unsupported',
      fork: 'unsupported', approval: false, userInput: false, attachment: false,
    },
    endpoints: [],
    driver: () => driver,
  })
  return ctx
}

/** Create an agent locked to the scripted engine before any user input. */
async function engineAgent(ctx: Context, id: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.session.append('engine/selected', { engineId: ENGINE })
  return agent
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function contexts(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'request/context')
}

describe('external engine request/context', () => {
  it('records nothing while the driver has no capacity report', async () => {
    const withoutWindow: EngineTurnDriver = {
      prepare: async () => {},
      run: async (_messages, _signal, emit) => {
        emit({ type: 'block-start', index: 0, blockType: 'text' })
        emit({ type: 'text-delta', index: 0, text: 'ok' })
        emit({ type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } })
      },
      close: async () => {},
    }
    const ctx = await harness(withoutWindow)
    const agent = await engineAgent(ctx, 'external-context-unknown')

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    send(agent, 'second')
    await waitForIdle(ctx, agent)

    expect(contexts(agent)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('records the reported capacity once per change, preserving it when later turns report none', async () => {
    const driver = new ScriptedDriver()
    driver.windowValue = 1000
    const ctx = await harness(driver)
    const agent = await engineAgent(ctx, 'external-context-capacity')

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(contexts(agent).map(event => event.data)).toEqual([
      { provider: 'mock', model: 'mock', contextWindow: 1000 },
    ])

    send(agent, 'dedup')
    await waitForIdle(ctx, agent)
    expect(contexts(agent)).toHaveLength(1)

    driver.windowValue = 2000
    send(agent, 'changed')
    await waitForIdle(ctx, agent)
    expect(contexts(agent).map(event => event.data)).toEqual([
      { provider: 'mock', model: 'mock', contextWindow: 1000 },
      { provider: 'mock', model: 'mock', contextWindow: 2000 },
    ])

    driver.windowValue = undefined
    send(agent, 'kept')
    await waitForIdle(ctx, agent)
    expect(contexts(agent)).toHaveLength(2)
    expect(agent.session.requestContext()?.contextWindow).toBe(2000)
    await ctx.fiber.dispose()
  })

  it('clears a stale capacity when the route changes without a new report', async () => {
    const driver = new ScriptedDriver()
    driver.windowValue = 1000
    const ctx = await harness(driver)
    const agent = await engineAgent(ctx, 'external-context-route-change')

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(contexts(agent)).toHaveLength(1)

    driver.windowValue = undefined
    installModelSelection(agent.ctx, { current: { provider: 'mock', model: 'other' }, assembled: undefined })
    send(agent, 'model changed')
    await waitForIdle(ctx, agent)
    expect(contexts(agent).map(event => event.data)).toEqual([
      { provider: 'mock', model: 'mock', contextWindow: 1000 },
      { provider: 'mock', model: 'other' },
    ])
    expect(agent.session.requestContext()?.contextWindow).toBeUndefined()

    installModelSelection(agent.ctx, { current: { provider: 'other-provider', model: 'other' }, assembled: undefined })
    send(agent, 'provider changed')
    await waitForIdle(ctx, agent)
    expect(contexts(agent).map(event => event.data)).toEqual([
      { provider: 'mock', model: 'mock', contextWindow: 1000 },
      { provider: 'mock', model: 'other' },
      { provider: 'other-provider', model: 'other' },
    ])
    await ctx.fiber.dispose()
  })

  it('settles an interrupted external message with its reported usage', async () => {
    const entered = Promise.withResolvers<undefined>()
    const driver = new ScriptedDriver(async (signal, emit) => {
      emit({ type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 3 } })
      emit({ type: 'block-start', index: 1, blockType: 'text' })
      emit({ type: 'text-delta', index: 1, text: 'partial' })
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('turn aborted')) }, { once: true })
      })
    })
    const ctx = await harness(driver)
    const agent = await engineAgent(ctx, 'external-context-interrupted-usage')

    send(agent, 'interrupt me')
    await entered.promise
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message).toMatchObject({
      type: 'assistant/message',
      data: { interrupted: true, usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 3 } },
    })
    await ctx.fiber.dispose()
  })

  it('settles an interrupted external message without usage when none was reported', async () => {
    const entered = Promise.withResolvers<undefined>()
    const driver = new ScriptedDriver(async (signal, emit) => {
      emit({ type: 'block-start', index: 1, blockType: 'text' })
      emit({ type: 'text-delta', index: 1, text: 'partial' })
      entered.resolve(undefined)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('turn aborted')) }, { once: true })
      })
    })
    const ctx = await harness(driver)
    const agent = await engineAgent(ctx, 'external-context-interrupted-plain')

    send(agent, 'interrupt me')
    await entered.promise
    agent.cancel({ kind: 'user' })
    await waitForIdle(ctx, agent)

    const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && 'usage' in message.data).toBe(false)
    expect(message).toMatchObject({ data: { interrupted: true } })
    await ctx.fiber.dispose()
  })

  it('settles a dispatched turn as acknowledged-uncertain when the driver fails without a terminal settlement', async () => {
    const driver = new ScriptedDriver(async () => {
      throw new Error('transport died mid-turn')
    })
    const ctx = await harness(driver)
    const agent = await engineAgent(ctx, 'external-context-uncertain')

    send(agent, 'will fail')
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const submitted = events.findLast(event => event.type === 'engine/input-submitted')
    const inputId = submitted?.type === 'engine/input-submitted' ? submitted.data.inputId : undefined
    const settled = events.findLast(event => event.type === 'engine/turn-settled')
    expect(settled?.type === 'engine/turn-settled' ? settled.data : undefined)
      .toEqual({ turnId: inputId, outcome: 'acknowledged-uncertain' })
    expect(events.some(event => event.type === 'turn/end')).toBe(true)
    await ctx.fiber.dispose()
  })
})


it('reads the current engine catalog during a turn without preparing the process again', async () => {
  const entered = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  let prepares = 0
  const commands = [{ name: 'skill', description: 'Run a skill', execution: 'prompt' as const }]
  const driver: EngineTurnDriver = {
    prepare: async () => { prepares += 1 },
    commands: async () => commands,
    run: async () => { entered.resolve(true); await release.promise },
    close: async () => {},
  }
  const ctx = await harness(driver)
  const agent = await engineAgent(ctx, 'external-running-catalog')
  try {
    send(agent, 'run')
    await entered.promise
    expect(await agent.engineCommands?.(AbortSignal.timeout(1000))).toEqual(commands)
    expect(prepares).toBe(1)
  } finally {
    release.resolve(true)
    await agent.whenIdle()
    await ctx.fiber.dispose()
  }
})
