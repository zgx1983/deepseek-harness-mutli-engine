/** Team roster grouped by runtime activity and durable task completion. */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamMemberRow, type TeamActionInjected } from './TeamAction.tsx'
import type { NS } from './locales.ts'
import css from './TeamAction.module.css'
import { EngineSubagents } from './EngineSubagents.tsx'
import { memberStatus } from './member-status.ts'
import { TeamSection } from './TeamSection.tsx'
import { TaskDependencyGraph } from './TaskDependencyGraph.tsx'
import { TaskGroups, type TaskReveal } from './TaskGroups.tsx'
import { useAreaFolds, useFold } from './fold-state.ts'

type DashboardProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & TeamActionInjected
type Group = 'failed' | 'unknown' | 'running' | 'pending' | 'completed' | 'idle' | 'unstarted'
const groups: readonly Group[] = ['failed', 'unknown', 'running', 'pending', 'completed', 'idle', 'unstarted']
/** Member status groups all start expanded; only the completed task group folds by default. */
const MEMBER_GROUP_DEFAULTS: Readonly<Record<Group, boolean>> = {
  failed: true, unknown: true, running: true, pending: true, completed: true, idle: true, unstarted: true,
}

/**
 * Show the root Team while the center displays any continuable member Session.
 * The three Team areas stack as flow graph, members, and tasks; each area and
 * its groups fold independently with Team-scoped preferences.
 * @param props - Session subscriptions, localized copy, and member navigation.
 * @returns Team flow, member groups, task board, or an unavailable notice.
 */
export function TeamDashboard({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, t }: DashboardProps) {
  const root = useSession(state => state.subagent?.address.parentSessionId) ?? sessionId
  const sessions = useSessions(state => state)
  const statuses = useSessionStatus(state => state)
  const children = sessions.projectionsBySession[sessionId]?.values.engineSubagents ?? []
  const team = sessions.projectionsBySession[root]?.values.agentTeam
  const [error, setError] = useState<string | null>(null)
  const [revealState, setRevealState] = useState<{ root: string; reveal?: TaskReveal }>({ root })
  if (revealState.root !== root) setRevealState({ root })
  const flowFolds = useFold(root, 'flow', false)
  const memberFolds = useAreaFolds(root, 'members', MEMBER_GROUP_DEFAULTS)
  if (team === undefined && children.length > 0) return <div className={css.dashboard}><EngineSubagents children={children} t={t} /></div>
  if (team === undefined) return <div className={css.body} role="status">{t('unavailable')}</div>
  const grouped = team.members.filter(member => member.role !== 'lead').map((member) => {
    const running = statuses.get(member.id)?.running ?? sessions.byId[member.id]?.running
    const tasks = team.tasks.filter(task => task.ownerName === member.name && task.status !== 'deleted')
    const status = memberStatus(member, running, tasks)
    const group: Group = status === 'provisioning' ? 'pending' : status
    return { member, tasks, group }
  })
  const renderedGroups = groups.filter(group => grouped.some(item => item.group === group))
  const runningCount = grouped.filter(item => item.group === 'running').length
  return <div className={css.dashboard}>
    {children.length > 0 && <EngineSubagents children={children} t={t} />}
    {error !== null && <div className={css.error} role="alert">{error}</div>}
    {team.failure !== undefined && <div className={css.error} role="alert">{t('failure', { message: team.failure })}</div>}
    <TeamSection title={t('flow.title')} expanded={flowFolds[0]} onToggle={flowFolds[1]}>
      <TaskDependencyGraph tasks={team.tasks} t={t}
        onSelectTask={(taskId) => {
          setRevealState(current => ({ root, reveal: { taskId, nonce: (current.reveal?.nonce ?? 0) + 1 } }))
        }} />
    </TeamSection>
    <TeamSection title={t('roster')} count={grouped.length}
      {...runningCount > 0 ? { summary: [`${t('dashboard.running')} ${runningCount}`] } : {}}
      expanded={memberFolds.areaExpanded} onToggle={memberFolds.setAreaExpanded}
      actions={grouped.length > 0 && <>
        <button type="button" className={css.sectionAction}
          onClick={() => { memberFolds.setAllGroups(true, renderedGroups) }}>{t('section.expandAll')}</button>
        <button type="button" className={css.sectionAction}
          onClick={() => { memberFolds.setAllGroups(false, renderedGroups) }}>{t('section.collapseAll')}</button>
      </>}>
      {grouped.length === 0 ? <p className={css.emptyNotice}>{t('members.empty')}</p>
        : renderedGroups.map(group => <TeamSection key={group} level="group" title={t(`dashboard.${group}`)}
          count={grouped.filter(item => item.group === group).length}
          expanded={memberFolds.groupExpanded(group)}
          onToggle={(expanded) => { memberFolds.setGroupExpanded(group, expanded) }}>
          <div className={css.memberGrid}>{grouped.filter(item => item.group === group).map(item => <div key={item.member.id}>
            <TeamMemberRow member={item.member} tasks={item.tasks} memberCount={team.members.length} sessionId={sessionId}
              useSessions={useSessions} useSessionStatus={useSessionStatus} openTeammate={openTeammate} onError={setError} t={t} />
          </div>)}</div>
        </TeamSection>)}
    </TeamSection>
    <TaskGroups teamId={root} tasks={team.tasks} sessionId={sessionId} members={team.members}
      openTeammate={openTeammate} onError={setError}
      {...revealState.reveal === undefined ? {} : { reveal: revealState.reveal }} t={t} />
  </div>
}

/**
 * Render the localized Team tab label with its roster icon.
 * @param props - Locale supplied by the tab slot.
 * @returns Team icon and title.
 */
export function TeamDashboardTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<typeof NS>) {
  return <><IconUsersOutlineRegular size={16} />{t('dashboard.title')}</>
}
