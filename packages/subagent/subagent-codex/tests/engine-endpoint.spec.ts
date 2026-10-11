import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, AgentEngineId, installModelSelection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { TeamToolBridge } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { CodexMainAdapterSpec } from '../src/main-adapter.ts'
import type { CodexSharedAppServer, CodexSharedServerSpec } from '../src/shared-server.ts'
import { CodexEngineSharedHost } from '../src/shared-host.ts'
import { CodexMainFactory, registerCodexEngine } from '../src/engine.ts'

const captured = vi.hoisted(() => ({
  specs: [] as CodexMainAdapterSpec[],
  adaptersLifecycle: [] as string[],
  serverSpecs: [] as CodexSharedServerSpec[],
  attaches: [] as Array<{ cwd: string; options: Record<string, unknown> }>,
  sharedLifecycle: [] as string[],
  window: undefined as number | undefined,
  modes: [] as string[], modesSet: [] as string[],
}))

vi.mock('../src/main-adapter.ts', async (original) => {
  const actual = await original<typeof import('../src/main-adapter.ts')>()
  return {
    ...actual,
    CodexMainAdapter: class {
      constructor(private readonly spec: CodexMainAdapterSpec) { captured.specs.push(spec) }
      async start(): Promise<void> {
        const nativeId = this.spec.wireOptions?.resumeThreadId ?? `12345678-1234-4234-8234-${String(captured.specs.length).padStart(12, '0')}`
        captured.adaptersLifecycle.push(`start:${this.spec.model}`)
        const dir = join(this.spec.env.CODEX_HOME!, 'sessions', '2026', '10', '01')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, `rollout-2026-10-01-${nativeId}.jsonl`),
          `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: this.spec.cwd } })}\n`)
        this.spec.onThreadId?.(nativeId)
      }
      async close(): Promise<void> {
        captured.adaptersLifecycle.push(`close:${this.spec.model}`)
      }
      isReady(): boolean { return true }
      contextWindow(): number | undefined { return captured.window }
      async listSkills(): Promise<readonly unknown[]> { return [] }
      async listCollaborationModes(): Promise<readonly string[]> { return captured.modes }
      setCollaborationMode(mode: string): void { captured.modesSet.push(`adapter:${mode}`) }
    },
  }
})

vi.mock('@deepseek-ai/dsh-subagent-in-process-driver', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-subagent-in-process-driver')>()
  return { ...actual, startTeamToolBridge: async () => bridge.current }
})

const bridge = vi.hoisted(() => ({ current: undefined as TeamToolBridge | undefined }))

/** Scripted shared server: threads materialize as rollout files for resume discovery. */
function scriptedServerFactory(): (spec: CodexSharedServerSpec, signal: AbortSignal) => Promise<CodexSharedAppServer> {
  class FakeWire {
    readonly threadId: string
    private failure: Error | undefined
    constructor(
      private readonly server: { spec: CodexSharedServerSpec },
      options: Record<string, unknown>,
      private readonly cwd: string,
    ) {
      const resume = options.resumeThreadId
      this.threadId = typeof resume === 'string' ? resume
        : `12345678-1234-4234-8234-${String(captured.attaches.length).padStart(12, '0')}`
    }
    async startThread(): Promise<void> {
      const dir = join(this.server.spec.home, 'sessions', '2026', '10', '01')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `rollout-2026-10-01-${this.threadId}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id: this.threadId, cwd: this.cwd } })}\n`)
      captured.sharedLifecycle.push(`attach:${this.threadId}`)
    }
    fatalError(): Error | undefined { return this.failure }
    abort(error: unknown): void { this.failure = error instanceof Error ? error : new Error(String(error)) }
    capturedThreadId(): string { return this.threadId }
    ownsThread(threadId: string): boolean { return threadId === this.threadId }
    close(): void { captured.sharedLifecycle.push(`detach:${this.threadId}`) }
    async runTurn(): Promise<unknown[]> { return [] }
    interrupt(): void {}
    async listSkills(): Promise<readonly unknown[]> { return [] }
    async compact(): Promise<void> {}
    setCollaborationMode(mode: string): void { captured.modesSet.push(`wire:${mode}`) }
    contextWindow(): number | undefined { return captured.window }
  }
  return async (spec) => {
    captured.sharedLifecycle.push(`start:${spec.routes.map(route => route.nativeName).join('+')}`)
    captured.serverSpecs.push(spec)
    const server = {
      spec,
      get planSupported(): boolean { return captured.modes.includes('plan') },
      get catalog(): CodexSharedServerSpec['catalog'] { return spec.catalog },
      set catalog(value: CodexSharedServerSpec['catalog']) { spec.catalog = value },
      nativeProviderFor(providerId: string): string {
        const route = spec.routes.find(candidate => candidate.id === providerId)
        if (route === undefined) throw new Error(`provider "${providerId}" is not registered on the shared Codex app-server`)
        return route.nativeName
      },
      async attach(cwd: string, options: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> {
        const wire = new FakeWire(server, options, cwd)
        captured.attaches.push({ cwd, options })
        await wire.startThread()
        return wire
      },
      detach(): void {},
      get busy(): boolean { return false },
      get alive(): boolean { return true },
      noteTurnActive(): void {},
      noteTurnSettled(): void {},
      async close(): Promise<void> { captured.sharedLifecycle.push('close-server') },
    }
    return server as unknown as CodexSharedAppServer
  }
}

