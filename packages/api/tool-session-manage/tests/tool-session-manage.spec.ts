import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as ToolSessionManage from '@deepseek-ai/dsh-tool-session-manage'

const activeContexts: Context[] = []

interface FakeWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: string[]
}

interface FakeSummary {
  readonly sessionId: string
  readonly blank: boolean
  readonly cwd?: string
}

class FakeRegistry {
  archived: string[] = []
  workspaces: FakeWorkspace[] = []

  list() {
    return this.workspaces.map(workspace => ({
      id: WorkspaceId(workspace.id),
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds.map(id => SessionId(id)),
    }))
  }

  get(id: string) {
    return this.list().find(workspace => workspace.id === id)
  }

  get archivedSessionIds(): string[] {
    return this.archived.map(id => SessionId(id))
  }
}

class FakeController {
  summaries: FakeSummary[] = []
  adoptFailure: RemoteError | undefined
  createFailure: unknown
  createCalls: object[] = []
  selectModelCalls: object[] = []
  renameCalls: object[] = []

  async list(_request: object, _signal: AbortSignal): Promise<object> {
    return {
      items: this.summaries.map(summary => ({
        agentAvailable: false,
        sessionId: SessionId(summary.sessionId),
        updatedAt: 1,
        running: false,
        blank: summary.blank,
        ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
      })),
    }
  }

  engineCatalog(): object {
    return {
      engines: [
        { id: 'native', name: 'Native', description: 'The built-in loop' },
        { id: 'codex', name: 'Codex' },
      ],
    }
  }

  async modelCatalog(engineId?: string): Promise<object> {
    if (engineId === 'missing') {
      throw new RemoteError('engine/not-found', `engine "${engineId}" not found`, { engineId })
    }
    return {
      default: { provider: 'pi-ai', model: 'glm-5' },
      groups: [
        {
          id: 'pi-ai',
          name: 'PI AI',
          models: [
            { id: 'glm-5', name: 'GLM 5', description: 'Frontier model' },
            { id: 'glm-5-air', name: 'GLM 5 Air' },
          ],
        },
      ],
    }
  }

  async create(request: {
    readonly workspaceId?: string
    readonly cwd?: string
    readonly sessionId?: string
    readonly engineId?: string
  }): Promise<object> {
    this.createCalls.push({ ...request })
    if (this.createFailure !== undefined) throw this.createFailure
    if (request.sessionId !== undefined && this.adoptFailure !== undefined) throw this.adoptFailure
    return {
      sessionId: SessionId(request.sessionId ?? 'session-new'),
      ...request.engineId === undefined ? {} : { engineId: request.engineId },
    }
  }

  async selectModel(request: { readonly sessionId: string; readonly provider: string; readonly model: string }): Promise<object> {
    this.selectModelCalls.push({ ...request })
    if (request.model === 'unroutable') {
      throw new RemoteError(
        'session/model-unavailable',
        `provider "${request.provider}" has no endpoint serving this session's engine`,
        { provider: request.provider, model: request.model },
      )
    }
    return { selected: { provider: request.provider, model: request.model } }
  }

  async rename(request: { readonly sessionId: string; readonly title: string }): Promise<object> {
    this.renameCalls.push({ ...request })
    if (request.title === 'untitled') {
      throw new RemoteError('session/title-invalid', 'session title is invalid', { sessionId: SessionId(request.sessionId) })
    }
    return { title: request.title, seq: 3 }
  }
}

const registry = new FakeRegistry()
const controller = new FakeController()

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  registry.archived = []
  registry.workspaces = []
  controller.summaries = []
  controller.adoptFailure = undefined
  controller.createFailure = undefined
  controller.createCalls = []
  controller.selectModelCalls = []
  controller.renameCalls = []
})

async function mount(): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sessionController', controller as never)
  ctx.provide('workspaceRegistry', registry as never)
  const fiber = await ctx.plugin(ToolSessionManage)
  return { ctx, fiber }
}

let calls = 0

function call(ctx: Context, name: string, args: object): Promise<ToolExecutionResult> {
  calls += 1
  return ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(`call-${calls}`),
    signal: new AbortController().signal,
  })
}

