import { Context } from '@deepseek-ai/cordis'
import { AgentEngineId, AgentRegistry, installModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ClaudeMainAdapterSpec } from '../src/main-adapter.ts'
import { ClaudeMainFactory, registerClaudeEngine } from '../src/engine.ts'

const captured = vi.hoisted(() => ({ specs: [] as ClaudeMainAdapterSpec[],
  lifecycle: [] as string[], close: undefined as (() => Promise<void>) | undefined,
  window: undefined as number | undefined,
  commands: [] as Array<{ name: string; description: string; argumentHint: string }>,
  modes: [] as string[],
  sandboxSwitches: [] as unknown[],
  sandboxFailure: undefined as string | undefined }))
vi.mock('../src/main-adapter.ts', async (original) => {
  const actual = await original<typeof import('../src/main-adapter.ts')>()
  return {
    ...actual,
    ClaudeMainAdapter: class {
      constructor(private readonly spec: ClaudeMainAdapterSpec) { captured.specs.push(spec) }
      async start(): Promise<void> {
        captured.lifecycle.push(`start:${this.spec.env?.ANTHROPIC_BASE_URL}`)
        if (this.spec.nativeSessionId !== undefined) this.spec.onSessionId?.(this.spec.nativeSessionId)
      }
      async close(): Promise<void> {
        captured.lifecycle.push(`close:${this.spec.env?.ANTHROPIC_BASE_URL}`)
        await captured.close?.()
        captured.lifecycle.push(`exit:${this.spec.env?.ANTHROPIC_BASE_URL}`)
      }
      isReady(): boolean { return true }
      contextWindow(): number | undefined { return captured.window }
      supportedCommands(): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
        return Promise.resolve(captured.commands)
      }
      isSkill(): boolean { return false }
      async setPermissionMode(mode: string): Promise<void> { captured.modes.push(mode) }
      async applySandboxSettings(settings: unknown): Promise<void> {
        if (captured.sandboxFailure !== undefined) throw new Error(captured.sandboxFailure)
        captured.sandboxSwitches.push(settings)
      }
    },
  }
})
afterEach(() => {
  captured.specs.length = 0
  captured.lifecycle.length = 0
  captured.close = undefined
  captured.window = undefined
  captured.commands = []
  captured.modes = []
  captured.sandboxSwitches = []
  captured.sandboxFailure = undefined
})