afterEach(() => {
  captured.specs.length = 0
  captured.serverSpecs.length = 0
  captured.attaches.length = 0
  captured.sharedLifecycle.length = 0
  captured.window = undefined
  captured.modes = []
  captured.modesSet.length = 0
  bridge.current = undefined
})

interface Harness {
  ctx: Context
  home: string
  dispose: () => Promise<void>
}

async function testHarness(policy: { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; approval: 'ask' | 'never' }
  = { sandbox: 'workspace-write', approval: 'ask' }): Promise<Harness> {
  const ctx = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-codex-shared-'))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('profileContext', { home } as never)
  ctx.provide('permissionPresets', { current: () => policy.sandbox === 'workspace-write' ? 'workspace-write' : policy.sandbox,
    effective: () => policy } as never)
  ctx.provide('subprocess', { spawn: () => { throw new Error('A real Codex process must not start in this test') } } as never)
  ctx.provide('credentials', { resolve: async (ref: string) => ({ value: ref === 'fallback' ? 'other-secret' : 'test-secret', source: 'test' }) } as never)
  return {
    ctx,
    home,
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

function mockRoutes(ctx: Context, providers: Array<{ id: string; baseUrl: string; models: string[] }>): void {
  vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => providers.map(provider => ({
    id: provider.id, name: provider.id, endpoints: [{
      id: 'openai-compatible', name: 'Codex', baseUrl: provider.baseUrl, credentialRef: provider.id.replaceAll('.', '_'),
    }],
  })))
  vi.spyOn(ctx.llm, 'listModels').mockImplementation(async provider =>
    (providers.find(entry => entry.id === provider)?.models ?? []).map(id => ({ provider, id, name: id })))
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, id) => ({ provider, id, name: id }))
}

