// @vitest-environment jsdom

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import type { TeamTaskId, TeamTaskView as TeamTask } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { EngineSubagentRecord } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamDashboard, TeamDashboardTitle } from '../src/client/TeamDashboard.tsx'
import { TeamAction } from '../src/client/TeamAction.tsx'
import type { TeamSectionProps } from '../src/client/TeamSection.tsx'
import { TeamSection } from '../src/client/TeamSection.tsx'
import { TaskDependencyGraph } from '../src/client/TaskDependencyGraph.tsx'
import { TaskGroups } from '../src/client/TaskGroups.tsx'
import { groupTasks, layoutTaskGraph, taskDotState, taskStatusKey } from '../src/client/task-flow.ts'
import { readFold, writeFold } from '../src/client/collapse-preferences.ts'
import { useAreaFolds, useFold } from '../src/client/fold-state.ts'
import { SESSION, WORKER, bench, lead, setProjection, team, worker, zh } from './team-bench.client.tsx'

const hadNativeScrollIntoView = typeof Element.prototype.scrollIntoView === 'function'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (!hadNativeScrollIntoView) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

beforeEach(() => {
  localStorage.clear()
})

function makeTask(id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: id as TeamTaskId, revision: 1, subject: `Task ${id}`, description: `Describe ${id}`,
    status: 'pending', blockedBy: [], approval: 'not-required', inputPaths: [], outputPaths: [],
    generation: 1, executionState: 'none', writeScopes: [], ready: true, writeScopeWarnings: [],
    ...overrides,
  }
}

/** Flush the reveal timer chain under real timers. */
async function flushReveal(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(() => { resolve(undefined) }, 0) }) })
}

describe('task-flow transforms', () => {
  it('labels and dots every live task status', () => {
    expect(taskStatusKey('pending')).toBe('status.pending')
    expect(taskStatusKey('in_progress')).toBe('status.in_progress')
    expect(taskStatusKey('completed')).toBe('status.completed')
    expect(taskDotState({ ...makeTask('a'), ready: true })).toBe('idle')
    expect(taskDotState(makeTask('b', { ready: false }))).toBe('warning')
    expect(taskDotState(makeTask('c', { status: 'in_progress' }))).toBe('ongoing')
    expect(taskDotState(makeTask('d', { status: 'completed' }))).toBe('done')
  })

  it('partitions the board and counts waiting dependencies', () => {
    const grouping = groupTasks([
      makeTask('run', { status: 'in_progress' }),
      makeTask('ready'),
      makeTask('blocked', { ready: false, blockedBy: ['run' as TeamTaskId] }),
      makeTask('done', { status: 'completed' }),
    ])
    expect(grouping.inProgress.map(task => task.id)).toEqual(['run'])
    expect(grouping.pending.map(task => task.id)).toEqual(['ready', 'blocked'])
    expect(grouping.completed.map(task => task.id)).toEqual(['done'])
    expect(grouping.waitingDependency).toBe(1)
  })

  it('layers a fork by prerequisite depth and creation order', () => {
    const a = makeTask('a', { status: 'in_progress' })
    const b = makeTask('b', { blockedBy: [a.id] })
    const c = makeTask('c', { blockedBy: [a.id] })
    const layout = layoutTaskGraph([a, b, c])
    expect(layout.nodes.map(node => [node.id, node.depth, node.lane])).toEqual([
      ['a', 0, 0], ['b', 1, 0], ['c', 1, 1],
    ])
    expect(layout.edges.map(edge => [edge.from, edge.to, edge.satisfied])).toEqual([
      ['a', 'b', false], ['a', 'c', false],
    ])
    expect(layout.cyclic).toBe(false)
    expect(layout.width).toBe(2 * (176 + 46))
    expect(layout.height).toBe(2 * (54 + 28))
    const [upstream, firstDownstream, secondDownstream] = layout.nodes
    expect(upstream?.x).toBe(0)
    expect(firstDownstream?.x).toBe(176 + 46)
    expect(secondDownstream?.x).toBe(176 + 46)
    expect(firstDownstream?.y).toBe(0)
    expect(secondDownstream?.y).toBe(54 + 28)

    const done = layoutTaskGraph([{ ...a, status: 'completed' }, b, c])
    expect(done.edges.every(edge => edge.satisfied)).toBe(true)
    const first = done.edges[0]
    expect(first?.x1).toBe(176)
    expect(first?.y1).toBe(27)
    expect(first?.x2).toBe(176 + 46)
    expect(first?.y2).toBe(27)
  })

  it('lays downstream nodes to the right and stacks siblings vertically', () => {
    const a = makeTask('a')
    const b = makeTask('b', { blockedBy: [a.id] })
    const c = makeTask('c', { blockedBy: [a.id] })
    const layout = layoutTaskGraph([a, b, c])
    const upstream = layout.nodes.find(node => node.id === 'a')!
    const firstDownstream = layout.nodes.find(node => node.id === 'b')!
    const secondDownstream = layout.nodes.find(node => node.id === 'c')!

    expect(upstream.x).toBeLessThan(firstDownstream.x)
    expect(firstDownstream.x).toBe(secondDownstream.x)
    expect(firstDownstream.y).toBeLessThan(secondDownstream.y)
    expect(layout.edges.map(edge => [edge.x1, edge.y1, edge.x2, edge.y2])).toEqual([
      [176, 27, 222, 27],
      [176, 27, 222, 109],
    ])
  })

  it('keeps isolated, chained, and joined tasks at their dependency depth', () => {
    const a = makeTask('a')
    const alone = makeTask('solo')
    const isolated = layoutTaskGraph([a, alone])
    expect(isolated.nodes.map(node => [node.id, node.depth, node.lane])).toEqual([['a', 0, 0], ['solo', 0, 1]])

    const b = makeTask('b', { blockedBy: [a.id] })
    const c = makeTask('c', { blockedBy: [b.id] })
    expect(layoutTaskGraph([a, b, c]).nodes.map(node => node.depth)).toEqual([0, 1, 2])

    const d = makeTask('d', { blockedBy: [b.id, c.id] })
    expect(layoutTaskGraph([a, b, c, d]).nodes.find(node => node.id === 'd')?.depth).toBe(3)
    const empty = layoutTaskGraph([])
    expect(empty.nodes).toEqual([])
    expect(empty.edges).toEqual([])
    expect(empty.width).toBe(0)
    expect(empty.height).toBe(0)
  })

  it('reports cycles without dropping tasks and memoizes revisited depths', () => {
    const a = makeTask('a', { blockedBy: ['b' as TeamTaskId] })
    const b = makeTask('b', { blockedBy: [a.id] })
    const cycle = layoutTaskGraph([a, b])
    expect(cycle.cyclic).toBe(true)
    expect(cycle.nodes.map(node => node.id).sort()).toEqual(['a', 'b'])
    expect(cycle.nodes.every(node => node.task !== undefined)).toBe(true)

    const self = layoutTaskGraph([makeTask('loop', { blockedBy: ['loop' as TeamTaskId] })])
    expect(self.cyclic).toBe(true)
    expect(self.nodes).toHaveLength(1)

    const root = makeTask('root', { status: 'in_progress' })
    const left = makeTask('left', { blockedBy: [root.id] })
    const right = makeTask('right', { blockedBy: [root.id] })
    const join = makeTask('join', { blockedBy: [left.id, right.id] })
    expect(layoutTaskGraph([root, left, right, join]).nodes.find(node => node.id === 'join')?.depth).toBe(2)
  })

  it('renders missing prerequisites as read-only placeholders', () => {
    const a = makeTask('a')
    const b = makeTask('b', { blockedBy: ['ghost' as TeamTaskId] })
    const layout = layoutTaskGraph([a, b])
    const ghost = layout.nodes.find(node => node.id === 'ghost')
    expect(ghost?.task).toBeUndefined()
    expect(ghost?.depth).toBe(0)
    expect(ghost?.lane).toBe(1)
    expect(layout.nodes.find(node => node.id === 'b')?.depth).toBe(1)
    expect(layout.edges.map(edge => [edge.from, edge.to, edge.satisfied])).toEqual([['ghost', 'b', false]])
  })
})

