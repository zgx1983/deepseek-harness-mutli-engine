/**
 * Recent-list derivation: one pure projection over the Session Controller
 * list, the live Session UI status, and the registry archive set. A session
 * qualifies exactly once, under its highest-priority reason — unread (a
 * pending interaction or an unviewed completion) first, then running, then
 * updated today — and each bucket orders by last update, newest first, with
 * session id as the deterministic tie-break. Blank (provisional New Session),
 * archived, and subagent rows never qualify: a delegated child's only entry
 * is the parent conversation's subagent panel. Sessions hidden from the
 * catalog — such as the personal assistant's resident conversation — never
 * appear because the exclusion already removes them from the projected list;
 * the assistant's task execution Sessions qualify normally and display their
 * title without the pinned ` · 个人助理` suffix.
 * Each row carries its owning Workspace title when one accounts for the session.
 */

/** Sessions shown while the overflow control is collapsed. */
export const RECENT_VISIBLE_LIMIT = 7

/**
 * Personal Assistant task executions pin their Session title with this suffix
 * (dsh-personal-assistant runtime startTask chain); the list drops it for
 * display — the task title stands alone.
 */
const ASSISTANT_TITLE_SUFFIX = /\s*·\s*个人助理$/

/** Narrow the interaction kind to the vocabulary this section labels. */
function pendingKindOf(kind) {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

/** Same calendar day in the host's local time zone; epoch 0 never reads as today. */
function isSameLocalDay(at, now) {
  const day = new Date(at)
  const current = new Date(now)
  return day.getFullYear() === current.getFullYear()
    && day.getMonth() === current.getMonth()
    && day.getDate() === current.getDate()
}

/** Bucket order: newest first, session id as the deterministic tie-break. */
function byRecency(a, b) {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/**
 * Project the Recent list.
 * @param input - authoritative snapshot reads: list, statuses, workspaces, archive set, selection, and clock.
 * @param limit - sessions shown while the overflow control is collapsed.
 * @returns qualifying rows in priority order plus the collapsed hidden count.
 */
export function deriveRecentSessions(input, limit = RECENT_VISIBLE_LIMIT) {
  const buckets = { unread: [], running: [], today: [] }
  for (const id of input.list.ids) {
    const summary = input.list.byId[id]
    if (summary === undefined || summary.blank || summary.origin === 'subagent'
      || input.archived.has(id)) continue
    const status = input.statuses.get(id)
    const pendingKind = pendingKindOf(status?.pendingInteraction?.kind)
    const running = status?.running ?? summary.running
    const workspace = input.workspaces.items.find(item => item.sessionIds.includes(id))
    const row = {
      id,
      displayTitle: summary.displayTitle.replace(ASSISTANT_TITLE_SUFFIX, ''),
      projectTitle: workspace?.title,
      reason: 'today',
      dot: undefined,
      pendingKind: undefined,
      updatedAt: summary.updatedAt,
      selected: id === input.currentId,
    }
    if (status?.pendingInteraction !== undefined) {
      buckets.unread.push({ ...row, reason: 'unread', dot: 'warning', ...(pendingKind === undefined ? {} : { pendingKind }) })
    } else if (status?.completionUnread === true) {
      buckets.unread.push({ ...row, reason: 'unread', dot: 'done' })
    } else if (running) {
      buckets.running.push({ ...row, reason: 'running', dot: 'ongoing' })
    } else if (isSameLocalDay(summary.updatedAt, input.now)) {
      buckets.today.push(row)
    }
  }
  const rows = [...buckets.unread.sort(byRecency), ...buckets.running.sort(byRecency), ...buckets.today.sort(byRecency)]
  return { rows, hiddenCount: Math.max(0, rows.length - limit) }
}
