import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentEngineId, NATIVE_ENGINE_CAPABILITIES } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionEngineConflict,
  engineFromEvents,
} from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

function controllerAgents(overrides: object = {}): ApiSessionAgentController {
  return {
    ensureSession: () => Promise.resolve(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForSession: () => undefined,
    presetForObservation: () => undefined,
    engineForSession: () => undefined,
    selectionFor: () => ({ current: { provider: 'fixture', model: 'fixture-model' } }),
    serializeImageAdmission: <T>(_agent: Agent, operation: () => Promise<T>) => operation(),
    ...overrides,
  } as unknown as ApiSessionAgentController
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

/** A session-creating ensureSession stub that records the resolved engine event. */
function creatingEnsureSession(ctx: Context) {
  return vi.fn((
    sessionId: SessionId,
    cwd: string,
    _check: boolean,
    _preset: string | undefined,
    engineId: string | undefined,
  ) => {
    const session = ctx.sessions.create(sessionId, { meta: { cwd } })
    if (engineId !== undefined) session.append('engine/selected', { engineId })
    return Promise.resolve({ id: sessionId, session } as Agent)
  })
}

function engineReadingAgents(ensureSession: ReturnType<typeof creatingEnsureSession>): ApiSessionAgentController {
  return controllerAgents({
    ensureSession,
    engineForSession: (session: Agent['session']) => engineFromEvents(session.snapshotEvents()),
  })
}

describe('session engine selection', () => {
  it('resolves a registered engine and hands it to session creation', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    ctx.agents.registerEngine(AgentEngineId('codex'), {
      name: 'Codex',
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      endpoints: ['openai-compatible'],
    })
    const ensureSession = creatingEnsureSession(ctx)
    const controller = new SessionCommandController(
      ctx,
      engineReadingAgents(ensureSession),
      '/default-workspace',
    )

    const created = await controller.create({ engineId: 'codex' })

    expect(created.engineId).toBe('codex')
    expect(ensureSession).toHaveBeenCalledWith(
      created.sessionId,
      '/default-workspace',
      false,
      undefined,
      'codex',
    )
    await ctx.fiber.dispose()
  })

  it('rejects an unknown explicit engine before session creation', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.create({ engineId: 'missing-engine' }), 'engine/not-found')
    await ctx.fiber.dispose()
  })

  it('maps an engine conflict on adoption to session/engine-conflict', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    ctx.agents.registerEngine(AgentEngineId('codex'), {
      name: 'Codex',
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      endpoints: ['openai-compatible'],
    })
    const conflict = new ApiSessionEngineConflict(SessionId('taken'), 'codex', 'native')
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession: () => Promise.reject(conflict) }),
      '/default',
    )

    await expectFailure(controller.create({ engineId: 'codex' }), 'session/engine-conflict')
    await ctx.fiber.dispose()
  })

  it('reads the immutable engine selection back from the event log', async () => {
    const ctx = await baseContext()
    const session = ctx.sessions.create(SessionId('session-eng'), { meta: { cwd: '/workspace' } })
    session.append('engine/selected', { engineId: 'codex' })

    expect(engineFromEvents(session.snapshotEvents())).toBe('codex')
    expect(engineFromEvents([])).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not emit an engine event for the deployment default', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const ensureSession = creatingEnsureSession(ctx)
    const controller = new SessionCommandController(
      ctx,
      engineReadingAgents(ensureSession),
      '/default-workspace',
    )

    const created = await controller.create({})

    expect(created).not.toHaveProperty('engineId')
    await ctx.fiber.dispose()
  })

  it('selectEngine clears old effort and permits changes until a user message', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    ctx.agents.registerEngine(AgentEngineId('codex'), {
      name: 'Codex',
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      endpoints: ['openai-compatible'],
    })
    ctx.agents.registerEngine(AgentEngineId('native'), {
      name: 'Native',
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      endpoints: [],
    })
    let agent!: Agent
    const selectForNextRequest = vi.fn()
    const ensureSession = vi.fn((sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      agent = { id: sessionId, session } as Agent
      return Promise.resolve(agent)
    })
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({
        ensureSession,
        selectionFor: () => ({ current: { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'max' } }),
        selectForNextRequest,
        resolveAgent: () => Promise.resolve({ agent } as never),
        engineForSession: (session: Agent['session']) => engineFromEvents(session.snapshotEvents()),
      }),
      '/default-workspace',
    )
    const created = await controller.create({})

    const selected = await controller.selectEngine({ sessionId: created.sessionId, engineId: 'codex' })
    expect(selected.engineId).toBe('codex')
    expect(selectForNextRequest).toHaveBeenCalledWith(agent, { provider: 'fixture', model: 'fixture-model' })
    expect(engineFromEvents(agent.session.snapshotEvents())).toBe('codex')

    // Before the first user message the selection may still change.
    const reselected = await controller.selectEngine({ sessionId: created.sessionId, engineId: 'native' })
    expect(reselected.engineId).toBe('native')
    expect(engineFromEvents(agent.session.snapshotEvents())).toBe('native')

    // The first user message locks the engine.
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectFailure(
      controller.selectEngine({ sessionId: created.sessionId, engineId: 'codex' }),
      'session/engine-locked',
    )
    // Idempotent: re-selecting the same engine is accepted.
    await expect(controller.selectEngine({ sessionId: created.sessionId, engineId: 'native' }))
      .resolves.toEqual({ engineId: 'native' })
    await ctx.fiber.dispose()
  })

  it('selectEngine rejects an unknown engine and a session with a user message', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    ctx.agents.registerEngine(AgentEngineId('codex'), {
      name: 'Codex',
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      endpoints: ['openai-compatible'],
    })
    let agent!: Agent
    const ensureSession = vi.fn((sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      agent = { id: sessionId, session } as Agent
      return Promise.resolve(agent)
    })
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({
        ensureSession,
        resolveAgent: () => Promise.resolve({ agent } as never),
        engineForSession: (session: Agent['session']) => engineFromEvents(session.snapshotEvents()),
      }),
      '/default-workspace',
    )
    const created = await controller.create({})

    await expectFailure(
      controller.selectEngine({ sessionId: created.sessionId, engineId: 'missing' }),
      'engine/not-found',
    )
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'dispatched' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectFailure(
      controller.selectEngine({ sessionId: created.sessionId, engineId: 'codex' }),
      'session/engine-locked',
    )
    await ctx.fiber.dispose()
  })
})