describe('collapse preferences', () => {
  const KEY = 'dsh.agent-team-panel.v1'

  it('stores one choice per team and fold', () => {
    expect(readFold('t1', 'tasks')).toBeUndefined()
    writeFold('t1', 'tasks', false)
    writeFold('t2', 'tasks', true)
    expect(readFold('t1', 'tasks')).toBe(false)
    expect(readFold('t2', 'tasks')).toBe(true)
    writeFold('t1', 'tasks', true)
    expect(readFold('t1', 'tasks')).toBe(true)
    expect(readFold('t1', 'flow')).toBeUndefined()
  })

  it('ignores corrupted or foreign storage contents', () => {
    localStorage.setItem(KEY, '{not json')
    expect(readFold('t1', 'tasks')).toBeUndefined()
    localStorage.setItem(KEY, JSON.stringify([1, 2]))
    expect(readFold('t1', 'tasks')).toBeUndefined()
    localStorage.setItem(KEY, JSON.stringify(3))
    expect(readFold('t1', 'tasks')).toBeUndefined()
    localStorage.setItem(KEY, JSON.stringify({ t1: { tasks: 'yes', flow: true }, t2: 'junk' }))
    expect(readFold('t1', 'tasks')).toBeUndefined()
    expect(readFold('t1', 'flow')).toBe(true)
    expect(readFold('t2', 'tasks')).toBeUndefined()
  })

  it('degrades without storage and reports write failures', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('localStorage', undefined)
    expect(readFold('t1', 'tasks')).toBeUndefined()
    expect(() => { writeFold('t1', 'tasks', false) }).not.toThrow()
    expect(error).not.toHaveBeenCalled()

    const failing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => {},
      clear: () => {},
    }
    vi.stubGlobal('localStorage', failing)
    expect(readFold('t1', 'tasks')).toBeUndefined()
    writeFold('t1', 'tasks', false)
    expect(error).toHaveBeenCalledOnce()
  })
})

