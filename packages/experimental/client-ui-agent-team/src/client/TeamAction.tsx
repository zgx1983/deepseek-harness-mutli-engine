import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection,
  TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import {
  IconChevronDownOutlineRegular,
  IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, Tag, Tooltip,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'
import { TaskTiming } from './TaskTiming.tsx'
import { MemberCard } from './Roster.tsx'
import { EngineSubagents } from './EngineSubagents.tsx'
import { memberStatus, type TeamMemberStatus } from './member-status.ts'
import { taskDotState, taskStatusKey } from './task-flow.ts'
import { TeamSection } from './TeamSection.tsx'
import { TaskGroups } from './TaskGroups.tsx'
import { useAreaFolds } from './fold-state.ts'

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Open the Team dashboard for this conversation. */
  openDashboard: (sessionId: SessionId) => void
  /** Open a roster Session from the current conversation. */
  openTeammate: (sessionId: SessionId, childSessionId: SessionId) => void
}

/** Durable lifecycle overlaid with the member Session's live turn activity. */
type MemberStatus = TeamMemberStatus

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & TeamActionInjected & PropsLocale<typeof NS>

function memberStatusKey(status: MemberStatus): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'dashboard.idle'
    case 'unstarted': return 'memberStatus.inactive'
    case 'pending': return 'dashboard.pending'
    case 'completed': return 'dashboard.completed'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
    case 'unknown': return 'memberStatus.unknown'
  }
}

function memberDotState(status: MemberStatus): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning': return 'ongoing'
    case 'failed': return 'error'
    case 'unknown': return 'warning'
    case 'completed': return 'done'
    case 'pending':
    case 'idle':
    case 'unstarted': return 'idle'
  }
}

type TeamMemberRowProps = Pick<TeamActionProps,
  'sessionId' | 'useSessions' | 'useSessionStatus' | 'openTeammate' | 't'
> & {
  member: TeamMemberProjection
  memberCount: number
  tasks: readonly TeamTask[]
  onError: (message: string) => void
}

/**
 * Render a navigable Team member using shared Session activity.
 * @param props - Member projection, subscriptions, navigation, and copy.
 * @returns Member identity, activity, and diagnostic details.
 */
export function TeamMemberRow({
  member, memberCount, tasks, sessionId, useSessions, useSessionStatus, openTeammate, onError, t,
}: TeamMemberRowProps) {
  const model = useSessions(state => state.projectionsBySession[member.id]?.values.modelSelection?.next?.model)
  const running = useSessionStatus(state => state.get(member.id)?.running)
  const summaryRunning = useSessions(state => state.byId[member.id]?.running)
  const activity = running ?? summaryRunning
  const status = memberStatus(member, activity, tasks)
  const isCurrent = member.id === sessionId
  const highlightCurrent = isCurrent && memberCount > 1
  const inert = isCurrent || status === 'failed' || status === 'provisioning'

  return (
    <Tooltip label={t('open')} side="bottom" gap={4} disabled={inert}>
      <MemberCard disabled={inert} current={highlightCurrent}
        onClick={() => { try { openTeammate(sessionId, member.id) } catch (reason) { onError(String(reason)) } }}
        marker={status === 'unstarted' || status === 'idle'
          ? <IconUserOutlineRegular size={14} className={css.inactiveIcon} /> : <StateDot state={memberDotState(status)} />}
        title={<><span className={css.memberNameText}>{member.name}</span>
          <span className={css.memberEngine}>({member.engine})</span>
          {isCurrent && <Tag tone="info" className={css.currentTag}>{t('current')}</Tag>}</>}>
        <small>{t(memberStatusKey(status))}{model !== undefined
          && <span className={css.memberModel}>{` · ${t('model')}: ${model}`}</span>}</small>
        {member.error !== undefined && <small className={css.diagnostic}>{member.error}</small>}
      </MemberCard>
    </Tooltip>
  )
}

/** Task card with a one-line description clamp expanded from a toggle above the description. */
export function TaskCard({ task, t, onOpenOwner }: {
  task: TeamTask
  t: TranslateNS<typeof NS>
  /** Opens the owning member's Session; undefined keeps the owner as plain text. */
  readonly onOpenOwner?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(taskStatusKey(task.status))}</span>
        </span>
      </div>
      <div className={css.descriptionControls}>
        {(clamped || expanded) && (
          <button
            type="button"
            className={css.expandToggle}
            aria-expanded={expanded}
            onClick={() => { setExpanded(current => !current) }}
          >
            {t(expanded ? 'task.collapse' : 'task.expand')}
            <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandToggleOpen : undefined} />
          </button>
        )}
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      <div className={css.meta}>
        <TaskTiming startedAt={task.startedAt} endedAt={task.endedAt} running={task.status === 'in_progress'} t={t} />
        <span>{task.id}</span>
        {task.ownerName === undefined || onOpenOwner === undefined
          ? <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
          : <button type="button" className={css.ownerLink} aria-label={`${t('open')}: ${task.ownerName}`}
            onClick={onOpenOwner}>{t('owner')}: {task.ownerName}</button>}
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
        {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
      </div>
    </article>
  )
}

