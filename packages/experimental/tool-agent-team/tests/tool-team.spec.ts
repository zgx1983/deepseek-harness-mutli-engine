import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentEngineId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

function serializeRequest(request: GenerateOptions) {
  const connection = resolveAdapterOptions({ models: [{ id: request.model, systemPromptUpdate: 'in-history' }] })
  return serialize(request, connection, request.messages, new Map(), () => undefined)
}

const SIGNAL = new AbortController().signal
const TOOL_NAMES = [
  'list_teammate_models',
  'spawn_teammate',
  'send_message',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'team_workflow_create',
  'dispatch_task',
].sort()

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], legacyControl = false) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  if (legacyControl) await ctx.plugin(ToolSubagentControl)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, fiber, adapter }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function spawnedChildId(ctx: Context, lead: Agent, result: Awaited<ReturnType<typeof execute>>): SessionId {
  const parsed = JSON.parse(text(result)) as { member: { target: string } }
  const member = ctx.agentTeams.listMembers(lead).find(member => member.name === parsed.member.target)
  if (member === undefined) throw new Error('spawn_teammate target has no roster member')
  return member.id
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

/**
 * Wait until one roster member stops running. An interrupted steer delivery can
 * park the continuable child with a pending inbox item, so the live Agent may
 * outlive the turn; roster status is the observable cleanup contract.
 */
async function waitMemberInactive(ctx: Context, lead: Agent, name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agentTeams.listMembers(lead).find(member => member.name === name)?.status).toBe('inactive')
  }, { timeout: 5_000 })
}