describe('fold hooks', () => {
  it('useFold keeps defaults, stores overrides, and re-reads on team switch', () => {
    const rendered = renderHook(({ teamId }: { teamId: string }) => useFold(teamId, 'flow', true), { initialProps: { teamId: 't1' } })
    expect(rendered.result.current[0]).toBe(true)
    act(() => { rendered.result.current[1](false) })
    expect(rendered.result.current[0]).toBe(false)
    expect(readFold('t1', 'flow')).toBe(false)

    rendered.rerender({ teamId: 't2' })
    expect(rendered.result.current[0]).toBe(true)
    act(() => { rendered.result.current[1](false) })
    expect(readFold('t2', 'flow')).toBe(false)

    rendered.rerender({ teamId: 't1' })
    expect(rendered.result.current[0]).toBe(false)
  })

  it('useAreaFolds folds the area and its groups with per-group defaults', () => {
    const rendered = renderHook(({ teamId }: { teamId: string }) =>
      useAreaFolds(teamId, 'tasks', { in_progress: true, pending: true, completed: false }), { initialProps: { teamId: 't1' } })
    const folds = rendered.result.current
    expect(folds.areaExpanded).toBe(true)
    expect(folds.groupExpanded('completed')).toBe(false)
    expect(folds.groupExpanded('in_progress')).toBe(true)
    expect(folds.groupExpanded('failed')).toBe(true)

    act(() => { folds.setAreaExpanded(false) })
    expect(rendered.result.current.areaExpanded).toBe(false)
    act(() => { rendered.result.current.setGroupExpanded('completed', true) })
    expect(rendered.result.current.groupExpanded('completed')).toBe(true)
    expect(readFold('t1', 'tasks/completed')).toBe(true)
    act(() => { rendered.result.current.setAllGroups(false, ['in_progress', 'completed']) })
    expect(rendered.result.current.groupExpanded('in_progress')).toBe(false)
    expect(readFold('t1', 'tasks/in_progress')).toBe(false)
    expect(rendered.result.current.groupExpanded('failed')).toBe(true)

    rendered.rerender({ teamId: 't2' })
    expect(rendered.result.current.areaExpanded).toBe(true)
    expect(rendered.result.current.groupExpanded('completed')).toBe(false)
  })
})

function SectionHarness({ initial = true, ...rest }: { initial?: boolean } & Partial<TeamSectionProps>) {
  const [expanded, setExpanded] = useState(initial)
  return <TeamSection title="任务看板" count={3} summary={['执行中 1']} expanded={expanded} onToggle={setExpanded} {...rest}>
    <button type="button" className="body-button">inside</button>
  </TeamSection>
}

describe('TeamSection', () => {
  it('toggles the body while keeping header counts visible', () => {
    const rendered = render(<SectionHarness />)
    const toggle = screen.getByRole('button', { name: /任务看板/u })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const bodyId = toggle.getAttribute('aria-controls')
    expect(bodyId).toBeTruthy()
    expect(document.getElementById(bodyId!)).not.toBeNull()
    expect(screen.getByText('执行中 1')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(bodyId!)).toBeNull()
    expect((screen.getByRole('heading', { name: /任务看板/u }).textContent ?? '').replace(/\s+/gu, '')).toBe('任务看板3执行中1')
    expect(screen.getByText('执行中 1')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(bodyId!)).not.toBeNull()
    rendered.unmount()
  })

  it('shows area actions only while expanded', () => {
    const rendered = render(<SectionHarness actions={<button type="button">全部展开</button>} />)
    expect(screen.getByText('全部展开')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /任务看板/u }))
    expect(screen.queryByText('全部展开')).toBeNull()
    rendered.unmount()
  })

  it('renders group headings without count, summary, or actions', () => {
    render(<TeamSection title="已完成" level="group" expanded={false} onToggle={() => {}}><span>body</span></TeamSection>)
    expect(screen.getByRole('heading', { level: 4 })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })

  it('returns focus to the header when collapsing the focused body', () => {
    render(<SectionHarness />)
    screen.getByText('inside').focus()
    expect(document.activeElement).toBe(screen.getByText('inside'))
    fireEvent.click(screen.getByRole('button', { name: /任务看板/u }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /任务看板/u }))
  })
})

const graphTasks = [
  makeTask('a', { status: 'in_progress' }),
  makeTask('b', { blockedBy: ['a' as TeamTaskId] }),
  makeTask('c', { blockedBy: ['a' as TeamTaskId], ready: false }),
]

