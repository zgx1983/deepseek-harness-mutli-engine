// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { chatViewDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { WorkflowPlanCard, type WorkflowPlanCardProps } from '../src/client/WorkflowPlanCard.tsx'
import { workflowPlan } from '../src/client/workflow-plan.ts'
import { workflowDefinition } from '../src/client/workflow-definition.ts'
import { fitViewport } from '../src/client/task-flow.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const args = {
  name: '登录重构',
  stages: [
    { name: 'backend', description: '实现后端' },
    { name: 'frontend', description: '实现前端', after: ['backend'] },
    { name: 'launch', subject: '发布上线', description: '灰度并全量', after: ['backend', 'frontend'] },
  ],
}
const call = {
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: 'call:9', name: 'team_workflow_create', arguments: JSON.stringify(args) },
}
const plan = workflowPlan(call)!
const ptc = {
  rootCallId: 'root', parentCallId: 'root', subCallId: 'call:9', name: 'team_workflow_create', arguments: args,
}

describe('workflow plan identity', () => {
  it('reads native and PTC calls and assigns stage-order ids', () => {
    expect(plan).toEqual({
      callId: 'call:9',
      name: '登录重构',
      tasks: [
        { id: 'task-1', name: 'backend', subject: 'backend', status: 'pending', blockedBy: [] },
        { id: 'task-2', name: 'frontend', subject: 'frontend', status: 'pending', blockedBy: ['task-1'] },
        { id: 'task-3', name: 'launch', subject: '发布上线', status: 'pending', blockedBy: ['task-1', 'task-2'] },
      ],
    })
    for (const type of ['tool/ptc-dispatch-start', 'tool/ptc-dispatch'] as const) {
      expect(workflowPlan({ type, data: { ...ptc } })).toEqual(plan)
    }
  })
  it.each([
    { type: 'user/message', data: call.data },
    { type: 'tool/call', data: { ...call.data, name: 'read' } },
    { type: 'tool/call', data: { ...call.data, callId: '' } },
    { type: 'tool/call', data: { ...call.data, arguments: {} } },
    { type: 'tool/call', data: { ...call.data, arguments: '{' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w"}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":{}}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"description":"x"}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":""}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a"},{"name":"a"}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a","subject":""}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a","after":"b"}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a","after":[1]}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a","after":["ghost"]}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a","after":["a"]}]}' } },
    { type: 'tool/call', data: { ...call.data, arguments: '{"name":"w","stages":[{"name":"a"},{"name":"b","after":["a","b"]}]}' } },
    { type: 'tool/ptc-dispatch-start', data: { ...ptc, subCallId: '' } },
    { type: 'tool/ptc-dispatch-start', data: { ...ptc, arguments: { name: 1, stages: [] } } },
  ])('leaves malformed or never-created plans to the generic tool row: %j', (event) => {
    expect(workflowPlan(event)).toBeUndefined()
  })
})

