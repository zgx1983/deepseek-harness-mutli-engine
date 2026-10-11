import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  AgentEngineId,
  NATIVE_ENGINE_CAPABILITIES,
  NATIVE_ENGINE_ID,
} from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentEngineDefinition,
  AgentFactory,
} from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { enginePlanModeFor, recordEnginePlanMode, acknowledgeUncertainEngineInputs } from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function codexDefinition(factory?: AgentFactory): AgentEngineDefinition {
  return {
    name: 'Codex',
    capabilities: {
      textStream: 'item',
      steering: 'active-turn',
      resume: 'native',
      fork: 'unsupported',
      approval: true,
      userInput: false,
      attachment: false,
    },
    endpoints: ['openai-compatible'],
    ...(factory === undefined ? {} : { factory }),
  }
}

async function registry(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin(AgentRegistry)
  await fiber
  return {
    ctx,
    dispose: () => fiber.dispose(),
  }
}

describe('agent engine registry', () => {
  it('registers engines and lists them in registration order', async () => {
    const { ctx, dispose } = await registry()
    try {
      const disposeNative = ctx.agents.registerEngine(NATIVE_ENGINE_ID, {
        name: 'Native',
        capabilities: NATIVE_ENGINE_CAPABILITIES,
        endpoints: [],
      })
      const disposeCodex = ctx.agents.registerEngine(AgentEngineId('codex'), codexDefinition())

      expect(ctx.agents.listEngines()).toEqual([
        {
          id: NATIVE_ENGINE_ID,
          name: 'Native',
          capabilities: NATIVE_ENGINE_CAPABILITIES,
          endpoints: [],
        },
        {
          id: AgentEngineId('codex'),
          name: 'Codex',
          capabilities: codexDefinition().capabilities,
          endpoints: ['openai-compatible'],
        },
      ])
      expect(ctx.agents.getEngine(AgentEngineId('codex'))?.name).toBe('Codex')

      await disposeNative()
      await disposeCodex()
      expect(ctx.agents.listEngines()).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('rejects duplicate ids and invalid definitions without mutating the registry', async () => {
    const { ctx, dispose } = await registry()
    try {
      ctx.agents.registerEngine(AgentEngineId('codex'), codexDefinition())
      expect(() => ctx.agents.registerEngine(AgentEngineId('codex'), codexDefinition()))
        .toThrow(/already registered/)
      expect(() => ctx.agents.registerEngine(AgentEngineId(''), codexDefinition()))
        .toThrow(/must not be empty/)
      expect(() => ctx.agents.registerEngine(AgentEngineId('x'), {
        ...codexDefinition(),
        name: '   ',
      })).toThrow(/must not be empty/)
      expect(ctx.agents.listEngines()).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('requireEngine rejects unknown identities', async () => {
    const { ctx, dispose } = await registry()
    try {
      ctx.agents.registerEngine(AgentEngineId('codex'), codexDefinition())
      expect(() => ctx.agents.requireEngine(AgentEngineId('missing')))
        .toThrow(/no agent engine "missing" is registered/)
      expect(() => ctx.agents.requireEngine(AgentEngineId('codex'))).not.toThrow()
    } finally {
      await dispose()
    }
  })

  it('resolves an explicit request, otherwise the native default', async () => {
    const { ctx, dispose } = await registry()
    try {
      expect(ctx.agents.resolveEngineId(undefined)).toBe(NATIVE_ENGINE_ID)
      expect(ctx.agents.resolveEngineId(AgentEngineId('codex'))).toBe(AgentEngineId('codex'))
    } finally {
      await dispose()
    }
  })

  it('routes create and resume through the engine-owned factory', async () => {
    const { ctx, dispose } = await registry()
    try {
      const calls: string[] = []
      const engineFactory: AgentFactory = {
        createAgent: async () => {
          calls.push('create')
          return { agent: stubAgent('engine-child'), dispose: async () => {} }
        },
        resume: async () => {
          calls.push('resume')
          return { agent: stubAgent('engine-child'), dispose: async () => {} }
        },
      }
      ctx.agents.registerEngine(AgentEngineId('codex'), codexDefinition(engineFactory))

      await ctx.agents.create({ sessionId: SessionId('session-1'), engineId: AgentEngineId('codex') })
      await ctx.agents.resume({ resumeSessionId: SessionId('session-1'), engineId: AgentEngineId('codex') })
      expect(calls).toEqual(['create', 'resume'])
    } finally {
      await dispose()
    }
  })

  it('falls back to the single registered factory when the engine declares none', async () => {
    const { ctx, dispose } = await registry()
    try {
      const calls: string[] = []
      ctx.agents.setFactory({
        createAgent: async () => {
          calls.push('create')
          return { agent: stubAgent('native-child'), dispose: async () => {} }
        },
        resume: async () => {
          calls.push('resume')
          return { agent: stubAgent('native-child'), dispose: async () => {} }
        },
      })
      ctx.agents.registerEngine(AgentEngineId('native'), {
        name: 'Native',
        capabilities: NATIVE_ENGINE_CAPABILITIES,
        endpoints: [],
      })
      await ctx.agents.create({ sessionId: SessionId('session-2'), engineId: NATIVE_ENGINE_ID })
      expect(calls).toEqual(['create'])
    } finally {
      await dispose()
    }
  })
})

describe('engine plan-mode records', () => {
  it('round-trips the latest plan state and rejects invalid payloads', () => {
    const agent = stubAgent('plan-mode-records')
    expect(enginePlanModeFor(agent, 'claude')).toBeUndefined()
    recordEnginePlanMode(agent, 'claude', true)
    recordEnginePlanMode(agent, 'codex', false)
    expect(enginePlanModeFor(agent, 'claude')).toBe(true)
    expect(enginePlanModeFor(agent, 'codex')).toBe(false)
    recordEnginePlanMode(agent, 'claude', true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'engine/item-settled'
      && event.data.category === 'mode')).toHaveLength(2)
    recordEnginePlanMode(agent, 'claude', false)
    expect(enginePlanModeFor(agent, 'claude')).toBe(false)

    const broken = stubAgent('plan-mode-invalid')
    broken.session.append('engine/item-settled', {
      nativeItemId: 'claude:plan-mode', revision: 1, category: 'mode', payload: { engineId: 'claude', plan: 'yes' },
    })
    expect(() => enginePlanModeFor(broken, 'claude')).toThrow('Invalid engine plan-mode record')
  })
})

describe('engine delivery ledger', () => {
  it('acknowledges every unsettled input exactly once and leaves settled entries alone', () => {
    const agent = stubAgent('engine-delivery-ledger')
    agent.session.append('engine/input-submitted', { inputId: 'a', attemptId: 'a1', contentRef: 'a', operation: 'prompt' })
    agent.session.append('engine/turn-settled', { turnId: 'a', outcome: 'completed' })
    agent.session.append('engine/input-submitted', { inputId: 'b', attemptId: 'b1', contentRef: 'b', operation: 'prompt' })
    agent.session.append('engine/input-submitted', { inputId: 'c', attemptId: 'c1', contentRef: 'c', operation: 'prompt' })

    expect(acknowledgeUncertainEngineInputs(agent)).toBe(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'engine/turn-settled')).toEqual([
      expect.objectContaining({ data: { turnId: 'a', outcome: 'completed' } }),
      expect.objectContaining({ data: { turnId: 'b', outcome: 'acknowledged-uncertain' } }),
      expect.objectContaining({ data: { turnId: 'c', outcome: 'acknowledged-uncertain' } }),
    ])

    expect(acknowledgeUncertainEngineInputs(agent)).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'engine/turn-settled')).toHaveLength(3)
  })
})