describe('TaskDependencyGraph', () => {
  it('shows a short notice for an empty board', () => {
    render(<TaskDependencyGraph tasks={[]} t={bench().props.t} />)
    expect(screen.getByText(zh['flow.empty'])).toBeTruthy()
  })

  it('renders accessible nodes, edge descriptions, and the legend', () => {
    const rendered = render(<TaskDependencyGraph tasks={graphTasks} t={bench().props.t} />)
    expect(screen.getByRole('group', { name: zh['flow.title'] })).toBeTruthy()
    for (const task of graphTasks) {
      expect(screen.getByRole('button', { name: new RegExp(task.subject, 'u') })).toBeTruthy()
    }
    expect(screen.getByText(zh['flow.legend.satisfied'])).toBeTruthy()
    expect(screen.getByText(zh['flow.legend.blocked'])).toBeTruthy()
    expect(screen.getByText(zh['flow.legend.missing'])).toBeTruthy()
    const blocked = document.querySelector('svg g[transform] path')!
    expect(blocked.querySelector('title')?.textContent).toContain(zh['flow.legend.blocked'])
    expect(document.querySelectorAll('g[role="button"]')).toHaveLength(3)
    rendered.unmount()

    const completed = [{ ...graphTasks[0]!, status: 'completed' as const }, ...graphTasks.slice(1)]
    render(<TaskDependencyGraph tasks={completed} t={bench().props.t} />)
    const satisfied = document.querySelector('svg g[transform] path')!
    expect(satisfied.querySelector('title')?.textContent).toContain(zh['flow.legend.satisfied'])
  })

  it('shows read-only placeholders and the cycle notice without dropping nodes', () => {
    const onSelect = vi.fn()
    const a = makeTask('a', { blockedBy: ['ghost' as TeamTaskId] })
    const b = makeTask('b', { blockedBy: [a.id] })
    const rendered = render(<TaskDependencyGraph tasks={[a, b]} onSelectTask={onSelect} t={bench().props.t} />)
    expect(screen.getAllByText(zh['flow.missingTask'])).toHaveLength(2)
    expect(screen.getByText('ghost')).toBeTruthy()
    expect(document.querySelectorAll('g[role="button"]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /Task b/u }))
    expect(screen.getByText(new RegExp(zh['flow.prereqs'], 'u')).textContent).toContain('Task a')
    fireEvent.click(screen.getByRole('button', { name: /Task a/u }))
    expect(screen.getByText(new RegExp(zh['flow.prereqs'], 'u')).textContent).toContain(zh['flow.missingTask'])
    rendered.rerender(<TaskDependencyGraph
      tasks={[makeTask('x', { blockedBy: ['y' as TeamTaskId] }), makeTask('y', { blockedBy: ['x' as TeamTaskId] })]}
      onSelectTask={onSelect} t={bench().props.t} />)
    expect(screen.getByRole('note').textContent).toBe(zh['flow.cyclic'])
    rendered.unmount()
  })

  it('fits at mount only with a measured canvas and refits on demand', () => {
    const rendered = render(<TaskDependencyGraph tasks={graphTasks} t={bench().props.t} />)
    const transform = (): string => document.querySelector('svg g[transform]')!.getAttribute('transform')!
    expect(transform()).toBe('translate(0,0) scale(1)')
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 400))
    fireEvent.click(screen.getByRole('button', { name: zh['flow.fit'] }))
    expect(transform()).toBe(`translate(${(500 - layoutTaskGraph(graphTasks).width) / 2},${Math.max(8, (400 - layoutTaskGraph(graphTasks).height) / 2)}) scale(1)`)
    rendered.unmount()
  })

  it('zooms between the scale limits', () => {
    render(<TaskDependencyGraph tasks={graphTasks} t={bench().props.t} />)
    const transform = (): string => document.querySelector('svg g[transform]')!.getAttribute('transform')!
    for (let step = 0; step < 7; step += 1) fireEvent.click(screen.getByRole('button', { name: zh['flow.zoomIn'] }))
    expect(transform()).toContain('scale(4)')
    for (let step = 0; step < 14; step += 1) fireEvent.click(screen.getByRole('button', { name: zh['flow.zoomOut'] }))
    expect(transform()).toContain('scale(0.2)')
  })

  it('requests fullscreen when the platform offers it and ignores denial', async () => {
    render(<TaskDependencyGraph tasks={graphTasks} t={bench().props.t} />)
    const canvas = document.querySelector('[class*="flowCanvas"]') as HTMLDivElement
    const request = vi.fn(() => Promise.resolve())
    Object.assign(canvas, { requestFullscreen: request })
    fireEvent.click(screen.getByRole('button', { name: zh['flow.fullscreen'] }))
    expect(request).toHaveBeenCalledOnce()

    Object.assign(canvas, { requestFullscreen: vi.fn(() => Promise.reject(new Error('denied'))) })
    fireEvent.click(screen.getByRole('button', { name: zh['flow.fullscreen'] }))
    await new Promise((resolve) => { setTimeout(() => { resolve(undefined) }, 0) })
  })

  it('leaves the canvas in place when the platform has no fullscreen API', () => {
    render(<TaskDependencyGraph tasks={graphTasks} t={bench().props.t} />)
    expect(() => { fireEvent.click(screen.getByRole('button', { name: zh['flow.fullscreen'] })) }).not.toThrow()
  })

  it('pans by pointer drag and suppresses the drag-release click', async () => {
    const onSelect = vi.fn()
    render(<TaskDependencyGraph tasks={graphTasks} onSelectTask={onSelect} t={bench().props.t} />)
    const svg = document.querySelector('[class*="flowCanvas"] svg')!
    const transform = (): string => document.querySelector('svg g[transform]')!.getAttribute('transform')!

    fireEvent.pointerDown(svg, { pointerId: 1, button: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 30, clientY: 20 })
    expect(transform()).toBe('translate(0,0) scale(1)')

    fireEvent.pointerMove(svg, { pointerId: 9, clientX: 30, clientY: 20 })
    expect(transform()).toBe('translate(0,0) scale(1)')

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 1, clientY: 1 })
    expect(transform()).toBe('translate(1,1) scale(1)')
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 40, clientY: 12 })
    expect(transform()).toBe('translate(40,12) scale(1)')
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 40, clientY: 12 })
    const node = screen.getByRole('button', { name: /Task b/u })
    fireEvent.click(node)
    expect(onSelect).not.toHaveBeenCalled()

    await flushReveal()
    fireEvent.click(node)
    expect(onSelect).toHaveBeenCalledWith('b')

    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(svg, { pointerId: 2 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 5, clientY: 5 })
    expect(transform()).toBe('translate(45,17) scale(1)')
    fireEvent.pointerCancel(svg, { pointerId: 1 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(transform()).toBe('translate(45,17) scale(1)')
  })

  it('activates nodes by pointer and keyboard to show adjacent tasks', () => {
    const onSelect = vi.fn()
    const rendered = render(<TaskDependencyGraph tasks={graphTasks} onSelectTask={onSelect} t={bench().props.t} />)
    const node = screen.getByRole('button', { name: /Task b/u })
    expect(screen.queryByText(new RegExp(zh['flow.prereqs'], 'u'))).toBeNull()

    fireEvent.click(node)
    expect(onSelect).toHaveBeenCalledWith('b')
    const detail = screen.getByText(new RegExp(zh['flow.prereqs'], 'u'))
    expect(detail.textContent).toContain('Task a')
    expect(detail.textContent).not.toContain(zh['flow.successors'])

    fireEvent.keyDown(node, { key: 'x' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(node, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
    const successor = screen.getByRole('button', { name: /Task a/u })
    fireEvent.keyDown(successor, { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(3)
    expect(screen.getByText(new RegExp(zh['flow.successors'], 'u')).textContent).toContain('Task b')

    fireEvent.keyDown(screen.getByRole('button', { name: /Task c/u }), { key: 'Enter' })
    expect(screen.getByText(new RegExp(zh['flow.prereqs'], 'u')).textContent).toContain('Task a')
    rendered.rerender(<TaskDependencyGraph tasks={[makeTask('solo')]} onSelectTask={onSelect} t={bench().props.t} />)
    expect(screen.queryByText(new RegExp(zh['flow.prereqs'], 'u'))).toBeNull()
    rendered.unmount()
  })
})

describe('TaskGroups', () => {
  const board = [
    makeTask('run', { status: 'in_progress' }),
    makeTask('ready'),
    makeTask('blocked', { ready: false, blockedBy: ['run' as TeamTaskId] }),
    makeTask('done', { status: 'completed' }),
  ]
  const areaHeading = (): string =>
    (screen.getByRole('heading', { name: new RegExp(zh.tasks, 'u') }).textContent ?? '').replace(/\s+/gu, '')
  const expectAreaHeading = (): void => {
    expect(areaHeading()).toBe(`${zh.tasks}4${zh['taskGroup.in_progress']}1${zh['flow.waitingDependency']}1${zh['taskGroup.completed']}1`)
  }

  it('keeps owners plain when navigation inputs lack a roster', () => {
    render(<TaskGroups teamId="t" tasks={[makeTask('owned', { ownerName: 'worker', status: 'in_progress' })]}
      sessionId={SESSION} openTeammate={vi.fn()} t={bench().props.t} />)
    expect(screen.getByText(`${zh.owner}: worker`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: new RegExp(zh.open, 'u') })).toBeNull()
  })

  it('shows an empty board notice without group actions', () => {
    render(<TaskGroups teamId="t" tasks={[]} t={bench().props.t} />)
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.queryByText(zh['section.expandAll'])).toBeNull()
  })

  it('groups tasks with default folds and full-board summaries', () => {
    render(<TaskGroups teamId="t" tasks={board} t={bench().props.t} />)
    expectAreaHeading()
    expect(screen.getByText('Task run')).toBeTruthy()
    expect(screen.getByText('Task ready')).toBeTruthy()
    expect(screen.queryByText('Task done')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh['section.expandAll'] }))
    expect(screen.getByText('Task done')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['section.collapseAll'] }))
    expect(screen.queryByText('Task run')).toBeNull()
    expectAreaHeading()
  })

  it('collapses the whole area while keeping its counts', () => {
    render(<TaskGroups teamId="t" tasks={board} t={bench().props.t} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh.tasks, 'u') }))
    expect(screen.queryByText('Task run')).toBeNull()
    expectAreaHeading()
    expect(screen.queryByRole('button', { name: zh['section.expandAll'] })).toBeNull()
  })

  it('reveals a graph-selected card by expanding its group and highlighting it', async () => {
    const scrollIntoView = vi.fn(() => {})
    Element.prototype.scrollIntoView = scrollIntoView
    vi.useFakeTimers()
    const rendered = render(<TaskGroups teamId="t" tasks={board} reveal={{ taskId: 'done' as TeamTaskId, nonce: 1 }} t={bench().props.t} />)
    expect(screen.getByText('Task done')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    const revealedCard = screen.getByText('Task done').closest('article')!.parentElement!
    expect(revealedCard.className).toContain('taskReveal')

    await act(async () => { await vi.advanceTimersByTimeAsync(2400) })
    expect(revealedCard.className).not.toContain('taskReveal')

    rendered.rerender(<TaskGroups teamId="t" tasks={board} reveal={{ taskId: 'gone' as TeamTaskId, nonce: 2 }} t={bench().props.t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Task done')).toBeTruthy()
    rendered.unmount()
  })
})

const engineChild: EngineSubagentRecord = {
  engine: 'claude', id: 'c1' as EngineSubagentRecord['id'], title: 'Engine child',
  status: 'running', progress: '', output: '',
}

describe('TeamDashboard', () => {
  const tabProps = { useTabInfo: () => { throw new Error('unused') } }

  it('shows the unavailable notice or engine children before a Team arrives', () => {
    const b = bench({ projections: {} })
    render(<TeamDashboard {...b.props} {...tabProps} />)
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    cleanup()

    const engineOnly = bench({ projections: {
      [SESSION]: { state: 'ready', error: null, values: { engineSubagents: [engineChild] } },
    } })
    render(<TeamDashboard {...engineOnly.props} {...tabProps} />)
    expect(screen.getByText('Engine child')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: new RegExp(zh['flow.title'], 'u') })).toBeNull()
    cleanup()

    const combined = bench({ projections: {
      [SESSION]: { state: 'ready', error: null, values: {
        agentTeam: { members: [lead, { id: 'prov' as SessionId, name: 'provisioning-worker', role: 'teammate', phase: 'provisioning', engine: 'native' }], tasks: [] },
        engineSubagents: [engineChild],
      } },
    } })
    render(<TeamDashboard {...combined.props} {...tabProps} />)
    expect(screen.getByText('Engine child')).toBeTruthy()
    expect(screen.getByRole('heading', { name: new RegExp(zh['flow.title'], 'u') })).toBeTruthy()
    expect(screen.getByText('provisioning-worker')).toBeTruthy()
  })

  it('stacks flow, members, and tasks with a members summary', () => {
    const b = bench()
    render(<TeamDashboard {...b.props} {...tabProps} />)
    expect(screen.getByRole('heading', { name: new RegExp(zh['flow.title'], 'u') })).toBeTruthy()
    expect((screen.getByRole('heading', { name: /成员/u }).textContent ?? '').replace(/\s+/gu, '')).toBe('成员1')
    expect(screen.queryByText(`${zh['dashboard.running']} 1`)).toBeNull()

    act(() => { b.statuses.set(new Map([[WORKER, { running: true, pendingInteraction: undefined, completionUnread: false }]])) })
    expect(screen.getByText(`${zh['dashboard.running']} 1`)).toBeTruthy()

    const membersSection = screen.getByRole('heading', { name: /成员/u }).closest('section')!
    fireEvent.click(within(membersSection).getByRole('button', { name: zh['section.collapseAll'] }))
    expect(within(membersSection).queryByRole('button', { name: new RegExp(worker.name, 'u') })).toBeNull()
    fireEvent.click(within(membersSection).getByRole('button', { name: zh['section.expandAll'] }))
    expect(within(membersSection).getByRole('button', { name: new RegExp(worker.name, 'u') })).toBeTruthy()
  })

  it('labels member rows from activity and task intervals', () => {
    const running = (): Record<SessionId, boolean> => ({
      ['b' as SessionId]: false, ['c' as SessionId]: false, ['d' as SessionId]: false,
    })
    const b = bench({
      running: running(),
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
        members: [lead,
          { id: 'b' as SessionId, name: 'unstarted-worker', role: 'teammate', phase: 'active', engine: 'native' },
          { id: 'c' as SessionId, name: 'pending-worker', role: 'teammate', phase: 'active', engine: 'native' },
          { id: 'd' as SessionId, name: 'completed-worker', role: 'teammate', phase: 'active', engine: 'native' }],
        tasks: [
          makeTask('n0', { ownerName: 'unstarted-worker', status: 'completed' }),
          makeTask('p0', { ownerName: 'pending-worker', status: 'in_progress' }),
          makeTask('c0', { ownerName: 'completed-worker', status: 'completed', startedAt: 1, endedAt: 2 }),
        ],
      } } } } })
    render(<TeamDashboard {...b.props} {...tabProps} />)
    const membersArea = screen.getByRole('heading', { name: /^成员/u }).closest('section')!
    const row = (name: RegExp): HTMLButtonElement => within(membersArea).getByRole('button', { name }) as HTMLButtonElement
    expect(row(/unstarted-worker/u).textContent).toContain(zh['memberStatus.inactive'])
    expect(row(/pending-worker/u).textContent).toContain(zh['dashboard.pending'])
    expect(row(/completed-worker/u).textContent).toContain(zh['dashboard.completed'])
    expect(row(/unstarted-worker/u).querySelector('svg:not([data-state])')).not.toBeNull()
    expect(row(/pending-worker/u).querySelector('[data-state="idle"]')).not.toBeNull()
    expect(row(/completed-worker/u).querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('opens the dashboard from the header panel action', () => {
    const b = bench()
    render(<TeamAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: /智能体团队|子智能体/u }))
    fireEvent.click(screen.getByRole('button', { name: zh['dashboard.open'] }))
    expect(b.injected.openDashboard).toHaveBeenCalledWith(SESSION)
  })

  it('opens the owner member Session from a task card when the roster resolves one', () => {
    const b = bench({
      statuses: new Map([[WORKER, { running: false, pendingInteraction: undefined, completionUnread: false }]]),
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
        members: [lead, worker],
        tasks: [
          makeTask('mine', { ownerName: 'worker', status: 'in_progress' }),
          makeTask('free'),
        ],
      } } } },
    })
    b.injected.openTeammate = vi.fn()
    render(<TeamDashboard {...b.props} {...b.injected} {...tabProps} />)
    fireEvent.click(screen.getByRole('button', { name: `${zh.open}: worker` }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(SESSION, WORKER)
    // The current conversation's owner and unclaimed tasks stay plain text.
    expect(screen.queryByRole('button', { name: `${zh.open}: lead` })).toBeNull()
    cleanup()

    const failed = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
      members: [lead, { ...worker, phase: 'failed' as const }],
      tasks: [makeTask('owned', { ownerName: 'worker', status: 'in_progress' })],
    } } } } })
    failed.injected.openTeammate = vi.fn()
    render(<TeamDashboard {...failed.props} {...failed.injected} {...tabProps} />)
    expect(screen.queryByRole('button', { name: new RegExp(zh.open, 'u') })).toBeNull()

    const failing = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
      members: [lead, worker],
      tasks: [makeTask('theirs', { ownerName: 'worker', status: 'in_progress' })],
    } } } } })
    failing.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamDashboard {...failing.props} {...failing.injected} {...tabProps} />)
    fireEvent.click(screen.getByRole('button', { name: `${zh.open}: worker` }))
    expect(screen.getAllByRole('alert').some(alert => alert.textContent === 'Error: navigation failed')).toBe(true)
  })

  it('renders engine children in the header panel with their output fields', () => {
    const child = (id: string, status: EngineSubagentRecord['status'], fields: Partial<EngineSubagentRecord> = {}): EngineSubagentRecord => ({
      engine: 'claude', id: id as EngineSubagentRecord['id'], title: `Child ${id}`,
      status, progress: '', output: '', ...fields,
    })
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { engineSubagents: [
      child('c1', 'running', { progress: 'step 2', output: 'partial output', parentId: 'p1' as EngineSubagentRecord['id'], model: 'm1' }),
      child('c2', 'completed'), child('c3', 'failed'), child('c4', 'pending'), child('c5', 'unknown'), child('c6', 'stopped'),
    ] } } } })
    render(<TeamAction {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: /子智能体/u }))
    expect(screen.getByText('Child c1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Child c1/u }))
    expect(screen.getByText('partial output')).toBeTruthy()
    expect(screen.getByText(/p1/u)).toBeTruthy()
    expect(screen.getByText(/m1/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Child c2/u }))
    expect(screen.getByText(zh['engine.noOutput'])).toBeTruthy()
  })

  it('renders the localized tab title', () => {
    const b = bench()
    render(<TeamDashboardTitle {...b.props} useTabInfo={tabProps.useTabInfo} />)
    expect(screen.getByText(zh['dashboard.title'])).toBeTruthy()
  })

  it('shows the empty members notice for a lead-only team', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: { members: [lead], tasks: [makeTask('solo', { status: 'in_progress' })] } } } } })
    render(<TeamDashboard {...b.props} {...tabProps} />)
    expect(screen.getByText(zh['members.empty'])).toBeTruthy()
    const membersSection = screen.getByRole('heading', { name: new RegExp(zh.roster, 'u') }).closest('section')!
    expect(within(membersSection).queryByRole('button', { name: zh['section.expandAll'] })).toBeNull()
  })

  it('surfaces projection failure and navigation errors on the dashboard', () => {
    const b = bench({
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team, failure: 'revision is not contiguous' } } } },
    })
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamDashboard {...b.props} {...b.injected} {...tabProps} />)
    expect(screen.getAllByRole('alert')[0]!.textContent).toContain('revision is not contiguous')
    fireEvent.click(screen.getByRole('button', { name: /worker\(claude\)/u }))
    expect(screen.getAllByRole('alert').some(alert => alert.textContent === 'Error: navigation failed')).toBe(true)
  })

  it('folds member groups and persists the choice for the same team', () => {
    const b = bench({ statuses: new Map([[WORKER, { running: true, pendingInteraction: undefined, completionUnread: false }]]) })
    render(<TeamDashboard {...b.props} {...tabProps} />)
    const runningToggle = within(screen.getByRole('heading', { level: 4, name: new RegExp(zh['dashboard.running'], 'u') }))
      .getByRole('button') as HTMLButtonElement
    const groupSection = screen.getByRole('heading', { level: 4, name: new RegExp(zh['dashboard.running'], 'u') }).closest('section')
    expect(groupSection?.className).toContain('groupSection')
    expect(screen.getByRole('heading', { name: /^成员/u }).closest('section')?.className).not.toContain('groupSection')
    expect(screen.getByRole('button', { name: new RegExp(worker.name, 'u') })).toBeTruthy()
    fireEvent.click(runningToggle)
    expect(screen.queryByRole('button', { name: new RegExp(worker.name, 'u') })).toBeNull()
    expect(runningToggle.getAttribute('aria-expanded')).toBe('false')

    cleanup()
    render(<TeamDashboard {...b.props} {...tabProps} />)
    const remountedToggle = within(screen.getByRole('heading', { level: 4, name: new RegExp(zh['dashboard.running'], 'u') }))
      .getByRole('button') as HTMLButtonElement
    expect(remountedToggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(remountedToggle)
    expect(screen.getByRole('button', { name: new RegExp(worker.name, 'u') })).toBeTruthy()
  })

  it('collapses a whole area and keeps it collapsed across projection updates', () => {
    const b = bench()
    render(<TeamDashboard {...b.props} {...tabProps} />)
    const membersToggle = screen.getByRole('button', { name: /^成员/u })
    fireEvent.click(membersToggle)
    expect(screen.queryByRole('button', { name: new RegExp(worker.name, 'u') })).toBeNull()

    setProjection(b.sessions, SESSION, {
      members: [...team.members, { id: 'worker-b' as SessionId, name: 'worker-b', role: 'teammate', phase: 'active', engine: 'native' }],
      tasks: team.tasks,
    })
    expect(screen.queryByRole('button', { name: new RegExp(worker.name, 'u') })).toBeNull()
    expect((screen.getByRole('button', { name: /^成员/u }).textContent ?? '').replace(/\s+/gu, '')).toContain('成员')
  })

  it('keeps the execution flow collapsed by default and expandable on demand', () => {
    const b = bench()
    render(<TeamDashboard {...b.props} {...tabProps} />)
    const flowToggle = screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') })
    expect(flowToggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Implement runtime/u })).toBeNull()

    fireEvent.click(flowToggle)
    expect(flowToggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /Implement runtime/u })).toBeTruthy()
    expect(readFold('lead', 'flow')).toBe(true)

    cleanup()
    render(<TeamDashboard {...b.props} {...tabProps} />)
    expect(screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') })
      .getAttribute('aria-expanded')).toBe('true')
  })

  it('reveals the matching card from a flow node even when tasks are collapsed', async () => {
    vi.useFakeTimers()
    Element.prototype.scrollIntoView = vi.fn(() => {})
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
      members: [lead, worker],
      tasks: [
        makeTask('done', { status: 'completed', ownerName: 'worker' }),
        makeTask('next', { status: 'pending', ownerName: 'worker' }),
      ],
    } } } } })
    render(<TeamDashboard {...b.props} {...tabProps} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') }))
    const tasksToggle = screen.getByRole('button', { name: new RegExp(zh.tasks, 'u') })
    fireEvent.click(tasksToggle)
    expect(screen.queryByText('Task done')?.closest('article')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Task done/u }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const card = screen.getAllByText('Task done').find(element => element.closest('article'))!
    expect(card.closest('article')!.parentElement!.className).toContain('taskReveal')
    expect(tasksToggle.getAttribute('aria-expanded')).toBe('true')
    expect(readFold('lead', 'tasks')).toBe(true)
    expect(readFold('lead', 'tasks/completed')).toBe(true)
  })

  it('resets the reveal request when the Team root changes', async () => {
    const b = bench()
    const rendered = render(<TeamDashboard {...b.props} {...tabProps} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(zh['flow.title'], 'u') }))
    fireEvent.click(screen.getByRole('button', { name: /Implement runtime/u }))
    await flushReveal()
    expect(readFold('lead', 'tasks/in_progress')).toBe(true)

    const other = bench({ sessionId: 'other' as SessionId, projections: {} })
    rendered.rerender(<TeamDashboard {...other.props} {...tabProps} />)
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
  })
})