function valueText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function errorCode(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

function alphaWorkspace(): void {
  registry.workspaces = [{ id: 'ws-alpha', path: '/work/alpha', title: 'alpha', sessionIds: ['session-blank'] }]
}

describe('tool-session-manage registration', () => {
  it('registers the four tools and the shared prompt section', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['list_projects', 'list_engines', 'list_models', 'session_create']),
    )
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(entry => entry.name === 'tool:session-manage')
    expect(section?.text).toContain('session_create')
  })

  it('marks the catalog tools concurrency-safe and the create tool not', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('list_projects')?.isConcurrencySafe?.({})).toBe(true)
    expect(ctx.tools.get('list_engines')?.isConcurrencySafe?.({})).toBe(true)
    expect(ctx.tools.get('list_models')?.isConcurrencySafe?.({ engine_id: 'codex' })).toBe(true)
    expect(ctx.tools.get('session_create')?.isConcurrencySafe?.({ workspace_id: 'ws-alpha' })).toBeUndefined()
  })

  it('unregisters every tool and the prompt section on disposal', async () => {
    const { ctx, fiber } = await mount()
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('session_create')
    expect((await ctx.systemPrompt.assemble()).sections.find(entry => entry.name === 'tool:session-manage')).toBeUndefined()
  })

  it('presents generic pending-call cards', async () => {
    const { ctx } = await mount()
    expect(ctx.tools.get('list_projects')?.presentCall?.({})).toEqual({ card: 'generic', kind: 'read', title: 'List projects' })
    expect(ctx.tools.get('list_engines')?.presentCall?.({})).toEqual({ card: 'generic', kind: 'read', title: 'List engines' })
    expect(ctx.tools.get('list_models')?.presentCall?.({ engine_id: 'codex' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'List codex models',
    })
    expect(ctx.tools.get('list_models')?.presentCall?.({})).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'List models',
    })
    expect(ctx.tools.get('session_create')?.presentCall?.({ workspace_id: 'ws-alpha', engine_id: 'codex', model: 'glm-5' })).toEqual({
      card: 'generic',
      kind: 'other',
      title: 'Create session',
      rawInput: 'ws-alpha (codex · glm-5)',
    })
    expect(ctx.tools.get('session_create')?.presentCall?.({ workspace_id: 'ws-alpha' })).toEqual({
      card: 'generic',
      kind: 'other',
      title: 'Create session',
      rawInput: 'ws-alpha',
    })
    expect(ctx.tools.get('session_create')?.presentCall?.({ cwd: '/tmp/project', engine_id: 'native' })).toEqual({
      card: 'generic',
      kind: 'other',
      title: 'Create session',
      rawInput: '/tmp/project (native)',
    })
    expect(ctx.tools.get('session_create')?.presentCall?.({})).toEqual({
      card: 'generic',
      kind: 'other',
      title: 'Create session',
      rawInput: '',
    })
  })
})

describe('list_projects', () => {
  it('returns every workspace trimmed to model-actionable fields', async () => {
    alphaWorkspace()
    registry.workspaces.push({ id: 'ws-beta', path: '/work/beta', title: 'beta', sessionIds: [] })
    const { ctx } = await mount()
    const result = await call(ctx, 'list_projects', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      projects: [
        { workspaceId: 'ws-alpha', path: '/work/alpha', title: 'alpha', sessionCount: 1 },
        { workspaceId: 'ws-beta', path: '/work/beta', title: 'beta', sessionCount: 0 },
      ],
    })
  })
})

describe('list_engines', () => {
  it('returns engines with optional descriptions omitted', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'list_engines', {})
    expect(result.value).toEqual({
      engines: [
        { id: 'native', name: 'Native', description: 'The built-in loop' },
        { id: 'codex', name: 'Codex' },
      ],
    })
  })
})

describe('list_models', () => {
  it('returns the default selection and trimmed provider groups', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'list_models', {})
    expect(result.value).toEqual({
      default: { provider: 'pi-ai', model: 'glm-5' },
      groups: [{
        provider: 'pi-ai',
        name: 'PI AI',
        models: [
          { id: 'glm-5', name: 'GLM 5', description: 'Frontier model' },
          { id: 'glm-5-air', name: 'GLM 5 Air' },
        ],
      }],
    })
  })

  it('passes the engine filter through', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'list_models', { engine_id: 'codex' })
    expect(result.isError).toBe(false)
  })

  it('rejects an empty engine id', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'list_models', { engine_id: ' ' })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('SESSION_MANAGE_INVALID_ARGS')
    expect(valueText(result)).toContain('engine_id')
  })

  it('maps an unknown engine to recovery guidance', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'list_models', { engine_id: 'missing' })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('SESSION_MANAGE_ENGINE_NOT_FOUND')
    expect(valueText(result)).toContain('list_engines')
  })
})