/** Render the Team roster and read-only task board. */
export function TeamAction({
  sessionId, useSession, useSessions, useSessionStatus, openTeammate, openDashboard, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  const leadSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  const children = useSessions(state => state.projectionsBySession[sessionId]?.values.engineSubagents)
  const team = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeam)
  const harnessChildCount = useSessions((state) => {
    const catalog = state.projectionsBySession[leadSessionId]
    return catalog?.values.subagentCatalog?.length ?? 0
  })
  const opening = useSession(snapshot => snapshot.openState === 'loading')
  const listing = useSessions(state => state.phase === 'pending')
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const cancelHoverChange = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => {
    cancelHoverChange()
    pinnedRef.current = false
    setOpen(false)
    setError(null)
  }, [sessionId])

  useEffect(() => cancelHoverChange, [])

  useLayoutEffect(() => {
    if (open && positioned && pinnedRef.current) panelRef.current?.focus()
  }, [open, positioned])

  const changeOpen = (next: boolean): void => {
    cancelHoverChange()
    if (!next) pinnedRef.current = false
    setOpen(next)
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverChange()
    if (open) return
    const label = triggerLabelRef.current
    /* v8 ignore next -- the label mounts with the trigger that received the hover. */
    if (label === null) return
    // Icon-only trigger (label collapsed by the header container query):
    // hover-open would surprise on such a small target, so only click opens.
    if (getComputedStyle(label).display === 'none') return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverChange()
    if (pinnedRef.current) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  useDismissOnOutsidePointer(rootRef, open, changeOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelHoverChange()
      pinnedRef.current = false
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  const childCount = (children?.length ?? 0) + harnessChildCount
  const trigger = childCount > 0 ? t('engine.trigger', { count: childCount }) : t('trigger')
  const compact = team !== undefined && team.members.length === 1 && team.tasks.length === 0
  const memberFolds = useAreaFolds(leadSessionId, 'members', {})

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-team-action
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        className={css.trigger}
        aria-label={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          cancelHoverChange()
          pinnedRef.current = true
          if (!open) changeOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconUsersOutlineRegular size={14} />
        <span ref={triggerLabelRef} className={css.triggerLabel}>{trigger}</span>
        <IconChevronDownOutlineRegular size={14} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={compact ? `${css.panel} ${css.panelCompact}` : css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={trigger}
          data-team-panel
          onMouseEnter={cancelHoverChange}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.body}>
            <button type="button" className={css.trigger} onClick={() => { openDashboard(sessionId); changeOpen(false) }}>{t('dashboard.open')}</button>
            {error !== null && (
              <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
            )}
            {children !== undefined && children.length > 0 && <EngineSubagents children={children} t={t} />}
            {team === undefined && (children?.length ?? 0) === 0 && (
              <div className={css.notice} role="status">
                <StateDot state={opening || listing ? 'ongoing' : 'warning'} />
                {t(opening || listing ? 'loading' : 'unavailable')}
              </div>
            )}
            {team !== undefined && (
              <>
                {team.failure !== undefined && (
                  <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
                )}
                <TeamSection title={t('roster')} {...team.members.length > 1 ? { count: team.members.length } : {}}
                  expanded={memberFolds.areaExpanded} onToggle={memberFolds.setAreaExpanded}>
                  <div className={css.roster}>
                    {team.members.map(member => (
                      <TeamMemberRow
                        key={member.id}
                        member={member}
                        memberCount={team.members.length}
                        tasks={team.tasks.filter(task => task.ownerName === member.name && task.status !== 'deleted')}
                        sessionId={sessionId}
                        useSessions={useSessions}
                        useSessionStatus={useSessionStatus}
                        openTeammate={openTeammate}
                        onError={setError}
                        t={t}
                      />
                    ))}
                  </div>
                </TeamSection>
                <TaskGroups teamId={leadSessionId} tasks={team.tasks} sessionId={sessionId}
                  members={team.members} openTeammate={openTeammate} onError={setError} t={t} />
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
