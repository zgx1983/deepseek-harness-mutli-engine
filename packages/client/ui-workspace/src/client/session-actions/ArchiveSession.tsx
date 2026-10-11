/**
 * The archive action: a `sidebar.workspaces.session.menu.item` row and a
 * `sidebar.workspaces.session.row.action` button over one injected behavior,
 * plus the `shell.overlay` dialog that confirms stopping a Session's running
 * work before archiving it. The same entries restore an archived row; the
 * notice a successful archive raises and the diagnostics for Host rejections
 * live in the injected callbacks, not here.
 */
import { useState } from 'react'
import type { SessionActivity } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the family keys each provider merges; a key this program did not compile takes the generic line.
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-jobs/view'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import {
  Button, IconArchiveOutlineRegular, IconUnarchiveOutlineRegular, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ArchiveSessionInjected, SessionArchiveConfirmInjected, SessionArchiveConfirmProps, SessionArchiveConfirmRequest,
  SessionMenuItemProps, SessionRowActionProps,
} from '../contract/slots.ts'
import css from '../rows/Rows.module.css'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 400): archive, or restore an archived row.
 * @param props - owner share, the archive share, and the menu open state.
 * @returns the row.
 */
export function ArchiveSessionMenuItem({
  sessionId, useArchived, useMenuOpenState, useShortcuts, archiveSession, unarchiveSession, t,
}: SessionMenuItemProps<ArchiveSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'session.archive'))
  const archived = useArchived(set => set.has(sessionId))
  return (
    <MenuItemButton
      shortcut={archived ? undefined : shortcut}
      icon={archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        ;(archived ? unarchiveSession : archiveSession)(sessionId)
      }}
    >
      {t(archived ? 'menu.unarchiveSession' : 'menu.archiveSession')}
    </MenuItemButton>
  )
}

/**
 * Hover button (order 100): archive, or restore an archived row.
 * @param props - owner share and the archive share.
 * @returns the button.
 */
export function ArchiveSessionRowButton({
  sessionId, useArchived, archiveSession, unarchiveSession, t,
}: SessionRowActionProps<ArchiveSessionInjected>) {
  const archived = useArchived(set => set.has(sessionId))
  return (
    <Tooltip label={t(archived ? 'actions.unarchive' : 'actions.archive')} side="bottom" align="end" delayMs={500}>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t(archived ? 'menu.unarchiveSession' : 'menu.archiveSession')}
        onClick={() => { (archived ? unarchiveSession : archiveSession)(sessionId) }}
      >
        {archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session). Confirming archives
 * the Session; summary requests close immediately and continue in the
 * background. Active work requires a stop-and-archive confirmation.
 * @param props - the request hook, its settlement, the stop-and-archive hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionArchiveConfirmDialog({
  useArchiveRequest, settleSessionArchive, confirmArchiveSession, t,
}: SessionArchiveConfirmProps) {
  const request = useArchiveRequest(pending => pending)
  if (request === null) return null
  return (
    <ArchiveConfirmForm
      key={request.sessionId}
      request={request}
      confirmArchiveSession={confirmArchiveSession}
      onSettle={settleSessionArchive}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function ArchiveConfirmForm({ request, confirmArchiveSession, onSettle, t }: {
  request: SessionArchiveConfirmRequest
  confirmArchiveSession: SessionArchiveConfirmInjected['confirmArchiveSession']
  onSettle: () => void
  t: SessionArchiveConfirmProps['t']
}) {
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summarize, setSummarize] = useState(request.summarizeToChangelog ?? false)
  const close = () => {
    if (archiving) return
    onSettle()
  }
  const confirm = () => {
    if (summarize) {
      void confirmArchiveSession(request.sessionId, {
        stopActivity: request.activity.length > 0,
        summarizeToChangelog: true,
      })
      onSettle()
      return
    }
    setArchiving(true)
    setError(null)
    confirmArchiveSession(request.sessionId, {
      stopActivity: request.activity.length > 0,
      summarizeToChangelog: summarize,
    }).then(archived => {
      setArchiving(false)
      if (archived) onSettle()
    }).catch((reason: unknown) => {
      setArchiving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t(request.activity.length > 0 ? 'archive.confirm.activeTitle' : 'archive.confirm.title')}
      description={t(request.activity.length > 0 ? 'archive.confirm.activeDesc' : 'archive.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={archiving} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={archiving}
            onClick={confirm}
          >
            {summarize
              ? t(request.activity.length > 0 ? 'archive.confirm.stopSummarizeAction' : 'archive.confirm.summarizeAction')
              : t(request.activity.length > 0 ? 'archive.confirm.stopAction' : 'archive.confirm.action')}
          </Button>
        </>
      )}
    >
      {request.activity.length > 0 && <ul className={browserCss.archiveActivity} aria-label={t('archive.confirm.activity')}>
        {request.activity.map((entry, index) => (
          <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>
        ))}
      </ul>}
      {request.canSummarizeToChangelog && <label className={browserCss.archiveSummaryOption}>
        <input type="checkbox" checked={summarize} disabled={archiving} onChange={event => setSummarize(event.currentTarget.checked)} />
        <span>{t('archive.confirm.summarize')}</span>
      </label>}
      {archiving && <div className={browserCss.deleteStatus} role="status">{t('archive.confirm.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * One family's line: its count and the items' labels (ids when a family
 * carries no label). A family this dictionary does not know — a provider
 * merged into the kind map — falls through to the generic line.
 */
function activityLine(entry: SessionActivity, t: SessionArchiveConfirmProps['t']): string {
  const items = entry.items ?? []
  const n = items.length
  const names = items.map(item => item.label ?? item.id).join(t('archive.confirm.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (entry.kind) {
    case 'turn': return t('archive.confirm.turn')
    case 'subagent': return t(`archive.confirm.subagents.${plural}`, { n, names })
    case 'job': return t(`archive.confirm.jobs.${plural}`, { n, names })
    case 'schedule': return t(`archive.confirm.schedules.${plural}`, { n, names })
    default: return t(`archive.confirm.other.${plural}`, { kind: entry.kind, n })
  }
}