it('restarts after provider or endpoint changes, waits for exit and resumes the native session', async () => {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-claude-route-'))
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => {
    if (id === 'selected-model') throw new Error('provider does not advertise alias metadata')
    return { provider, id, name: id }
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  ctx.provide('permissionPresets', { current: () => 'workspace-write',
    effective: () => ({ sandbox: 'workspace-write', approval: 'ask' }) } as never)
  ctx.provide('subprocess', { resolveExecutable: async () => '/fake/claude' } as never)
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => ['fallback', 'team.gateway'].map(id => ({
    id, name: id, endpoints: [{
      id: 'anthropic-api', name: 'Claude', baseUrl: `https://example.test/${id}?label="quoted"`, credentialRef: id.replaceAll('.', '_'),
    }],
  })))
  ctx.provide('credentials', { resolve: async (ref: string) => ({ value: ref === 'fallback' ? 'other-secret' : 'test-secret', source: 'test' }) } as never)
  registerClaudeEngine(ctx, { providers: { 'team.gateway': { opusModel: 'deepseek-flash[1m]',
    sonnetModel: 'deepseek-flash[1m]', haikuModel: 'deepseek-flash', subagentModel: 'deepseek-flash',
    models: { 'selected-model': { reasoningEfforts: { off: null, max: 'xhigh' }, defaultReasoningEffort: 'max' } } } } })
  try {
    const handle = await new ClaudeMainFactory(ctx, { provider: 'fallback', model: 'default', providers: {
      'team.gateway': { opusModel: 'deepseek-flash[1m]', sonnetModel: 'deepseek-flash[1m]',
        haikuModel: 'deepseek-flash', subagentModel: 'deepseek-flash' },
    } }).createAgent(ctx, {
      sessionId: SessionId('selected-claude'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'team.gateway', model: 'selected-model' },
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    const spec = captured.specs[0]
    expect(spec?.model).toBe('selected-model')
    expect(spec?.effort).toBe('xhigh')
    // The session preset maps workspace write onto native edit acceptance.
    expect(spec?.permissionMode).toBe('acceptEdits')
    expect(handle.agent.options).toEqual({ provider: 'team.gateway', model: 'selected-model' })
    expect(spec?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://example.test/team.gateway?label="quoted"',
      ANTHROPIC_API_KEY: 'test-secret',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash', CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.specs).toHaveLength(1)
    const closing = Promise.withResolvers<undefined>()
    const exited = Promise.withResolvers<undefined>()
    captured.close = async () => { closing.resolve(undefined); await exited.promise }
    installModelSelection(handle.agent.ctx, { current: { provider: 'fallback', model: 'other-model' }, assembled: undefined })
    const restarting = handle.agent.prepareExecution?.(new AbortController().signal)
    await closing.promise
    expect(captured.specs).toHaveLength(1)
    exited.resolve(undefined)
    await restarting
    captured.close = undefined
    expect(captured.specs).toHaveLength(2)
    expect(captured.specs[1]).toMatchObject({ model: 'other-model', resume: false,
      nativeSessionId: spec?.nativeSessionId, env: { ANTHROPIC_BASE_URL: 'https://example.test/fallback?label="quoted"', ANTHROPIC_API_KEY: 'other-secret',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'other-model', CLAUDE_CODE_SUBAGENT_MODEL: 'other-model' } })
    expect(captured.lifecycle.slice(0, 4)).toEqual([
      'start:https://example.test/team.gateway?label="quoted"',
      'close:https://example.test/team.gateway?label="quoted"',
      'exit:https://example.test/team.gateway?label="quoted"',
      'start:https://example.test/fallback?label="quoted"',
    ])
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'fallback', name: 'fallback', endpoints: [{
      id: 'anthropic-api', name: 'Claude', baseUrl: 'https://new-endpoint.test/anthropic', credentialRef: 'fallback',
    }] }])
    handle.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Delivered native input' }],
    }), { surfaceOp: 'append' })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.specs).toHaveLength(3)
    expect(captured.specs[2]).toMatchObject({ model: 'other-model', resume: true,
      nativeSessionId: spec?.nativeSessionId, env: { ANTHROPIC_BASE_URL: 'https://new-endpoint.test/anthropic' } })
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('passes provider capacity at startup and reports the native capacity once observed', async () => {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-claude-window-'))
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({
    provider, id, name: id, context: { contextWindow: 1_048_576 },
  }))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  ctx.provide('permissionPresets', { current: () => 'workspace-write',
    effective: () => ({ sandbox: 'workspace-write', approval: 'ask' }) } as never)
  ctx.provide('subprocess', { resolveExecutable: async () => '/fake/claude' } as never)
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => [{ id: 'fallback', name: 'fallback', endpoints: [{
    id: 'anthropic-api', name: 'Claude', baseUrl: 'https://example.test/fallback', credentialRef: 'fallback',
  }] }])
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-secret', source: 'test' }) } as never)
  registerClaudeEngine(ctx, { providers: { fallback: { models: { 'selected-model': { reasoningEfforts: { off: null, high: 'high' }, defaultReasoningEffort: 'off' } } } } })
  try {
    const handle = await new ClaudeMainFactory(ctx, {}).createAgent(ctx, {
      sessionId: SessionId('claude-window'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('claude'))?.driver?.(handle.agent)
    if (driver === undefined) throw new Error('claude engine has no execution driver')

    expect(driver.contextWindow?.()).toBeUndefined()
    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, new AbortController().signal)
    expect(captured.specs[0]?.contextWindow).toBe(1_048_576)
    expect(driver.contextWindow?.()).toBeUndefined()
    expect(captured.specs[0]?.thinking).toEqual({ type: 'disabled' })
    expect(captured.specs[0]?.effort).toBeUndefined()
    captured.window = 200000
    expect(driver.contextWindow?.()).toBe(200000)
    await driver.close()
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('exposes /plan as a control command, records switches, and restores them across restarts', async () => {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-claude-plan-'))
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id }))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  ctx.provide('permissionPresets', { current: () => 'workspace-write',
    effective: () => ({ sandbox: 'workspace-write', approval: 'ask' }) } as never)
  ctx.provide('subprocess', { resolveExecutable: async () => '/fake/claude' } as never)
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => [{ id: 'fallback', name: 'fallback', endpoints: [{
    id: 'anthropic-api', name: 'Claude', baseUrl: 'https://example.test/fallback', credentialRef: 'fallback',
  }] }])
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-secret', source: 'test' }) } as never)
  registerClaudeEngine(ctx, {})
  captured.commands = [
    { name: 'resume', description: 'Lifecycle control', argumentHint: '' },
    { name: 'plan', description: 'Native duplicate', argumentHint: '' },
    { name: 'review', description: 'Review a scope', argumentHint: '<scope>' },
  ]
  const signal = new AbortController().signal
  try {
    const handle = await new ClaudeMainFactory(ctx, {}).createAgent(ctx, {
      sessionId: SessionId('claude-plan'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('claude'))?.driver?.(handle.agent)
    if (driver === undefined) throw new Error('claude engine has no execution driver')
    if (driver.commands === undefined || driver.executeCommand === undefined) {
      throw new Error('claude engine has no command surface')
    }

    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    const commands = await driver.commands()
    expect(commands[0]).toEqual({
      name: 'plan', description: 'Toggle the native plan permission mode', argumentHint: '[off]', execution: 'action',
    })
    expect(commands.filter(command => command.name === 'plan')).toHaveLength(1)
    expect(commands.some(command => command.name === 'resume')).toBe(false)

    await driver.executeCommand('plan', '', signal)
    expect(captured.modes).toEqual(['plan'])
    const record = handle.agent.session.snapshotEvents().find(event =>
      event.type === 'engine/item-settled' && event.data.category === 'mode')
    expect(record?.data).toMatchObject({ category: 'mode', payload: { engineId: 'claude', plan: true } })

    captured.modes.length = 0
    await driver.close()
    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    expect(captured.specs[1]).toMatchObject({ permissionMode: 'plan', bypassAllowed: false })

    await driver.executeCommand('plan', 'off', signal)
    expect(captured.modes).toEqual(['acceptEdits'])
    const exitRecord = handle.agent.session.snapshotEvents().filter(event =>
      event.type === 'engine/item-settled' && event.data.category === 'mode').at(-1)
    expect(exitRecord?.data).toMatchObject({ payload: { engineId: 'claude', plan: false } })

    captured.modes.length = 0
    await driver.close()
    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    expect(captured.specs[2]?.permissionMode).toBe('acceptEdits')
    await driver.close()
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('maps each permission level to a native mode and resumes across a permission-switch restart', async () => {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-claude-permissions-'))
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id }))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  const policy = { sandbox: 'workspace-write' as 'read-only' | 'workspace-write' | 'danger-full-access',
    approval: 'ask' as 'ask' | 'never' }
  ctx.provide('permissionPresets', { current: () => 'workspace-write', effective: () => policy } as never)
  ctx.provide('subprocess', { resolveExecutable: async () => '/fake/claude' } as never)
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => [{ id: 'fallback', name: 'fallback', endpoints: [{
    id: 'anthropic-api', name: 'Claude', baseUrl: 'https://example.test/fallback', credentialRef: 'fallback',
  }] }])
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-secret', source: 'test' }) } as never)
  registerClaudeEngine(ctx, {})
  try {
    const handle = await new ClaudeMainFactory(ctx, {}).createAgent(ctx, {
      sessionId: SessionId('claude-permissions'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const storage = join(home, 'engines', 'claude')
    await handle.agent.prepareExecution?.(new AbortController().signal)
    const nativeId = captured.specs[0]?.nativeSessionId
    expect(nativeId).toBeDefined()
    // The session permission preset is the only permission source: no host
    // settings are mirrored into the engine config home.
    await expect(readFile(join(storage, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(captured.specs[0]?.sandbox).toMatchObject({ filesystem: { allowWrite: ['/workspace'] } })
    expect(captured.specs[0]).toMatchObject({ permissionMode: 'acceptEdits', bypassAllowed: false })

    // A /permission switch lands between turns; the next preparation restarts
    // the engine under the new level and resumes the same native conversation.
    handle.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Delivered native input' }],
    }), { surfaceOp: 'append' })
    policy.sandbox = 'read-only'
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.specs).toHaveLength(2)
    expect(captured.specs[1]).toMatchObject({
      resume: true, nativeSessionId: nativeId, bypassAllowed: false,
      tools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
    })
    expect(captured.specs[1]).not.toHaveProperty('permissionMode')
    expect(captured.specs[1]?.sandbox).toMatchObject({ filesystem: { allowWrite: [] } })

    policy.sandbox = 'danger-full-access'
    policy.approval = 'never'
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.specs[2]).toMatchObject({ permissionMode: 'bypassPermissions', bypassAllowed: true })
    expect(captured.specs[2]?.sandbox).toBeUndefined()
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

it('reconciles a permission change on the live process and rebuilds when the switch is refused', async () => {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-claude-live-permissions-'))
  await ctx.plugin(LlmRuntime)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id }))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  const policy = { sandbox: 'workspace-write' as 'read-only' | 'workspace-write' | 'danger-full-access',
    approval: 'ask' as 'ask' | 'never' }
  ctx.provide('permissionPresets', { current: () => 'workspace-write', effective: () => policy } as never)
  ctx.provide('subprocess', { resolveExecutable: async () => '/fake/claude' } as never)
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => [{ id: 'fallback', name: 'fallback', endpoints: [{
    id: 'anthropic-api', name: 'Claude', baseUrl: 'https://example.test/fallback', credentialRef: 'fallback',
  }] }])
  ctx.provide('credentials', { resolve: async () => ({ value: 'test-secret', source: 'test' }) } as never)
  registerClaudeEngine(ctx, {})
  try {
    const handle = await new ClaudeMainFactory(ctx, {}).createAgent(ctx, {
      sessionId: SessionId('claude-live-permissions'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('claude'))?.driver?.(handle.agent)
    if (driver?.executeCommand === undefined) throw new Error('claude engine has no command surface')
    const selection = { provider: 'fallback', model: 'selected-model' }
    const signal = new AbortController().signal
    await driver.prepare(selection, signal)
    expect(captured.specs).toHaveLength(1)

    // Approval alone: the same process receives the tightened sandbox block.
    policy.approval = 'never'
    await driver.prepare(selection, signal)
    expect(captured.specs).toHaveLength(1)
    expect(captured.sandboxSwitches).toEqual([{
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ['/workspace'] },
    }])

    // Full access changes both the sandbox block and the native mode.
    captured.sandboxSwitches.length = 0
    captured.modes.length = 0
    policy.sandbox = 'danger-full-access'
    await driver.prepare(selection, signal)
    expect(captured.specs).toHaveLength(1)
    // An undefined block is the engine-level "no flag-layer sandbox" request;
    // the adapter translates it into the disabled native block.
    expect(captured.sandboxSwitches).toEqual([undefined])
    expect(captured.modes).toEqual(['bypassPermissions'])

    // A refused control request rebuilds so the policy still takes effect.
    captured.sandboxFailure = 'Cannot switch this mode live'
    policy.sandbox = 'workspace-write'
    policy.approval = 'ask'
    await driver.prepare(selection, signal)
    expect(captured.specs).toHaveLength(2)
    expect(captured.specs[1]).toMatchObject({ permissionMode: 'acceptEdits', bypassAllowed: false })

    // Plan mode owns the native mode, so a policy change keeps the restart path.
    captured.sandboxFailure = undefined
    await driver.executeCommand('plan', '', signal)
    policy.approval = 'never'
    await driver.prepare(selection, signal)
    expect(captured.specs).toHaveLength(3)
    expect(captured.specs[2]).toMatchObject({ permissionMode: 'plan' })
    await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