describe('session_create', () => {
  it('creates a fresh session with engine, model, and title', async () => {
    alphaWorkspace()
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', {
      workspace_id: 'ws-alpha',
      engine_id: 'codex',
      provider: 'pi-ai',
      model: 'glm-5',
      title: 'GLM work',
    })
    expect(result.value).toEqual({
      sessionId: 'session-new',
      workspaceId: 'ws-alpha',
      engineId: 'codex',
      model: { provider: 'pi-ai', model: 'glm-5' },
      title: 'GLM work',
      reused: false,
    })
    expect(controller.createCalls).toEqual([{ workspaceId: 'ws-alpha', engineId: 'codex' }])
    expect(controller.selectModelCalls).toEqual([{ sessionId: 'session-new', provider: 'pi-ai', model: 'glm-5' }])
    expect(controller.renameCalls).toEqual([{ sessionId: 'session-new', title: 'GLM work' }])
    expect(result.meta).toEqual(result.value)
  })

  it('creates by absolute cwd outside registered projects', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { cwd: '/tmp/project' })
    expect(result.value).toEqual({ sessionId: 'session-new', reused: false })
    expect(controller.createCalls).toEqual([{ cwd: '/tmp/project' }])
  })

  it('reuses a blank session attached to the target workspace', async () => {
    alphaWorkspace()
    controller.summaries = [{ sessionId: 'session-blank', blank: true, cwd: '/work/alpha' }]
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(result.value).toEqual({ sessionId: 'session-blank', workspaceId: 'ws-alpha', reused: true })
    expect(controller.createCalls).toEqual([{ sessionId: 'session-blank', workspaceId: 'ws-alpha' }])
  })

  it('skips reuse for archived or cwd-mismatched blanks', async () => {
    alphaWorkspace()
    registry.archived = ['session-blank']
    controller.summaries = [
      { sessionId: 'session-blank', blank: true, cwd: '/work/alpha' },
      { sessionId: 'session-elsewhere', blank: true, cwd: '/work/other' },
    ]
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(result.value).toEqual({ sessionId: 'session-new', workspaceId: 'ws-alpha', reused: false })
  })

  it('falls back to a fresh create when adoption is rejected', async () => {
    alphaWorkspace()
    controller.summaries = [{ sessionId: 'session-blank', blank: true, cwd: '/work/alpha' }]
    controller.adoptFailure = new RemoteError('session/writer-held', 'writer held', {
      sessionId: SessionId('session-blank'),
    })
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha', engine_id: 'native' })
    expect(result.value).toEqual({
      sessionId: 'session-new',
      workspaceId: 'ws-alpha',
      engineId: 'native',
      reused: false,
    })
    expect(controller.createCalls).toEqual([
      { sessionId: 'session-blank', workspaceId: 'ws-alpha', engineId: 'native' },
      { workspaceId: 'ws-alpha', engineId: 'native' },
    ])
  })

  it('propagates a non-recoverable adoption failure', async () => {
    alphaWorkspace()
    controller.summaries = [{ sessionId: 'session-blank', blank: true, cwd: '/work/alpha' }]
    controller.adoptFailure = new RemoteError('session/provider-models-unavailable', 'listing failed', {
      provider: 'pi-ai',
    })
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('SESSION_MANAGE_TOOL_FAILED')
    expect(controller.createCalls).toHaveLength(1)
  })

  it('rejects location pairing errors before any service call', async () => {
    const { ctx } = await mount()
    const both = await call(ctx, 'session_create', { workspace_id: 'ws-alpha', cwd: '/tmp' })
    expect(errorCode(both)).toBe('SESSION_MANAGE_INVALID_ARGS')
    const neither = await call(ctx, 'session_create', {})
    expect(errorCode(neither)).toBe('SESSION_MANAGE_INVALID_ARGS')
    const relative = await call(ctx, 'session_create', { cwd: 'relative/path' })
    expect(errorCode(relative)).toBe('SESSION_MANAGE_INVALID_ARGS')
    expect(controller.createCalls).toEqual([])
  })

  it('rejects provider without model and empty-string fields', async () => {
    alphaWorkspace()
    const { ctx } = await mount()
    const unpaired = await call(ctx, 'session_create', { workspace_id: 'ws-alpha', provider: 'pi-ai' })
    expect(errorCode(unpaired)).toBe('SESSION_MANAGE_INVALID_ARGS')
    const emptyTitle = await call(ctx, 'session_create', { workspace_id: 'ws-alpha', title: ' ' })
    expect(errorCode(emptyTitle)).toBe('SESSION_MANAGE_INVALID_ARGS')
    expect(controller.createCalls).toEqual([])
  })

  it('maps an unregistered workspace to list_projects guidance', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-missing' })
    expect(errorCode(result)).toBe('SESSION_MANAGE_PROJECT_NOT_FOUND')
    expect(valueText(result)).toContain('list_projects')
  })

  it('maps an unavailable model to list_models guidance', async () => {
    alphaWorkspace()
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', {
      workspace_id: 'ws-alpha',
      provider: 'pi-ai',
      model: 'unroutable',
    })
    expect(errorCode(result)).toBe('SESSION_MANAGE_MODEL_UNAVAILABLE')
    expect(valueText(result)).toContain('list_models')
  })

  it('maps an invalid title', async () => {
    alphaWorkspace()
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha', title: 'untitled' })
    expect(errorCode(result)).toBe('SESSION_MANAGE_TITLE_INVALID')
  })

  it('maps each recoverable host failure code', async () => {
    alphaWorkspace()
    const cases: Array<{ readonly failure: RemoteError; readonly code: string }> = [
      {
        failure: new RemoteError('workspace/not-found', 'workspace "x" not found', { workspaceId: WorkspaceId('x') }),
        code: 'SESSION_MANAGE_PROJECT_NOT_FOUND',
      },
      {
        failure: new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('session-new') }),
        code: 'SESSION_MANAGE_CREATE_FAILED',
      },
      {
        failure: new RemoteError('session/engine-conflict', 'engine conflict', {
          sessionId: SessionId('session-new'),
          requestedEngine: 'codex',
        }),
        code: 'SESSION_MANAGE_CREATE_FAILED',
      },
      {
        failure: new RemoteError('session/conflict', 'cwd conflict', {
          sessionId: SessionId('session-new'),
          requestedCwd: '/work/alpha',
        }),
        code: 'SESSION_MANAGE_CREATE_FAILED',
      },
      {
        failure: new RemoteError('session/workspace-attach-failed', 'attach failed', {
          sessionId: SessionId('session-new'),
          workspaceId: 'ws-alpha',
        }),
        code: 'SESSION_MANAGE_CREATE_FAILED',
      },
      {
        failure: new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {}),
        code: 'SESSION_MANAGE_INVALID_ARGS',
      },
    ]
    for (const { failure, code } of cases) {
      controller.createFailure = failure
      const { ctx } = await mount()
      const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
      expect(errorCode(result)).toBe(code)
    }
  })

  it('contains an error chain with a non-Error cause and a stack-less Error', async () => {
    alphaWorkspace()
    controller.createFailure = new Error('boom', { cause: 'root cause' })
    const { ctx: ctx1 } = await mount()
    expect(errorCode(await call(ctx1, 'session_create', { workspace_id: 'ws-alpha' }))).toBe('SESSION_MANAGE_TOOL_FAILED')
    const bare = Object.create(Error.prototype) as Error
    controller.createFailure = bare
    const { ctx: ctx2 } = await mount()
    expect(errorCode(await call(ctx2, 'session_create', { workspace_id: 'ws-alpha' }))).toBe('SESSION_MANAGE_TOOL_FAILED')
  })

  it('collapses unknown service failures to the generic code', async () => {
    alphaWorkspace()
    controller.createFailure = new Error('boom')
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(errorCode(result)).toBe('SESSION_MANAGE_TOOL_FAILED')
    expect(valueText(result)).not.toContain('boom')
  })

  it('contains a non-Error service rejection and logger diagnostics failures', async () => {
    alphaWorkspace()
    controller.createFailure = 'plain string failure'
    const { ctx } = await mount()
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {
      throw new Error('logger broken')
    })
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(errorCode(result)).toBe('SESSION_MANAGE_TOOL_FAILED')
    expect(warned).toHaveBeenCalled()
  })

  it('contains a hostile non-Error rejection whose rendering throws', async () => {
    alphaWorkspace()
    controller.createFailure = {
      toString(): string {
        throw new Error('hostile toString')
      },
    }
    const { ctx } = await mount()
    const result = await call(ctx, 'session_create', { workspace_id: 'ws-alpha' })
    expect(errorCode(result)).toBe('SESSION_MANAGE_TOOL_FAILED')
  })

  it('honours cancellation before dispatch', async () => {
    alphaWorkspace()
    const { ctx } = await mount()
    const controller2 = new AbortController()
    controller2.abort()
    calls += 1
    const result = await ctx.tools.execute({
      name: 'session_create',
      arguments: { workspace_id: 'ws-alpha' },
      callId: ToolCallId(`call-${calls}`),
      signal: controller2.signal,
    })
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('ABORTED_BEFORE_DISPATCH')
    expect(controller.createCalls).toEqual([])
  })
})