it('serves every session from one shared child and switches routes per thread without restarts', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [
    { id: 'fallback', baseUrl: 'https://example.test/fallback?label="quoted"', models: ['other-model'] },
    { id: 'team.gateway', baseUrl: 'https://example.test/team?label="quoted"', models: ['selected-model', 'next-model'] },
  ])
  const engineConfig = { providers: {
    'team.gateway': { reasoningEfforts: { off: null, max: 'xhigh' }, defaultReasoningEffort: 'max', requestMaxRetries: 1 },
    fallback: { streamMaxRetries: 3, modelContextWindow: 1000000 },
  } }
  registerCodexEngine(ctx, engineConfig, new CodexEngineSharedHost(ctx, engineConfig, scriptedServerFactory()))
  try {
    const handle = await new CodexMainFactory(ctx, { provider: 'fallback', model: 'default' }).createAgent(ctx, {
      sessionId: SessionId('selected-codex'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'team.gateway', model: 'selected-model' },
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.serverSpecs).toHaveLength(1)
    const spec = captured.serverSpecs[0]
    // Deterministic route order: fallback takes dsh_engine, team.gateway dsh_engine_1.
    expect(spec?.routes).toEqual([
      { id: 'fallback', nativeName: 'dsh_engine' },
      { id: 'team.gateway', nativeName: 'dsh_engine_1' },
    ])
    expect(spec?.argv.join(' ')).toContain('model_providers.dsh_engine_1.request_max_retries=1')
    expect(spec?.argv.join(' ')).not.toContain('test-secret')
    expect(spec?.env).toMatchObject({ DSH_CODEX_API_KEY_1: 'test-secret' })
    const first = captured.attaches[0]
    expect(first?.options.thread).toMatchObject({ model: 'selected-model', modelProvider: 'dsh_engine_1' })
    expect(first?.options.turn).toMatchObject({ model: 'selected-model', effort: 'xhigh' })
    const recordedCatalog = handle.agent.session.snapshotEvents().find(event =>
      event.type === 'engine/item-settled' && (event.data as { category?: string }).category === 'model-catalog')
    expect(recordedCatalog?.data).toMatchObject({ category: 'model-catalog',
      payload: { engineId: 'codex', provider: 'team.gateway' } })
    expect(JSON.stringify(recordedCatalog?.data)).toContain('selected-model')
    expect(handle.agent.options).toEqual({ provider: 'team.gateway', model: 'selected-model' })

    // A second session attaches to the same shared child without spawning again.
    const independent = await ctx.agents.create({ sessionId: SessionId('independent-codex'),
      engineId: AgentEngineId('codex'), meta: { cwd: '/workspace' }, agentOptions: { provider: 'fallback', model: 'other-model' } })
    await independent.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.serverSpecs).toHaveLength(1)
    expect(captured.sharedLifecycle).toEqual(['start:dsh_engine+dsh_engine_1', 'attach:12345678-1234-4234-8234-000000000000',
      'attach:12345678-1234-4234-8234-000000000001'])
    expect(captured.attaches[1]?.options.thread).toMatchObject({ model: 'other-model', modelProvider: 'dsh_engine' })
    await independent.dispose()

    // A model switch stays on the thread: turn options update without reattachment.
    installModelSelection(handle.agent.ctx, { current: { provider: 'team.gateway', model: 'next-model' }, assembled: undefined })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.attaches).toHaveLength(2)
    expect(first?.options.turn).toMatchObject({ model: 'next-model', effort: 'xhigh' })

    // A provider switch reattaches the thread under the other registered route.
    installModelSelection(handle.agent.ctx, { current: { provider: 'fallback', model: 'other-model' }, assembled: undefined })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.serverSpecs).toHaveLength(1)
    expect(captured.attaches).toHaveLength(3)
    expect(captured.attaches[2]?.options.thread).toMatchObject({ model: 'other-model', modelProvider: 'dsh_engine' })
    expect(captured.attaches[2]?.options.resumeThreadId).toBe('12345678-1234-4234-8234-000000000000')
    expect(captured.attaches[2]?.options.resumeThreadPath).toBeDefined()
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('restarts the shared child when route configuration drifts and resumes the saved thread', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { provider: 'fallback', model: 'default' } as const
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  try {
    const handle = await new CodexMainFactory(ctx, config).createAgent(ctx, {
      sessionId: SessionId('codex-drift'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.sharedLifecycle).toEqual(['start:dsh_engine', 'attach:12345678-1234-4234-8234-000000000000'])
    vi.spyOn(ctx.llm, 'listProviders').mockImplementation(() => [{ id: 'fallback', name: 'fallback', endpoints: [{
      id: 'openai-compatible', name: 'Codex', baseUrl: 'https://new-endpoint.test/responses', credentialRef: 'fallback',
    }] }])
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.sharedLifecycle).toEqual(['start:dsh_engine', 'attach:12345678-1234-4234-8234-000000000000',
      'close-server', 'start:dsh_engine', 'detach:12345678-1234-4234-8234-000000000000',
      'attach:12345678-1234-4234-8234-000000000000'])
    expect(captured.serverSpecs[1]?.argv.join(' ')).toContain('base_url="https://new-endpoint.test/responses"')
    expect(captured.attaches[1]?.options.resumeThreadId).toBe('12345678-1234-4234-8234-000000000000')
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('reports catalog capacity until the native process reports its own', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { providers: { fallback: { modelContextWindow: 1000000 } } }
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  try {
    const handle = await new CodexMainFactory(ctx, {}).createAgent(ctx, {
      sessionId: SessionId('codex-window'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('codex'))?.driver?.(handle.agent)
    if (driver === undefined) throw new Error('codex engine has no execution driver')

    expect(driver.contextWindow?.()).toBeUndefined()
    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, new AbortController().signal)
    expect(driver.contextWindow?.()).toBe(1000000)
    captured.window = 128000
    expect(driver.contextWindow?.()).toBe(128000)
    await driver.close()
    expect(driver.contextWindow?.()).toBe(1000000)
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('registers /plan from shared collaboration modes, records switches and replays them across reattachment', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { provider: 'fallback', model: 'default' } as const
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  captured.modes = ['plan', 'default']
  const signal = new AbortController().signal
  try {
    const handle = await new CodexMainFactory(ctx, config).createAgent(ctx, {
      sessionId: SessionId('codex-plan'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('codex'))?.driver?.(handle.agent)
    if (driver === undefined) throw new Error('codex engine has no execution driver')
    if (driver.commands === undefined || driver.executeCommand === undefined) {
      throw new Error('codex engine has no command surface')
    }

    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    const commands = await driver.commands()
    expect(commands.find(command => command.name === 'plan')).toEqual({
      name: 'plan', description: 'Toggle the native plan collaboration mode', argumentHint: '[off]', execution: 'action',
    })

    await driver.executeCommand('plan', '', signal)
    expect(captured.modesSet).toEqual(['wire:plan'])
    const record = handle.agent.session.snapshotEvents().find(event =>
      event.type === 'engine/item-settled' && (event.data as { category?: string }).category === 'mode')
    expect(record?.data).toMatchObject({ category: 'mode', payload: { engineId: 'codex', plan: true } })

    captured.modesSet.length = 0
    await driver.close()
    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    expect(captured.modesSet).toEqual(['wire:plan'])

    await driver.executeCommand('plan', 'off', signal)
    expect(captured.modesSet).toEqual(['wire:plan', 'wire:default'])
    const exitRecord = handle.agent.session.snapshotEvents().filter(event =>
      event.type === 'engine/item-settled' && (event.data as { category?: string }).category === 'mode').at(-1)
    expect(exitRecord?.data).toMatchObject({ payload: { engineId: 'codex', plan: false } })
    await driver.close()
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('omits /plan and reports a clear reason when collaboration modes are unsupported', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { provider: 'fallback', model: 'default' } as const
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  const signal = new AbortController().signal
  try {
    const handle = await new CodexMainFactory(ctx, config).createAgent(ctx, {
      sessionId: SessionId('codex-plan-unsupported'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    const driver = ctx.agents.getEngine(AgentEngineId('codex'))?.driver?.(handle.agent)
    if (driver === undefined) throw new Error('codex engine has no execution driver')
    if (driver.commands === undefined || driver.executeCommand === undefined) {
      throw new Error('codex engine has no command surface')
    }

    await driver.prepare({ provider: 'fallback', model: 'selected-model' }, signal)
    expect(await driver.commands()).not.toContainEqual(expect.objectContaining({ name: 'plan' }))
    await expect(driver.executeCommand('plan', '', signal))
      .rejects.toThrow(/does not support collaboration modes/)
    await driver.close()
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('maps each permission level onto thread settings and resumes across a permission switch', async () => {
  const policy = { sandbox: 'workspace-write' as 'read-only' | 'workspace-write' | 'danger-full-access',
    approval: 'ask' as 'ask' | 'never' }
  const { ctx, home, dispose } = await testHarness(policy)
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { provider: 'fallback', model: 'default' } as const
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  try {
    const handle = await new CodexMainFactory(ctx, config).createAgent(ctx, {
      sessionId: SessionId('codex-permissions'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    const codexHome = captured.serverSpecs[0]?.home as string
    expect(codexHome).toBe(join(home, 'engines', 'codex', 'shared-home'))
    // The session permission preset is the only permission source: no host
    // config or rules are mirrored into the shared home.
    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(codexHome, 'rules', 'deny.rules'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(captured.attaches[0]?.options.thread).toMatchObject({
      model: 'selected-model', modelProvider: 'dsh_engine', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    })
    expect(captured.attaches[0]?.options.resumeThreadId).toBeUndefined()

    // A /permission switch to full access reattaches the saved thread under
    // the new native permission values without a process boundary.
    handle.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Delivered native input' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    policy.sandbox = 'danger-full-access'
    policy.approval = 'never'
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.attaches).toHaveLength(2)
    expect(captured.attaches[1]?.options.thread).toEqual({
      model: 'selected-model', modelProvider: 'dsh_engine',
      sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user',
    })
    expect(captured.attaches[1]?.options.resumeThreadId).toBe('12345678-1234-4234-8234-000000000000')
    await handle.dispose()
  } finally {
    await dispose()
  }
})

it('keeps a dedicated per-session child for team sessions', async () => {
  const { ctx, dispose } = await testHarness()
  mockRoutes(ctx, [{ id: 'fallback', baseUrl: 'https://example.test/fallback', models: ['selected-model'] }])
  const config = { provider: 'fallback', model: 'default' } as const
  registerCodexEngine(ctx, config, new CodexEngineSharedHost(ctx, config, scriptedServerFactory()))
  bridge.current = {
    url: 'http://127.0.0.1:9/mcp', authorization: 'Bearer team-secret',
    beginTurn: () => async () => {}, close: async () => {},
  }
  try {
    const handle = await new CodexMainFactory(ctx, config).createAgent(ctx, {
      sessionId: SessionId('codex-team'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'fallback', model: 'selected-model' },
    })
    await handle.agent.prepareExecution?.(new AbortController().signal)
    expect(captured.serverSpecs).toHaveLength(1)
    expect(captured.specs).toHaveLength(1)
    const spec = captured.specs[0]
    // Team sessions keep the per-session native home layout.
    expect(spec?.env.CODEX_HOME).toContain(join('engines', 'codex', 'session-homes'))
    expect(spec?.argv).toContain('mcp_servers.dsh_team.url="http://127.0.0.1:9/mcp"')
    await handle.dispose()
  } finally {
    await dispose()
  }
})
