/** Sidebar Recent section: unread, running, and today's sessions above the Workspace browser. */
import * as React from 'react'
import { IconTriangleRightFillRegular, relativeTime, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { deriveRecentSessions, RECENT_VISIBLE_LIMIT } from './recent.js'
import { NS, zh, en } from './locales.js'
import { CSS } from './css.js'

export const inject = ['slots', 'locale', 'uiWorkspace']

/**
 * Register the Recent section once the shell's slot declaration is on the ledger.
 * @param ctx - Client context with the slot registry, locale, and workspace navigation services.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-recent-sessions: dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.recentSessions = ''
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'ui-recent-sessions: styles')
  ctx.slots.inject('sidebar.recent', () => ctx.slots.register(
    {
      name: 'sidebar.recent',
      inject: () => ({
        openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
      }),
      locale: NS,
    },
    RecentSessions,
  ))
}

/** Localized compact relative time ("刚刚"/"5min"), the Workspace row's form. */
function timeLabel(updatedAt, now, t) {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Trailing screen-reader status for a dot row; plain today rows carry none. */
function statusLabel(row, t) {
  if (row.pendingKind !== undefined) return t(`status.pending.${row.pendingKind}`)
  if (row.dot === 'done') return t('status.completed')
  if (row.dot === 'ongoing') return t('status.running')
  return undefined
}

/** Main-view selection fact, or nothing while a non-conversation panel leads. */
function mainSessionId(list) {
  return Object.values(list.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** One 32px session row: leading 16px dot cell, title, and the compact pending label or relative time. */
function RecentRow({ row, now, onOpen, t }) {
  const label = statusLabel(row, t)
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={row.selected}
      className={`rs-row${row.selected ? ' rs-row-selected' : ''}`}
      data-row-key={`recent:${row.id}`}
      onClick={() => { onOpen(row.id) }}
    >
      <span className="rs-dot-cell" aria-hidden="true">
        {row.dot !== undefined && <StateDot state={row.dot} />}
      </span>
      <span className="rs-title">
        {row.projectTitle !== undefined
          ? <><span className="rs-project">{row.projectTitle}</span>/{row.displayTitle}</>
          : row.displayTitle}
      </span>
      <span className="rs-trailing">{label ?? timeLabel(row.updatedAt, now, t)}</span>
    </button>
  )
}

/**
 * Render the Recent section.
 * @param props - owner share, standard hooks, the open action, and the locale seat.
 * @returns the section, or nothing on the rail or while no session qualifies.
 */
function RecentSessions({ wide, useSessions, useSessionStatus, useWorkspaces, usePanelInfo, openSession, t }) {
  const [sectionOpen, setSectionOpen] = React.useState(true)
  const [showAll, setShowAll] = React.useState(false)
  const list = useSessions(state => state)
  const statuses = useSessionStatus(state => state)
  const workspaces = useWorkspaces(state => state)
  const panelActive = usePanelInfo(info => info.activePanelId !== null)
  const now = Date.now()
  const projection = deriveRecentSessions({
    list,
    statuses,
    workspaces,
    archived: new Set(workspaces.archivedSessionIds),
    currentId: panelActive ? undefined : mainSessionId(list),
    now,
  })
  if (!wide || projection.rows.length === 0) return null
  const visible = showAll ? projection.rows : projection.rows.slice(0, RECENT_VISIBLE_LIMIT)
  return (
    <div className="rs-section" role="tree" aria-label={t('section.title')}>
      <button
        type="button"
        role="treeitem"
        aria-expanded={sectionOpen}
        className="rs-header"
        data-row-key="recent:section"
        onClick={() => { setSectionOpen(open => !open) }}
      >
        <span className="rs-chevron" aria-hidden="true">
          <IconTriangleRightFillRegular className={`rs-arrow${sectionOpen ? ' rs-arrow-open' : ''}`} />
        </span>
        <span className="rs-title">{t('section.title')}</span>
      </button>
      {sectionOpen && visible.map(row => (
        <RecentRow key={row.id} row={row} now={now} onOpen={openSession} t={t} />
      ))}
      {sectionOpen && projection.hiddenCount > 0 && (
        <button
          type="button"
          className="rs-overflow"
          aria-expanded={showAll}
          data-row-key="recent:overflow"
          onClick={() => { setShowAll(all => !all) }}
        >
          {showAll ? t('sessions.collapse') : t('sessions.expand', { n: projection.hiddenCount })}
        </button>
      )}
    </div>
  )
}
