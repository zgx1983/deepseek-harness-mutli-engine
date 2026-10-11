/** Read-only task dependency flow graph for the Team dashboard. */
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { TeamTaskId, TeamTaskView as TeamTask } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { IconFullscreenOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import {
  fitViewport, GRAPH_MAX_SCALE, GRAPH_MIN_SCALE, layoutTaskGraph, taskDotState, taskStatusKey,
  type Viewport,
} from './task-flow.ts'
import { TaskFlowCanvas } from './TaskFlowCanvas.tsx'
import css from './TeamAction.module.css'

const ZOOM_STEP = 1.25
const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 }

/** Read-only flow graph: one node per non-deleted task, one arrow per prerequisite. */
export interface TaskDependencyGraphProps {
  readonly tasks: readonly TeamTask[]
  /** Fired on node activation to reveal the matching task card; never mutates tasks. */
  readonly onSelectTask?: (taskId: TeamTaskId) => void
  readonly t: TranslateNS<typeof NS>
}

/**
 * Render the layered task flow with fit, zoom, pan, and fullscreen viewing.
 * Layout reruns only when the node set or dependencies change; status and
 * owner updates rewrite node content in place and keep the viewport.
 * @param props - Current task board, selection callback, and copy.
 * @returns The graph canvas, viewing controls, legend, and selection detail.
 */
export function TaskDependencyGraph({ tasks, onSelectTask, t }: TaskDependencyGraphProps) {
  // Layering keys on structure only: status and owner changes must not rearrange nodes.
  const structure = tasks.map(task => `${task.id}:${task.blockedBy.join(',')}`).join('|')
  const layout = useMemo(() => layoutTaskGraph(tasks), [structure])
  const subjects = new Map(tasks.map(task => [task.id, task.subject]))
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>(IDENTITY)
  const [selected, setSelected] = useState<TeamTaskId | undefined>(undefined)
  const pan = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | undefined>(undefined)
  const dragged = useRef(false)

  const fit = (): void => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return
    setViewport(fitViewport(bounds, layout.width, layout.height))
  }

  /* Fit once at mount; live updates and re-layouts keep the user's viewport. */
  useLayoutEffect(() => { fit() }, [])

  const zoomBy = (factor: number): void => {
    setViewport(current => ({
      ...current,
      scale: Math.min(GRAPH_MAX_SCALE, Math.max(GRAPH_MIN_SCALE, current.scale * factor)),
    }))
  }

  const toggleFullscreen = async (): Promise<void> => {
    const container = containerRef.current
    /* v8 ignore next 3 -- the toggle mounts only beside the canvas it controls. */
    if (container === null) return
    /* jsdom (the unit lane) implements no Fullscreen API despite lib.dom's typing. */
    const request = (container as { requestFullscreen?: () => Promise<void> }).requestFullscreen?.bind(container)
    if (request === undefined) return
    try {
      await request()
    } catch {
      /* Fullscreen denial leaves the inline canvas in place. */
    }
  }

  const startPan = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    dragged.current = false
    pan.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: viewport.x, originY: viewport.y }
  }

  const movePan = (event: PointerEvent<SVGSVGElement>): void => {
    const current = pan.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    const deltaX = event.clientX - current.startX
    const deltaY = event.clientY - current.startY
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) dragged.current = true
    setViewport(view => ({ ...view, x: current.originX + deltaX, y: current.originY + deltaY }))
  }

  /* A drag release is followed by a click on the press target; the flag
     suppresses that one activation and clears on the next macrotask. */
  const clearDragged = (): void => { dragged.current = false }

  const endPan = (event: PointerEvent<SVGSVGElement>): void => {
    if (pan.current?.pointerId !== event.pointerId) return
    pan.current = undefined
    setTimeout(clearDragged, 0)
  }

  const activate = (taskId: TeamTaskId): void => {
    if (dragged.current) return
    setSelected(taskId)
    onSelectTask?.(taskId)
  }

  const selectedTask = selected === undefined ? undefined : tasks.find(task => task.id === selected)
  const prerequisites = selectedTask?.blockedBy.map(id => subjects.get(id) ?? t('flow.missingTask')) ?? []
  const successors = selectedTask === undefined ? []
    : tasks.filter(task => task.blockedBy.includes(selectedTask.id)).map(task => task.subject)
  const edgeSubject = (id: TeamTaskId): string => subjects.get(id) ?? id

  if (tasks.length === 0) return <p className={css.emptyNotice}>{t('flow.empty')}</p>

  return <div className={css.flow}>
    <div className={css.flowControls}>
      <button type="button" className={css.sectionAction} onClick={fit}>{t('flow.fit')}</button>
      <button type="button" className={css.sectionAction} onClick={() => { zoomBy(ZOOM_STEP) }}>{t('flow.zoomIn')}</button>
      <button type="button" className={css.sectionAction} onClick={() => { zoomBy(1 / ZOOM_STEP) }}>{t('flow.zoomOut')}</button>
      <button type="button" className={css.sectionAction} onClick={() => { void toggleFullscreen() }}>
        <IconFullscreenOutlineRegular size={12} aria-hidden />{t('flow.fullscreen')}
      </button>
    </div>
    {layout.cyclic && <p className={css.warning} role="note">{t('flow.cyclic')}</p>}
    <div ref={containerRef} className={css.flowCanvas}>
      <TaskFlowCanvas layout={layout} viewport={viewport}
        ariaLabel={t('flow.title')} missingLabel={t('flow.missingTask')}
        svgClassName={css.flowSvg}
        svgProps={{ onPointerDown: startPan, onPointerMove: movePan, onPointerUp: endPan, onPointerCancel: endPan }}
        edgeClassName={edge => edge.satisfied ? css.flowEdge : `${css.flowEdge} ${css.flowEdgeBlocked}`}
        edgeTitle={edge => `${edgeSubject(edge.from)} → ${edgeSubject(edge.to)}: ${t(edge.satisfied ? 'flow.legend.satisfied' : 'flow.legend.blocked')}`}
        nodeClassName={task => task.id === selected ? css.flowNodeSelected : css.flowNode}
        nodeAriaLabel={task => `${task.subject}, ${t(taskStatusKey(task.status))}, ${task.id}, ${t('owner')}: ${task.ownerName ?? t('unowned')}`}
        renderNodeMeta={task => <>
          <StateDot state={taskDotState(task)} size={8} />
          {t(taskStatusKey(task.status))} · {task.id} · {task.ownerName ?? t('unowned')}
        </>}
        onNodeActivate={activate} />
    </div>
    <p className={css.flowLegend}>
      <span className={css.flowLegendItem}><svg width="24" height="8" aria-hidden><path d="M0,4 H24" className={css.flowEdge} /></svg>{t('flow.legend.satisfied')}</span>
      <span className={css.flowLegendItem}><svg width="24" height="8" aria-hidden><path d="M0,4 H24" className={`${css.flowEdge} ${css.flowEdgeBlocked}`} /></svg>{t('flow.legend.blocked')}</span>
      <span className={`${css.flowLegendItem} ${css.flowLegendMissing}`}>{t('flow.legend.missing')}</span>
    </p>
    {selectedTask !== undefined && (prerequisites.length > 0 || successors.length > 0) && (
      <p className={css.flowDetail}>
        {prerequisites.length > 0 && <>{t('flow.prereqs')}: {prerequisites.join(', ')} </>}
        {successors.length > 0 && <>{t('flow.successors')}: {successors.join(', ')}</>}
      </p>
    )}
  </div>
}