describe('dsh-tool-team', () => {
  it('exposes canonical routes for model selection without matching user aliases locally', async () => {
    const { ctx, lead } = await setup([])
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'ark', name: 'Volcengine', endpoints: [{ id: 'anthropic', name: 'Anthropic', baseUrl: 'https://example.invalid' }] }])
    vi.spyOn(ctx.llm, 'listModels').mockResolvedValue([{ provider: 'ark', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }])
    const capabilities = ctx.agents.listEngines()[0]!.capabilities
    vi.spyOn(ctx.agents, 'listEngines').mockReturnValue([
      { id: AgentEngineId('native'), name: 'Native', capabilities, endpoints: [] },
      { id: AgentEngineId('claude'), name: 'Claude Code', capabilities, endpoints: ['anthropic'] },
      { id: AgentEngineId('codex'), name: 'Codex', capabilities, endpoints: ['responses'] },
    ])
    expect(JSON.parse(text(await execute(ctx, lead, 'list_teammate_models', {})))).toMatchInlineSnapshot(`
      [
        {
          "engines": [
            {
              "id": "native",
              "name": "Native",
            },
            {
              "id": "claude",
              "name": "Claude Code",
              "requires": [
                "anthropic",
              ],
            },
          ],
          "models": [
            {
              "id": "claude-opus-4-6",
              "name": "Claude Opus 4.6",
            },
          ],
          "name": "Volcengine",
          "provider": "ark",
        },
      ]
    `)
    expect(text(await execute(ctx, lead, 'list_teammate_models', { engine: 'codex' }))).toBe('[]')
    expect(text(await execute(ctx, lead, 'list_teammate_models', { provider: 'volc' }))).toContain('Unknown provider')

    // Configuration-diagnostic entries are unusable routes and leave the catalog.
    const directory = vi.spyOn(ctx.llm, 'listConfigurableProviders').mockReturnValue([
      { provider: 'ark', displayName: 'Volcengine', settingsNs: 'llm-ark', settingsPath: [], error: 'missing api key' },
    ])
    expect(text(await execute(ctx, lead, 'list_teammate_models', {}))).toBe('[]')
    directory.mockRestore()
  })

  it('omits undiscoverable providers from the catalog and fails loud when one is named', async () => {
    const { ctx, lead } = await setup([])
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([
      { id: 'broken', name: 'Broken' }, { id: 'ark', name: 'Volcengine' },
    ])
    vi.spyOn(ctx.llm, 'listModels').mockImplementation(async (provider: string) => {
      if (provider === 'broken') throw new Error('missing credentials')
      return [{ provider, id: 'm1', name: 'Model 1' }]
    })
    expect(text(await execute(ctx, lead, 'list_teammate_models', {}))).toBe(JSON.stringify([{
      provider: 'ark', name: 'Volcengine',
      engines: [{ id: 'native', name: 'Native' }],
      models: [{ id: 'm1', name: 'Model 1' }],
    }]))
    const named = await execute(ctx, lead, 'list_teammate_models', { provider: 'broken' })
    expect(named.isError).toBe(true)
    expect(named.error?.message).toContain('not currently usable')
  })

  it('logs discovery before passing the model-selected canonical route to the engine', async () => {
    const route = { name: 'reviewer', description: 'review', prompt: 'Review', engine: 'claude', provider: 'ark', model: 'claude-opus-4-6' }
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('discover', 'list_teammate_models', {}),
      toolCallResponse('spawn', 'spawn_teammate', route),
      textResponse('Started reviewer'),
    ])
    vi.spyOn(ctx.llm, 'listProviders').mockReturnValue([{ id: 'ark', name: 'Volcengine' }])
    vi.spyOn(ctx.llm, 'listModels').mockResolvedValue([{ provider: 'ark', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }])
    const spawn = vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockResolvedValue({ member: {
      id: SessionId('chosen-reviewer'), name: 'reviewer', role: 'teammate', status: 'inactive', diagnostics: [],
    } })
    await runTurn(lead, 'Use Agent Team with Volc Opus to review')
    expect(spawn).toHaveBeenCalledWith(lead, expect.objectContaining({
      provider: 'engine:claude', agentOptions: { provider: 'ark', model: 'claude-opus-4-6' },
    }))
    const discovery = adapter.requests[1]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text' && block.text.includes('Claude Opus 4.6'))
    expect(discovery).toHaveLength(1)
    expect(discovery).toMatchInlineSnapshot(`
      [
        {
          "text": "[{"provider":"ark","name":"Volcengine","engines":[{"id":"native","name":"Native"}],"models":[{"id":"claude-opus-4-6","name":"Claude Opus 4.6"}]}]",
          "type": "text",
        },
      ]
    `)
    expect(JSON.stringify(lead.session.snapshotEvents())).toContain('Claude Opus 4.6')
    expect(renderPrompt(await assembly(ctx, lead))).toContain('You choose the exact provider, model, and engine')
  })

  it.each(['running', 'inactive', 'provisioning', 'failed'] as const)(
    'projects %s members consistently in creation, listing, and schemas', async (status) => {
      const { ctx, lead } = await setup([])
      const member = {
        id: SessionId('private-member-session'), name: 'reviewer', role: 'teammate' as const,
        status, description: 'review changes', diagnostics: [],
      }
      vi.spyOn(ctx.agentTeams, 'spawnTeammate').mockResolvedValue({ member })
      vi.spyOn(ctx.agentTeams, 'listMembers').mockReturnValue([member])
      const expected = {
        target: 'reviewer', role: 'teammate', status,
        description: 'review changes', diagnostics: [],
      }
      const spawned = await execute(ctx, lead, 'spawn_teammate', {
        name: 'reviewer', description: 'review changes', prompt: 'review',
      })
      const listed = await execute(ctx, lead, 'list_agents', {})
      expect(spawned.isError).toBe(false)
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(spawned))).toEqual({ member: expected })
      expect(JSON.parse(text(listed))).toEqual([expected])
      const scope = scopeOf(lead.ctx)
      const spawnSchema = ctx.tools.get('spawn_teammate', scope)?.output.schema.properties?.member
      const listSchema = ctx.tools.get('list_agents', scope)?.output.schema.items
      for (const schema of [spawnSchema, listSchema]) {
        expect(schema?.properties).toHaveProperty('target')
        expect(schema?.properties).not.toHaveProperty('id')
        expect(schema?.properties).not.toHaveProperty('name')
        expect(schema?.properties?.status?.enum).toEqual(['running', 'inactive', 'provisioning', 'failed'])
      }
      expect(ctx.agentTeams.listMembers(lead)).toEqual([member])
    },
  )

  it.each(['running', 'inactive'] as const)('returns interrupted %s status', async (previousStatus) => {
    const { ctx, lead } = await setup([])
    const interrupt = vi.spyOn(ctx.agentTeams, 'interrupt').mockReturnValue({ previousStatus })
    const result = await execute(ctx, lead, 'interrupt_agent', { target: 'reviewer' })
    expect(JSON.parse(text(result))).toEqual({ previousStatus })
    expect(interrupt).toHaveBeenCalledWith(lead, 'reviewer')
  })

  it('uses returned targets for messages, interruption, and task assignment', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review changes', prompt: 'wait for work',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    expect(member).not.toHaveProperty('id')
    expect(member).not.toHaveProperty('name')
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string }>
    expect(listed.map(row => row.target)).toEqual(['lead', member.target])
    const created = await execute(ctx, lead, 'team_task_create', { subject: 'review', description: 'review changes' })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const assigned = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'reassign', owner: member.target,
    })
    expect(assigned.isError).toBe(false)
    expect(JSON.parse(text(assigned))).toMatchObject({ ownerName: member.target })
    const tasks = JSON.parse(text(await execute(ctx, lead, 'team_task_list', { owner: listed[1]!.target }))) as { tasks: Array<{ id: string; ownerName?: string }> }
    expect(tasks.tasks.find(row => row.id === task.id)).toMatchObject({ id: task.id, ownerName: member.target })
    const sent = await execute(ctx, lead, 'send_message', { target: member.target, message: 'review the diff' })
    expect(sent.isError).toBe(false)
    const interrupted = await execute(ctx, lead, 'interrupt_agent', { target: listed[1]!.target })
    expect(interrupted.isError).toBe(false)
    await child.whenIdle()
    expect(child.status).toBe('idle')
    expect(ctx.agentTeams.interrupt(lead, member.target)).toEqual({ previousStatus: 'inactive' })
    const stored = await execute(ctx, lead, 'list_agents', {})
    expect(JSON.parse(text(stored))).toContainEqual(expect.objectContaining({ target: member.target, status: 'inactive' }))
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ id: childId, name: member.target, status: 'inactive' })
  })

  it('installs the complete scoped schema and shared-checkout policy for roots and teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(leadAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('create teammates only when the user explicitly asks')
    expect(leadPrompt).toContain('FS_STALE_VERSION')
    expect(leadPrompt).toContain('Bash, formatters, code generators, and scripts are not fully protected')
    expect(leadPrompt).toContain("loads that project's AGENTS.md/CLAUDE.md instructions")
    expect(leadPrompt).toContain('task readiness never starts an owner')
    expect(leadPrompt).toContain('returns noProgress immediately')
    expect(leadPrompt).not.toContain('Your Team role')
    expect(renderContextSnapshot(leadAssembly)).toBe('')

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'tool-worker',
      description: 'exercise scoped tools',
      prompt: 'stay available',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    expect(ctx.agentTeams.listTasks(lead)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'task-1', description: 'stay available' })]))
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)
    const childAssembly = await assembly(ctx, child)
    expect(childAssembly.tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect(renderPrompt(childAssembly)).toBe(leadPrompt)
    expect(renderContextSnapshot(childAssembly)).not.toContain('team:identity')
    expect(child.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text === '<system-reminder>\nYou are teammate "tool-worker".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n'))).toBe(true)
    const initialPrompt = child.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    expect(initialPrompt?.type === 'user/message'
      ? initialPrompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []).toEqual(['<system-reminder>\nYou are teammate "tool-worker".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n', 'Your shared task is task-1. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\nstay available'])

    const denied = await execute(ctx, child, 'spawn_teammate', {
      name: 'nested', description: 'not allowed', prompt: 'no',
    })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('only the Team Lead')
    await execute(ctx, lead, 'interrupt_agent', { target: 'tool-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it.each([
    ['fresh', undefined], ['fork', undefined], ['fork', 'in-history'],
  ] as const)('records %s teammate identity with update mode %s and keeps the wire prefix', async (mode, systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('child answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    await runTurn(lead, 'Parent task')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const parentHistory = structuredClone(lead.session.deriveMessages())
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work', context: mode,
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.system).toEqual(parentRequest.system)
    expect(childRequest.system).not.toContain('Your Team role')
    if (mode === 'fork') {
      expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
      expect(adapter.requests[1]!.messages.slice(0, parentHistory.length)).toEqual(parentHistory)
    } else {
      expect(JSON.stringify(childRequest.messages)).not.toContain('Parent task')
    }
    expect(childRequest.messages.at(-1)?.content.slice(0, 2)).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Your shared task is task-1. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\nReview the work' },
    ])
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    const initial = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(initial?.type === 'user/message' ? initial.data.content : []).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Your shared task is task-1. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\nReview the work' },
    ])
  })

  it('keeps an ordinary Lead fork free of identity reminders without replacing the inherited prefix', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('fork answer')])
    await runTurn(lead, 'Parent task')
    const seed = lead.session.snapshotEvents()
    const childId = SessionId('ordinary-team-fork')
    const handle = await ctx.agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: lead.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    await runTurn(handle.agent, 'Continue independently')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
    expect(JSON.stringify(childRequest.messages)).not.toContain('system-reminder')
    expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect(ctx.agentTeams.listMembers(handle.agent).map(member => member.name)).toEqual(['lead'])
    await handle.dispose()
  })

  it.each([undefined, 'in-history'] as const)('keeps a teammate fork prefix with update mode %s without a Lead correction', async (systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('review done'), textResponse('lead notified'), textResponse('fork answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const teammateId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, teammateId)
    await using persisted = await ctx.sessionPersistence.open(teammateId, 'read')
    const { events: seed } = await persisted.read()
    const handle = await ctx.agents.create({
      sessionId: SessionId('fork-from-teammate'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: teammateId, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    try {
      const inheritedHistory = structuredClone(handle.agent.session.deriveMessages())
      await runTurn(handle.agent, 'Continue independently')
      const original = serializeRequest(adapter.requests.find(request => request.sessionId === teammateId)!)
      const forkRequest = adapter.requests.find(request => request.sessionId === handle.agent.id)!
      const fork = serializeRequest(forkRequest)
      expect(fork.tools).toEqual(original.tools)
      expect(fork.messages.slice(0, original.messages.length)).toEqual(original.messages)
      expect(forkRequest.messages.slice(0, inheritedHistory.length)).toEqual(inheritedHistory)
      expect(fork.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
      expect(JSON.stringify(fork.messages)).not.toContain('You are the Team Lead')
      expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    } finally {
      await handle.dispose()
    }
  })

  it('leaves initial identity to ordinary history compaction without reinserting it', async () => {
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('first-list', 'list_agents', {}),
      toolCallResponse('second-list', 'list_agents', {}),
      textResponse('done'),
    ])
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step === 3) {
        const identity = agent.session.snapshotEvents().find(event => event.type === 'user/message'
          && event.data.source.kind === 'user')
        if (identity === undefined) throw new Error('expected initial teammate reminder')
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Compacted earlier context.' }],
          source: { kind: 'test-compaction' },
        }), {
          surfaceOp: { op: 'replace', startSeq: identity.seq, endSeq: identity.seq },
          sourceEventSeqs: [identity.seq],
        })
      }
      return next()
    })
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const reminder = '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n'
    const first = serializeRequest(adapter.requests[0]!).messages
    expect(first.at(-1)?.content.slice(0, 2)).toEqual([{ type: 'text', text: reminder }, { type: 'text', text: 'Your shared task is task-1. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\nReview the work' }])
    expect(adapter.requests[1]!.messages.filter(message => message.content.some(block =>
      block.type === 'text' && block.text === reminder))).toHaveLength(1)
    expect(JSON.stringify(serializeRequest(adapter.requests[2]!).messages)).not.toContain('You are teammate')
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && (event.data.source as { readonly kind?: unknown }).kind === toolTeam.name)).toHaveLength(0)
  })

  it.each(['reject', 'empty', 'abort'] as const)('does not revive a teammate step after %s', async (mode) => {
    const { ctx, lead, adapter } = await setup([])
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (agent === lead) return decision
      if (mode === 'reject') return { kind: 'reject' }
      if (mode === 'abort') agent.cancel({ kind: 'user' })
      return { kind: 'enter', messages: [] }
    })
    await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    const childId = SessionId(ctx.agentTeams.listMembers(lead).find(member => member.name === 'reviewer')!.id)
    await waitNoAgent(ctx, childId)
    expect(adapter.requests.filter(request => request.sessionId === childId)).toEqual([])
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toEqual([])
  })

  it('keeps teammate reminders when runtime context is suppressed', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('worker done')])
    ctx.systemPrompt.suppressRuntimeContext()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'reviewer', description: 'review', prompt: 'Review the work',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))
    expect(serializeRequest(adapter.requests[0]!).messages.at(-1)?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n' },
      { type: 'text', text: 'Your shared task is task-1. It is already assigned to you. Read it with team_task_get, perform the work, and complete it with team_task_update after meeting its acceptance criteria. Do not create a duplicate task for this assignment.\n\nReview the work' },
    ])
  })

  it('returns actionable no-progress output and renders structured wait cancellation', async () => {
    const inactiveSetup = await setup([textResponse('worker done')])
    const inactiveSpawn = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'spawn_teammate', {
      name: 'inactive-worker', description: 'finish immediately', prompt: 'finish',
    })
    const inactiveId = spawnedChildId(inactiveSetup.ctx, inactiveSetup.lead, inactiveSpawn)
    await waitNoAgent(inactiveSetup.ctx, inactiveId)
    const noProgress = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms: 3_600_000 })
    expect(noProgress.isError).toBe(false)
    expect(JSON.parse(text(noProgress))).toEqual({
      timedOut: false,
      noProgress: {
        reason: 'no-active-peer',
        message: 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.',
      },
    })
    for (const timeout_ms of [9_999, 3_600_001, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms })
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain('timeoutMs must be an integer from 10000 through 3600000')
    }

    const activeSetup = await setup(['hang'])
    const activeSpawn = await execute(activeSetup.ctx, activeSetup.lead, 'spawn_teammate', {
      name: 'active-worker', description: 'stay active', prompt: 'wait',
    })
    const activeId = spawnedChildId(activeSetup.ctx, activeSetup.lead, activeSpawn)
    await waitRunning(activeSetup.ctx, activeId)
    const controller = new AbortController()
    const waiting = execute(activeSetup.ctx, activeSetup.lead, 'wait_agent', { timeout_ms: 10_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort({ kind: 'user' })
    const aborted = await waiting
    expect(aborted.isError).toBe(true)
    expect(text(aborted)).toBe("Error: wait_agent aborted: { kind: 'user' }")
    await execute(activeSetup.ctx, activeSetup.lead, 'interrupt_agent', { target: 'active-worker' })
    await waitNoAgent(activeSetup.ctx, activeId)
  })

  it('adapts roster, mailbox, wait, and task CAS operations to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('lead received wakeup')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'json-worker', description: 'json worker', prompt: 'wait', context: 'fresh',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    const roster = await execute(ctx, child, 'list_agents', {})
    expect(JSON.parse(text(roster))).toMatchObject([
      { target: 'lead', role: 'lead' },
      { target: 'json-worker', role: 'teammate' },
    ])
    // Every Team result reaches the model as compact JSON: indentation would
    // spend tokens on every roster, task, and receipt without adding meaning.
    expect(text(roster)).toBe(JSON.stringify(JSON.parse(text(roster))))
    const peer = await execute(ctx, child, 'send_message', { target: 'lead', message: 'progress report' })
    expect(peer.isError).toBe(false)
    expect(JSON.parse(text(peer))).toMatchObject({ status: 'accepted' })
    const followup = await execute(ctx, child, 'send_message', { target: 'lead', message: 'review the report' })
    expect(followup.isError).toBe(false)
    expect(JSON.parse(text(followup))).toMatchObject({ status: 'accepted' })
    await lead.whenIdle()

    const created = await execute(ctx, lead, 'team_task_create', {
      subject: 'tool task',
      description: 'created through tool',
      blocked_by: [],
      write_scopes: ['src/team'],
    })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const listed = await execute(ctx, child, 'team_task_list', { ready: true, limit: 1 })
    expect(JSON.parse(text(listed))).toMatchObject({ tasks: [{ id: task.id, ready: true }] })
    const read = await execute(ctx, child, 'team_task_get', { task_id: task.id })
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, revision: 1 })
    const claimed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', ownerName: 'json-worker' })
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    const wait = execute(ctx, lead, 'wait_agent', { timeout_ms: 10_000 })
    const completedCall = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, child, 'team_task_update', {
          task_id: task.id,
          expected_revision: 2,
          action: 'complete',
        }).then(resolve, reject)
      }, 0)
    })
    await expect(wait).resolves.toMatchObject({ isError: false })
    expect((await completedCall).isError).toBe(false)

    const childInterrupt = await execute(ctx, child, 'interrupt_agent', { target: 'json-worker' })
    expect(childInterrupt.isError).toBe(true)
    await execute(ctx, lead, 'interrupt_agent', { target: 'json-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('shows dependent planned tasks before dispatch and reuses a ready task without duplicates', async () => {
    const { ctx, lead } = await setup(['hang'])
    const create = async (subject: string, blocked_by: string[] = []) => {
      const result = await execute(ctx, lead, 'team_task_create', { subject, description: subject, blocked_by })
      expect(result.isError).toBe(false)
      return JSON.parse(text(result)) as { id: string }
    }
    const first = await create('review proposal')
    const second = await create('desktop and web', [first.id])
    await create('sandbox', [first.id])
    const listed = JSON.parse(text(await execute(ctx, lead, 'team_task_list', {}))) as { tasks: unknown[] }
    expect(listed.tasks).toMatchObject([
      { id: 'task-1', ready: true },
      { id: 'task-2', ready: false, blockedBy: ['task-1'] },
      { id: 'task-3', ready: false, blockedBy: ['task-1'] },
    ])
    const blocked = await execute(ctx, lead, 'spawn_teammate', {
      name: 'blocked-worker', description: 'later', prompt: 'later', task_id: second.id,
    })
    expect(blocked.isError).toBe(true)
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect((await execute(ctx, lead, 'spawn_teammate', {
      name: 'missing-worker', description: 'missing', prompt: 'missing', task_id: 'task-99',
    })).isError).toBe(true)
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'planned-worker', description: 'proposal', prompt: 'review proposal', task_id: first.id,
    })
    expect(spawned.isError).toBe(false)
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(3)
    expect(ctx.agentTeams.listTasks(lead)[1]).toMatchObject({ ready: false, blockedBy: [first.id] })
    // The spawn claimed the task for the member, so it is already in progress.
    expect(ctx.agentTeams.listTasks(lead)[0]).toMatchObject({ status: 'in_progress', ownerName: 'planned-worker' })
    expect((await execute(ctx, lead, 'spawn_teammate', {
      name: 'duplicate-worker', description: 'duplicate', prompt: 'duplicate', task_id: first.id,
    })).isError).toBe(true)
    expect((await execute(ctx, child, 'team_task_update', {
      task_id: first.id, expected_revision: ctx.agentTeams.getTask(child, TeamTaskId(first.id)).revision, action: 'complete',
    })).isError).toBe(false)
    expect(ctx.agentTeams.listTasks(lead).slice(1)).toMatchObject([{ ready: true }, { ready: true }])
    await execute(ctx, lead, 'interrupt_agent', { target: 'planned-worker' })
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-worker', description: 'fork worker', prompt: 'stay active', context: 'fork',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitRunning(ctx, childId)

    const firstResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'first task',
    })
    const secondResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'second', description: 'second task',
    })
    const first = JSON.parse(text(firstResult)) as { id: string; revision: number }
    const second = JSON.parse(text(secondResult)) as { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id, expected_revision: first.revision, action: 'claim',
    })
    const claim = JSON.parse(text(claimed)) as { revision: number }

    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      status: 'in_progress', owner: 'lead', cursor: 0, limit: 1,
    })))).toMatchObject({ tasks: [{ id: first.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      owner: 'unowned', limit: 1,
    })))).toMatchObject({ tasks: [{ id: second.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 0, limit: 1,
    })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 1,
    })))).not.toHaveProperty('nextCursor')
    expect((await execute(ctx, lead, 'team_task_list', { cursor: -1 })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_list', { limit: 101 })).isError).toBe(true)

    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: claim.revision,
      action: 'edit',
      subject: 'edited',
      description: 'edited description',
      write_scopes: ['src/team'],
    })
    const edit = JSON.parse(text(edited)) as { revision: number }
    const dependencies = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: edit.revision,
      action: 'set_dependencies',
      blocked_by: [second.id],
    })
    expect(dependencies.isError).toBe(false)
    const dependency = JSON.parse(text(dependencies)) as { revision: number }
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: dependency.revision,
      action: 'reassign',
      owner: 'fork-worker',
    })).isError).toBe(true)

    const wait = execute(ctx, lead, 'wait_agent', {})
    const wake = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, lead, 'team_task_create', {
          subject: 'wake', description: 'wake default wait',
        }).then(resolve, reject)
      }, 0)
    })
    expect((await wait).isError).toBe(false)
    expect((await wake).isError).toBe(false)

    await execute(ctx, lead, 'interrupt_agent', { target: 'fork-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('removes and reinstalls every scoped registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'hmr-worker', description: 'hmr worker', prompt: 'wait',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).some(name => TOOL_NAMES.includes(name))).toBe(false)
    expect(ctx.agents.get(childId)).toBe(child)

    const replacement = await ctx.plugin(toolTeam)
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    expect((await assembly(ctx, child)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    await execute(ctx, lead, 'interrupt_agent', { target: 'hmr-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    await replacement.dispose()
  })

  it('shadows legacy global control names only inside Team member scopes', async () => {
    const { ctx, lead, fiber } = await setup([], true)
    const teamSchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(teamSchema)).toContain('target')
    expect(JSON.stringify(teamSchema)).not.toContain('subagent_id')

    await fiber.dispose()
    const legacySchema = (await assembly(ctx, lead)).tools.find(schema => schema.name === 'send_message')
    expect(JSON.stringify(legacySchema)).toContain('agent_id')
  })

  it('rolls back partial scoped installation after a same-scope collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
      name: 'spawn_teammate',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolTeam)).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(assembled.tools.filter(schema => TOOL_NAMES.includes(schema.name)).map(schema => schema.name))
      .toEqual(['spawn_teammate'])
    expect(renderContextSnapshot(assembled)).not.toContain('Your Team role is lead')
  })

  it('resolves direct-apply defaults without Loader schema normalization', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('ordinary child')])
    await fiber.dispose()
    toolTeam.apply(ctx, {})
    expect((await assembly(ctx, lead)).tools.map(schema => schema.name).filter(name => TOOL_NAMES.includes(name)).sort())
      .toEqual(TOOL_NAMES)
    const ordinary = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: [{ type: 'text', text: 'finish' }], parent: lead },
      signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(ordinary.childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('reinstalls Team scope before a cold-resumed teammate request', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('first'), textResponse('lead received settlement'), 'hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'cold-worker', description: 'cold worker', prompt: 'finish once',
    })
    const childId = spawnedChildId(ctx, lead, spawned)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(await ctx.subagents.listChildren(lead.id)).toContainEqual(expect.objectContaining({
      id: childId,
      mode: 'continuable',
    }))
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === lead.id)).toHaveLength(1)
    })
    await lead.whenIdle()

    const receipt = await ctx.agentTeams.sendMessage(lead, {
      target: 'cold-worker',
      content: [{ type: 'text', text: 'resume with Team scope' }],
      wake: true,
      signal: SIGNAL,
    })
    expect(receipt.status).toBe('accepted')
    const resumed = await waitRunning(ctx, childId)
    expect((await assembly(ctx, resumed)).tools.map(schema => schema.name)
      .filter(name => TOOL_NAMES.includes(name)).sort()).toEqual(TOOL_NAMES)
    expect(renderContextSnapshot(await assembly(ctx, resumed))).not.toContain('You are teammate')
    const childRequests = () => adapter.requests.filter(request => request.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('You are teammate "cold-worker".'))))
    await vi.waitFor(() => { expect(childRequests()).toHaveLength(2) })
    const firstMessages = childRequests()[0]!.messages
    expect(childRequests()[1]!.messages.slice(0, firstMessages.length)).toEqual(firstMessages)
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toHaveLength(1)
    await execute(ctx, lead, 'interrupt_agent', { target: 'cold-worker' })
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "list_agents"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agents', 'agentTeams', 'tools', 'systemPrompt'])
  })

  it('uses configured fresh and fork provider names', async () => {
    const { ctx, lead, fiber } = await setup([textResponse('custom')])
    await fiber.dispose()
    await ctx.plugin(SubagentSpawn, { providerName: 'team-fresh' })
    await ctx.plugin(toolTeam, { freshProvider: 'team-fresh', forkProvider: 'fork' })
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'custom-provider', description: 'custom provider', prompt: 'go',
    })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'team-fresh' })
  })

  it('routes an external teammate with its explicit child model options', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('external child')])
    await ctx.plugin(SubagentSpawn, { providerName: 'engine:claude' })
    const result = await execute(ctx, lead, 'spawn_teammate', {
      name: 'external-worker', description: 'external worker', prompt: 'go',
      engine: 'claude', provider: 'mock', model: 'child-model',
    })
    expect(result.isError).toBe(false)
    const childId = spawnedChildId(ctx, lead, result)
    await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'engine:claude' })
    expect(adapter.requests[0]?.model).toBe('child-model')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('dsh_team MCP server')
  })

  it('rejects external fork context and incomplete model routes before spawning', async () => {
    const { ctx, lead } = await setup([])
    for (const [options, message] of [
      [{ engine: 'codex', context: 'fork' }, 'External teammates support fresh context only'],
      [{ provider: 'mock' }, 'Supply provider and model together'],
      [{ model: 'child-model' }, 'Supply provider and model together'],
      [{ reasoning_effort: ' ' }, 'Child model selection fields must be non-empty'],
    ] as const) {
      const result = await execute(ctx, lead, 'spawn_teammate', {
        name: 'invalid-worker', description: 'invalid worker', prompt: 'go', ...options,
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(message)
    }
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
  })

  it('anchors the teammate session and roster row to a requested cwd', async () => {
    const { ctx, lead } = await setup([textResponse('anchored worker done')])
    const checkout = mkdtempSync(join(tmpdir(), 'dsh-tool-team-cwd-'))
    roots.push(checkout)
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'anchored-worker', description: 'anchored worker', prompt: 'go', cwd: checkout,
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    expect((JSON.parse(text(spawned)) as { member: unknown }).member).toMatchObject({ target: 'anchored-worker', cwd: checkout })
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    expect((await ctx.sessionPersistence.stat(childId))?.header.cwd).toBe(checkout)
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ cwd?: string }>
    expect(listed[1]).toMatchObject({ target: 'anchored-worker', cwd: checkout })

    const missing = await execute(ctx, lead, 'spawn_teammate', {
      name: 'missing-worker', description: 'missing worker', prompt: 'go', cwd: join(checkout, 'missing'),
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('not a usable working directory')
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(2)
  })



  it('creates a workflow with dependencies in one call', async () => {
    const { ctx, lead } = await setup([])
    const result = await execute(ctx, lead, 'team_workflow_create', {
      name: 'sort-pipeline',
      stages: [
        { name: 'design', description: 'design the algorithm', write_scopes: ['docs/sort'] },
        { name: 'develop', subject: 'Implement sorting', description: 'implement it', after: ['design'], write_scopes: ['src/sort'] },
        { name: 'test', description: 'test it', after: ['design', 'develop'] },
      ],
    })
    expect(result.isError, text(result)).toBe(false)
    const parsed = JSON.parse(text(result)) as {
      workflow: string
      stages: Array<{ name: string; task: { id: string; subject: string; ready: boolean; blockedBy: string[]; writeScopes: string[] } }>
    }
    expect(parsed.workflow).toBe('sort-pipeline')
    expect(parsed.stages.map(stage => stage.name)).toEqual(['design', 'develop', 'test'])
    expect(parsed.stages[0]!.task).toMatchObject({ subject: 'design', ready: true, blockedBy: [], writeScopes: ['docs/sort'] })
    expect(parsed.stages[1]!.task).toMatchObject({
      subject: 'Implement sorting', ready: false,
      blockedBy: [parsed.stages[0]!.task.id], writeScopes: ['src/sort'],
    })
    expect(parsed.stages[2]!.task.blockedBy).toEqual([parsed.stages[0]!.task.id, parsed.stages[1]!.task.id])
  })

  it('rejects invalid workflows and non-Lead callers without creating tasks', async () => {
    const { ctx, lead } = await setup(['hang'])
    for (const stages of [
      [{ name: 'design', description: 'once' }, { name: 'design', description: 'twice' }],
      [{ name: 'develop', description: 'later', after: ['design'] }],
      [{ name: ' ', description: 'blank name' }],
    ] as const) {
      const result = await execute(ctx, lead, 'team_workflow_create', { name: 'invalid', stages })
      expect(result.isError, text(result)).toBe(true)
    }
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(0)

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'workflow-worker', description: 'worker', prompt: 'wait',
    })
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const denied = await execute(ctx, child, 'team_workflow_create', {
      name: 'not-lead', stages: [{ name: 'design', description: 'design' }],
    })
    expect(denied.isError, text(denied)).toBe(true)
    expect(text(denied)).toContain('only the Team Lead')
    await execute(ctx, lead, 'interrupt_agent', { target: 'workflow-worker' })
    await waitNoAgent(ctx, child.id)
  })

  it('dispatches, wakes, and waits for a teammate task', async () => {
    const { ctx, lead } = await setup([textResponse('worker ready')])
    const workflow = await execute(ctx, lead, 'team_workflow_create', {
      name: 'pipeline', stages: [{ name: 'work', description: 'do the work' }],
    })
    const task = (JSON.parse(text(workflow)) as { stages: Array<{ task: { id: string } }> }).stages[0]!.task
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'dispatch-worker', description: 'worker', prompt: 'wait for dispatch',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)

    // Wake once without a terminal task state, then complete the task so the
    // dispatch loop observes both a continuing and a finished wait wakeup.
    let wakeCount = 0
    const waitForChange = vi.spyOn(ctx.agentTeams, 'waitForChange').mockImplementation(async () => {
      wakeCount += 1
      if (wakeCount === 2) {
        const taskId = TeamTaskId(task.id)
        for (;;) {
          const latest = ctx.agentTeams.getTask(lead, taskId)
          try {
            await ctx.agentTeams.updateTask(lead, { taskId, expectedRevision: latest.revision, action: 'complete' })
            break
          } catch (error: unknown) {
            if (!(error instanceof Error) || !error.message.includes('stale team task')) throw error
          }
        }
      }
      return { timedOut: false }
    })
    const dispatched = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: task.id, message: 'start the assigned work', wait: true,
    })
    expect(dispatched.isError, text(dispatched)).toBe(false)
    const parsed = JSON.parse(text(dispatched)) as {
      task: { status: string; ownerName: string }
      delivery: { status: string }
      waitTimedOut: boolean
    }
    expect(parsed.task).toMatchObject({ status: 'completed', ownerName: member.target })
    expect(parsed.delivery.status).toBe('accepted')
    expect(parsed.waitTimedOut).toBe(false)
    expect(wakeCount).toBe(2)
    waitForChange.mockRestore()

    // The spawn's own initial task stays bound to the member until completed.
    await ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('task-2'),
      expectedRevision: ctx.agentTeams.getTask(lead, TeamTaskId('task-2')).revision,
      action: 'complete',
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string; currentTaskId?: string }>
    expect(listed.find(row => row.target === member.target)).not.toHaveProperty('currentTaskId')
    await waitNoAgent(ctx, childId)
  })

  it('ends a dispatch wait when the task is deleted and reports timeouts', async () => {
    const { ctx, lead } = await setup([textResponse('worker ready')])
    const workflow = await execute(ctx, lead, 'team_workflow_create', {
      name: 'deletion', stages: [{ name: 'work', description: 'do the work' }],
    })
    const task = (JSON.parse(text(workflow)) as { stages: Array<{ task: { id: string } }> }).stages[0]!.task
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'delete-worker', description: 'worker', prompt: 'wait',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    await waitNoAgent(ctx, spawnedChildId(ctx, lead, spawned))

    const waitForChange = vi.spyOn(ctx.agentTeams, 'waitForChange').mockImplementation(async () => {
      await ctx.agentTeams.updateTask(lead, {
        taskId: TeamTaskId(task.id), expectedRevision: ctx.agentTeams.getTask(lead, TeamTaskId(task.id)).revision, action: 'delete',
      })
      return { timedOut: false }
    })
    const deleted = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: task.id, wait: true, timeout_ms: 10_000,
    })
    expect(deleted.isError, text(deleted)).toBe(false)
    expect(JSON.parse(text(deleted))).toMatchObject({ task: { status: 'deleted' }, waitTimedOut: false })
    waitForChange.mockRestore()

    const timeoutSource = await execute(ctx, lead, 'team_task_create', { subject: 'timeout', description: 'timeout work' })
    const timeoutTask = JSON.parse(text(timeoutSource)) as { id: string }
    const timedOut = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: timeoutTask.id, wait: true, timeout_ms: 1,
    })
    expect(timedOut.isError, text(timedOut)).toBe(false)
    expect(JSON.parse(text(timedOut))).toMatchObject({ task: { status: 'in_progress' }, waitTimedOut: true })
  })

  it('rejects dispatch inputs that leave the task unassigned', async () => {
    const { ctx, lead } = await setup(['hang'])
    const workflow = await execute(ctx, lead, 'team_workflow_create', {
      name: 'guards',
      stages: [
        { name: 'first', description: 'first work' },
        { name: 'second', description: 'second work', after: ['first'] },
      ],
    })
    const stages = (JSON.parse(text(workflow)) as { stages: Array<{ task: { id: string } }> }).stages
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'guard-worker', description: 'worker', prompt: 'wait',
    })
    const child = await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const member = (JSON.parse(text(spawned)) as { member: { target: string } }).member

    const blocked = await execute(ctx, lead, 'dispatch_task', { target: member.target, task_id: stages[1]!.task.id })
    expect(blocked.isError, text(blocked)).toBe(false)
    expect(JSON.parse(text(blocked))).toMatchObject({
      dispatched: false,
      refusal: { reason: 'task-blocked', blockedBy: [stages[0]!.task.id] },
    })
    const unknown = await execute(ctx, lead, 'dispatch_task', { target: 'nobody', task_id: stages[0]!.task.id })
    expect(unknown.isError).toBe(false)
    expect(JSON.parse(text(unknown))).toMatchObject({ dispatched: false, refusal: { reason: 'unknown-target' } })
    const selfTarget = await execute(ctx, lead, 'dispatch_task', { target: 'lead', task_id: stages[0]!.task.id })
    expect(selfTarget.isError).toBe(false)
    expect(JSON.parse(text(selfTarget))).toMatchObject({ dispatched: false, refusal: { reason: 'unknown-target' } })
    const invalidTimeout = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: stages[0]!.task.id, wait: true, timeout_ms: 0,
    })
    expect(invalidTimeout.isError).toBe(true)
    expect(text(invalidTimeout)).toContain('timeout_ms must be a positive safe integer')
    const denied = await execute(ctx, child, 'dispatch_task', { target: member.target, task_id: stages[0]!.task.id })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('only the Team Lead')
    expect(ctx.agentTeams.listTasks(lead).filter(task => task.id === stages[0]!.task.id || task.id === stages[1]!.task.id)
      .every(task => task.status === 'pending' && task.ownerName === undefined)).toBe(true)

    const dispatched = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: stages[0]!.task.id,
    })
    expect(dispatched.isError, text(dispatched)).toBe(false)
    expect(JSON.parse(text(dispatched))).toMatchObject({ dispatched: true, delivery: { status: 'accepted' } })
    const again = await execute(ctx, lead, 'dispatch_task', { target: member.target, task_id: stages[0]!.task.id })
    expect(again.isError, text(again)).toBe(false)
    expect(JSON.parse(text(again))).toMatchObject({
      dispatched: false,
      task: { id: stages[0]!.task.id, status: 'in_progress', ownerName: member.target },
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string; currentTaskId?: string }>
    expect(listed.find(row => row.target === member.target)?.currentTaskId).toBe(stages[0]!.task.id)
    await execute(ctx, lead, 'interrupt_agent', { target: member.target })
    await waitMemberInactive(ctx, lead, member.target)
  })

  it('delivers to a running teammate and reports the prior target status', async () => {
    const { ctx, lead } = await setup(['hang'])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'runner', description: 'runner', prompt: 'wait',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const sent = await execute(ctx, lead, 'send_message', { target: member.target, message: 'progress note' })
    expect(sent.isError, text(sent)).toBe(false)
    expect(JSON.parse(text(sent))).toMatchObject({ status: 'accepted', targetStatus: 'running' })
    await execute(ctx, lead, 'interrupt_agent', { target: member.target })
    await waitMemberInactive(ctx, lead, member.target)
  }, 15_000)

  it('queues mail for an inactive teammate without starting it', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'idle-worker', description: 'worker', prompt: 'finish',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = spawnedChildId(ctx, lead, spawned)
    await waitNoAgent(ctx, childId)
    const sent = await execute(ctx, lead, 'send_message', { target: member.target, message: 'context note' })
    expect(sent.isError, text(sent)).toBe(false)
    expect(JSON.parse(text(sent))).toMatchObject({ status: 'queued', targetStatus: 'inactive' })
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ status: 'inactive' })
    const unknown = await execute(ctx, lead, 'send_message', { target: 'ghost', message: 'hello' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('active teammate "ghost" not found')
    await waitNoAgent(ctx, childId)
  })

  it('interrupts a running teammate before a forced dispatch', async () => {
    const { ctx, lead } = await setup(['hang'])
    const workflow = await execute(ctx, lead, 'team_workflow_create', {
      name: 'forced', stages: [{ name: 'work', description: 'do the work' }],
    })
    const task = (JSON.parse(text(workflow)) as { stages: Array<{ task: { id: string } }> }).stages[0]!.task
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'forced-worker', description: 'worker', prompt: 'wait',
    })
    const { member } = JSON.parse(text(spawned)) as { member: { target: string } }
    await waitRunning(ctx, spawnedChildId(ctx, lead, spawned))
    const dispatched = await execute(ctx, lead, 'dispatch_task', {
      target: member.target, task_id: task.id, force: true,
    })
    expect(dispatched.isError, text(dispatched)).toBe(false)
    expect(JSON.parse(text(dispatched))).toMatchObject({
      task: { status: 'in_progress', ownerName: member.target },
      interrupted: { previousStatus: 'running' },
    })
    expect(['accepted', 'queued']).toContain((JSON.parse(text(dispatched)) as { delivery: { status: string } }).delivery.status)
    await execute(ctx, lead, 'interrupt_agent', { target: member.target })
    await waitMemberInactive(ctx, lead, member.target)
  })

  it('lists the current task owned by each member', async () => {
    const { ctx, lead } = await setup([])
    const created = await execute(ctx, lead, 'team_task_create', { subject: 'owned', description: 'owned work' })
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'claim',
    })
    const listed = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string; currentTaskId?: string }>
    expect(listed.find(row => row.target === 'lead')?.currentTaskId).toBe(task.id)
    await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: 2, action: 'complete',
    })
    const settled = JSON.parse(text(await execute(ctx, lead, 'list_agents', {}))) as Array<{ target: string; currentTaskId?: string }>
    expect(settled.find(row => row.target === 'lead')).not.toHaveProperty('currentTaskId')
  })

})
