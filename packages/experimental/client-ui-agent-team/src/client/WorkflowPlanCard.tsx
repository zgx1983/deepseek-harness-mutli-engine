/** Conversation card rendering the task dependency graph of a created workflow. */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { TaskFlowCanvas } from './TaskFlowCanvas.tsx'
import { fitViewport, layoutTaskGraph, type Viewport } from './task-flow.ts'
import css from './TeamAction.module.css'

/** Full keyed Chat renderer props of one workflow plan card. */
export type WorkflowPlanCardProps =
  PropsRuntime<'conversation.chat.node', 'team-workflow'>
  & PropsLocale<typeof NS>

/**
 * Render the submitted workflow's dependency graph inline in the conversation:
 * creation order fixes the layout, every edge stays neutral, and statuses stay
 * on the Team dashboard's live flow graph.
 * @param props - The typed Chat node, Session currency, and localized copy.
 * @returns The plan heading, fitted flow canvas, and caption.
 */
export function WorkflowPlanCard({ node, t }: WorkflowPlanCardProps) {
  const plan = node.data
  const layout = useMemo(() => layoutTaskGraph(plan.tasks), [plan])
  const subjects = useMemo(() => new Map(plan.tasks.map(task => [task.id, task.subject])), [plan])
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })

  /* Fit once per layout; the card canvas has no pan or zoom controls. */
  useLayoutEffect(() => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width === 0 || bounds.height === 0) return
    setViewport(fitViewport(bounds, layout.width, layout.height))
  }, [layout])

  return <section className={css.workflowCard} data-team-workflow>
    <p className={css.workflowCardTitle}>
      {t('workflow.title')}
      <span>{t('workflow.summary', { name: plan.name, count: plan.tasks.length })}</span>
    </p>
    <div ref={containerRef} className={css.flowCanvas}>
      <TaskFlowCanvas layout={layout} viewport={viewport}
        ariaLabel={t('workflow.summary', { name: plan.name, count: plan.tasks.length })}
        missingLabel={t('flow.missingTask')}
        svgClassName={css.flowSvgStatic}
        edgeClassName={() => css.flowEdge}
        edgeTitle={edge => `${subjects.get(edge.from) ?? edge.from} → ${subjects.get(edge.to) ?? edge.to}`}
        nodeAriaLabel={task => `${task.subject}, ${task.id}`}
        renderNodeMeta={task => <><StateDot state="idle" size={8} />{task.id}</>} />
    </div>
    <p className={css.flowDetail}>{t('workflow.caption')}</p>
  </section>
}