describe('workflow definition', () => {
  it('matches the invocation family and keeps one card per call id', () => {
    expect(workflowDefinition.match(call as never)).toEqual({ id: 'call:9', role: 'start' })
    expect(workflowDefinition.match({ type: 'tool/ptc-dispatch-start', data: { ...ptc } } as never))
      .toEqual({ id: 'call:9', role: 'start' })
    expect(workflowDefinition.match({ type: 'tool/ptc-dispatch', data: { ...ptc, isError: false, content: [] } } as never))
      .toEqual({ id: 'call:9', role: 'update' })
    expect(workflowDefinition.match({ type: 'user/message', data: {} } as never)).toBeNull()
  })

  it('builds a visible card from the start event and nothing without one', () => {
    const state = workflowDefinition.start({} as never, { event: call } as never, {} as never)
    expect(state).toEqual(plan)
    expect(workflowDefinition.update({ state } as never, {} as never)).toBe(state)
    const context = { key: 'team-workflow:call:9', id: 'call:9', state: plan, start: { event: { seq: 12 }, location: { kind: 'unresolved' } } }
    expect(workflowDefinition.buildViewNode!(context as never)).toEqual({
      key: 'team-workflow:call:9', kind: 'team-workflow', id: 'call:9', target: 'chat',
      anchorSeq: 12, location: { kind: 'unresolved' }, visibility: 'visible', data: plan,
    })
    expect(workflowDefinition.buildViewNode!({ ...context, state: undefined, start: undefined, matches: [] } as never)).toBeNull()
  })

  it('projects one card per workflow invocation across native and PTC settlement', () => {
    const assembler = new ConversationNodeAssembler(
      { entries: () => [workflowDefinition], fallbackEntry: () => undefined },
      { entries: () => [chatViewDefinition] },
    )
    const second = {
      ...call,
      data: { ...call.data, turn: 2, callId: 'call:10', arguments: JSON.stringify({ name: '迁移', stages: [{ name: 'only', description: '唯一阶段' }] }) },
    }
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      call,
      { type: 'tool/ptc-dispatch-start', data: ptc },
      { type: 'tool/ptc-dispatch', data: { ...ptc, isError: false, content: [] } },
      { type: 'turn/end', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      second,
      { type: 'turn/end', data: { turn: 2 } },
    ]
    const entries = events.map((event, index) => ({
      type: 'event', event: { ...event, seq: index + 1, time: index },
    })) as SessionLiveEventEntry[]
    assembler.replaceWindow(entries, false)
    assembler.activateTarget('chat')
    const snapshot = assembler.snapshot('chat') as ChatSnapshot
    const cards = [...snapshot.nodes.values()].filter(node => node.kind === 'team-workflow') as ChatNode<'team-workflow'>[]
    expect(cards).toHaveLength(2)
    expect(cards.map(card => card.data.name)).toEqual(['登录重构', '迁移'])
    expect(cards.map(card => card.anchorSeq)).toEqual([3, 8])
    // The settled PTC dispatch is the same invocation, not a second card.
    expect(snapshot.nodes.values()).toHaveLength(2)
  })
})

describe('WorkflowPlanCard', () => {
  const node: ChatNode<'team-workflow'> = {
    key: 'team-workflow:call:9', kind: 'team-workflow', id: 'call:9', target: 'chat',
    anchorSeq: 12, location: { kind: 'unresolved' }, visibility: 'visible',
    data: {
      callId: 'call:9',
      name: '登录重构',
      tasks: [
        { id: 'task-1' as TeamTaskId, name: 'backend', subject: '实现后端', status: 'pending', blockedBy: [] },
        { id: 'task-2' as TeamTaskId, name: 'frontend', subject: '实现前端', status: 'pending', blockedBy: ['task-1' as TeamTaskId] },
      ],
    },
  }
  const props = { node, t } as WorkflowPlanCardProps

  it('renders the heading, neutral arrows, pending nodes, and caption', () => {
    render(<WorkflowPlanCard {...props} />)
    expect(screen.getByText(zh['workflow.title'])).toBeTruthy()
    const summary = zh['workflow.summary'].replace('{name}', '登录重构').replace('{count}', '2')
    expect(screen.getByText(summary)).toBeTruthy()
    expect(screen.getByText(zh['workflow.caption'])).toBeTruthy()
    expect(document.querySelectorAll('g[role="button"]')).toHaveLength(0)
    const nodes = document.querySelectorAll('svg g[aria-label]')
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.getAttribute('aria-label')).toBe('实现后端, task-1')
    const edge = document.querySelector('svg g[transform] path')!
    expect(edge.querySelector('title')?.textContent).toBe('实现后端 → 实现前端')
  })

  it('keeps the identity viewport when the canvas is unmeasurable', () => {
    render(<WorkflowPlanCard {...props} />)
    expect(document.querySelector('svg g[transform]')!.getAttribute('transform')).toBe('translate(0,0) scale(1)')
  })
})

describe('fitViewport', () => {
  it('scales content down to the canvas and centers it without enlarging', () => {
    expect(fitViewport({ width: 500, height: 400 }, 250, 200)).toEqual({ x: 125, y: 100, scale: 1 })
    const shrunk = fitViewport({ width: 100, height: 100 }, 500, 200)
    expect(shrunk.scale).toBe(0.2)
    expect(shrunk.x).toBe(0)
    expect(shrunk.y).toBe(Math.max(8, (100 - 200 * 0.2) / 2))
    expect(fitViewport({ width: 100, height: 100 }, 10, 10)).toEqual({ x: 45, y: 45, scale: 1 })
  })
})
