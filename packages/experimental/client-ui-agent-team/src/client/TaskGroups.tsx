/** Foldable task board area shared by the Team dashboard and the header panel. */
import { useEffect, useRef, useState } from 'react'
import type {
  TeamMemberProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useAreaFolds } from './fold-state.ts'
import { NS } from './locales.ts'
import { TeamSection } from './TeamSection.tsx'
import { TaskCard } from './TeamAction.tsx'
import { groupTasks, ownerMember, type TaskGroupKey } from './task-flow.ts'
import css from './TeamAction.module.css'

/** Default fold of each task group: finished work collapses, active work stays visible. */
const GROUP_DEFAULTS: Readonly<Record<TaskGroupKey, boolean>> = { in_progress: true, pending: true, completed: false }

/** One reveal request: which task card to surface and which click issued it. */
export interface TaskReveal {
  readonly taskId: TeamTaskId
  /** Increments per selection so repeating a node click re-runs the reveal. */
  readonly nonce: number
}

/** Highlight removal delay after a graph-node reveal. */
const REVEAL_HIGHLIGHT_MS = 2400

/** Task board area: execution groups with independent folds and bounded scrolling. */
export interface TaskGroupsProps {
  /** Team root Session id scoping stored folds. */
  readonly teamId: string
  readonly tasks: readonly TeamTask[]
  /** Pending reveal from a flow-graph node selection. */
  readonly reveal?: TaskReveal
  /** Current conversation; owners resolved to it stay plain text. */
  readonly sessionId?: SessionId
  /** Current roster backing owner-to-member navigation. */
  readonly members?: readonly TeamMemberProjection[]
  /** Opens a member Session from the current conversation. */
  readonly openTeammate?: (sessionId: SessionId, childSessionId: SessionId) => void
  /** Reports member-navigation failures beside the board. */
  readonly onError?: (message: string) => void
  readonly t: TranslateNS<typeof NS>
}

/**
 * Build one card's owner navigation. Owners resolve through the unique roster
 * name; the current conversation and members that are not durably active stay
 * plain text, mirroring the roster row rules.
 * @param props - The board props carrying navigation inputs.
 * @param task - The card's task view.
 * @returns the open callback, or undefined when the owner is not navigable.
 */
function ownerNavigation(props: TaskGroupsProps, task: TeamTask): (() => void) | undefined {
  const { sessionId, members, openTeammate, onError } = props
  if (sessionId === undefined || openTeammate === undefined) return undefined
  const owner = ownerMember(task.ownerName, members ?? [])
  if (owner === undefined || owner.id === sessionId || owner.phase !== 'active') return undefined
  return () => {
    try { openTeammate(sessionId, owner.id) }
    catch (reason) { onError?.(String(reason)) }
  }
}

/**
 * Render the folded task area: running, runnable, and completed groups.
 * Counts always reflect the whole board. A reveal expands the tasks area and
 * the group holding the task, scrolls the card into view, and highlights it.
 * @param props - Team identity, task board, reveal request, and copy.
 * @returns The collapsible task area.
 */
export function TaskGroups(props: TaskGroupsProps) {
  const { teamId, tasks, reveal, t } = props
  const folds = useAreaFolds(teamId, 'tasks', GROUP_DEFAULTS)
  const grouping = groupTasks(tasks)
  const groupItems: readonly (readonly [TaskGroupKey, readonly TeamTask[]])[] = [
    ['in_progress', grouping.inProgress], ['pending', grouping.pending], ['completed', grouping.completed],
  ]
  const rendered = groupItems.filter(([, items]) => items.length > 0)
  const cardRefs = useRef(new Map<TeamTaskId, HTMLElement>())
  const [highlight, setHighlight] = useState<TeamTaskId | undefined>(undefined)
  const revealGroup = reveal === undefined
    ? undefined
    : rendered.find(([, items]) => items.some(task => task.id === reveal.taskId))?.[0]

  useEffect(() => {
    if (reveal === undefined || revealGroup === undefined) return
    folds.setAreaExpanded(true)
    folds.setGroupExpanded(revealGroup, true)
    // The expanded body mounts in the next commit; reveal it from that frame.
    const frame = setTimeout(() => {
      const card = cardRefs.current.get(reveal.taskId)
      if (typeof card?.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' })
      setHighlight(reveal.taskId)
    }, 0)
    const clear = setTimeout(() => { setHighlight(undefined) }, REVEAL_HIGHLIGHT_MS)
    return () => { clearTimeout(frame); clearTimeout(clear) }
  }, [reveal, revealGroup, folds.setAreaExpanded, folds.setGroupExpanded])

  const summary = [
    grouping.inProgress.length > 0 ? `${t('taskGroup.in_progress')} ${grouping.inProgress.length}` : undefined,
    grouping.waitingDependency > 0 ? `${t('flow.waitingDependency')} ${grouping.waitingDependency}` : undefined,
    grouping.completed.length > 0 ? `${t('taskGroup.completed')} ${grouping.completed.length}` : undefined,
  ].filter(segment => segment !== undefined)

  return <TeamSection title={t('tasks')} count={tasks.length} summary={summary}
    expanded={folds.areaExpanded} onToggle={folds.setAreaExpanded}
    actions={tasks.length > 0 && <>
      <button type="button" className={css.sectionAction}
        onClick={() => { folds.setAllGroups(true, rendered.map(([key]) => key)) }}>{t('section.expandAll')}</button>
      <button type="button" className={css.sectionAction}
        onClick={() => { folds.setAllGroups(false, rendered.map(([key]) => key)) }}>{t('section.collapseAll')}</button>
    </>}>
    {tasks.length === 0 ? <p className={css.emptyNotice}>{t('empty')}</p> : <div className={css.taskScroll}>
      {rendered.map(([group, items]) => <TeamSection key={group} level="group" title={t(`taskGroup.${group}`)}
        count={items.length} expanded={folds.groupExpanded(group)}
        onToggle={(expanded) => { folds.setGroupExpanded(group, expanded) }}>
        {items.map((task) => {
          const navigation = ownerNavigation(props, task)
          return <div key={task.id}
            ref={(element) => { if (element === null) cardRefs.current.delete(task.id); else cardRefs.current.set(task.id, element) }}
            className={highlight === task.id ? css.taskReveal : undefined}>
            <TaskCard task={task} t={t}
              {...navigation === undefined ? {} : { onOpenOwner: navigation }} />
          </div>
        })}
      </TeamSection>)}
    </div>}
  </TeamSection>
}
