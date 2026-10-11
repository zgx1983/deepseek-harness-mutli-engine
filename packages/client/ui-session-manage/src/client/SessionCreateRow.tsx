import { IconNewChatOutlineRegular, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import css from './SessionCreateRow.module.css'

/** Session-create row lifecycle derived solely from the durable call slice. */
type SessionCreateRowState = 'running' | 'ok' | 'error'

/** Narrowed result meta the Host tool persists via `presentationMeta`. */
export interface SessionCreatedMeta {
  readonly sessionId: string
  readonly engineId?: string
  readonly model?: { readonly provider: string; readonly model: string }
  readonly title?: string
  readonly reused: boolean
}

type SessionCreateRowProps = ToolCallViewProps
  & PropsLocale<'session-manage'>
  & { readonly openSession: (sessionId: string) => void }

/** First physical line for summaries and malformed-argument fallbacks. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Validate one replayable `tool/result` meta value from the Host tool. */
export function narrowSessionCreatedMeta(value: unknown): SessionCreatedMeta | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const meta = value as Record<string, unknown>
  if (typeof meta.sessionId !== 'string' || meta.sessionId === '' || typeof meta.reused !== 'boolean') return undefined
  if (meta.engineId !== undefined && typeof meta.engineId !== 'string') return undefined
  if (meta.title !== undefined && typeof meta.title !== 'string') return undefined
  let model: SessionCreatedMeta['model']
  if (meta.model !== undefined) {
    if (meta.model === null || typeof meta.model !== 'object') return undefined
    const candidate = meta.model as Record<string, unknown>
    if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return undefined
    model = { provider: candidate.provider, model: candidate.model }
  }
  return {
    sessionId: meta.sessionId,
    ...meta.engineId === undefined ? {} : { engineId: meta.engineId },
    ...model === undefined ? {} : { model },
    ...meta.title === undefined ? {} : { title: meta.title },
    reused: meta.reused,
  }
}

/** The model-facing target named by the call arguments, or the call id. */
function targetSummary(argsRaw: string, callId: string): string {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed === 'object' && parsed !== null) {
      const args = parsed as Record<string, unknown>
      const workspaceId = typeof args.workspace_id === 'string' && args.workspace_id !== '' ? args.workspace_id : undefined
      if (workspaceId !== undefined) return workspaceId
      const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
      if (cwd !== undefined) return cwd
    }
  } catch {
    // Streaming can expose a truncated JSON prefix; its first line is still
    // more useful than replacing the call with an unrelated lookup.
  }
  return argsRaw === '' ? callId : firstLine(argsRaw)
}

/** Flatten durable result blocks under the generic Tool-row text contract. */
function resultText(block: ToolResultNode): string | null {
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

interface StartedRowModel {
  readonly state: SessionCreateRowState
  readonly target: string
  readonly meta: SessionCreatedMeta | undefined
  readonly output: string | null
}

function startedRowModel(block: ToolResultNode): StartedRowModel {
  const argsRaw = block.call?.argsRaw ?? ''
  return {
    state: block.error?.code === 'interrupted' || block.isError ? 'error' : 'ok',
    target: targetSummary(argsRaw, block.callId),
    meta: narrowSessionCreatedMeta(block.meta),
    output: resultText(block),
  }
}

/**
 * Render one `session_create` tool call as a compact row whose successful
 * result offers an open-session action.
 * @param props - keyed toolview payload plus the session-manage locale seat
 *   and the injected open-session navigation action.
 * @returns the dedicated session-create row.
 */
export function SessionCreateRow(props: SessionCreateRowProps) {
  if (props.phase === 'preparing') return <div className={css.card} data-tool="session_create" data-state="preparing">
    <div className={css.row}>
      <span className={css.leading}><IconNewChatOutlineRegular size={14} /></span>
      <span className={css.visuallyHidden}>{props.t('row.preparing')}</span>
      <TextShimmer active className={css.title}>{props.t('row.title')}</TextShimmer>
    </div>
  </div>
  return <StartedSessionCreateRow {...props} />
}

function StartedSessionCreateRow({ block, openSession, t }: Exclude<SessionCreateRowProps, { phase: 'preparing' }>) {
  if (!('kind' in block)) {
    const running = <span className={css.visuallyHidden}>{t('row.running')}</span>
    return (
      <div className={css.card} data-tool="session_create" data-state="running">
        <div className={css.row}>
          <span className={css.leading}><IconNewChatOutlineRegular size={14} /></span>
          {running}
          <TextShimmer active>
            <span className={css.title}><TextShimmer>{t('row.title')}</TextShimmer></span>
            <span className={css.separator} data-shimmer-decoration aria-hidden />
            <span className={css.summary}><TextShimmer>{targetSummary(block.argsRaw, block.callId)}</TextShimmer></span>
          </TextShimmer>
        </div>
      </div>
    )
  }
  const model = startedRowModel(block)
  const meta = model.meta
  const metaSummary = meta === undefined
    ? undefined
    : [meta.engineId, meta.model?.model, meta.title]
      .filter(value => value !== undefined)
      .join(' · ')
  const summary = meta === undefined
    ? model.output === null ? model.target : firstLine(model.output)
    : metaSummary === '' ? model.target : metaSummary
  const open = meta !== undefined && model.state === 'ok'
    ? (): void => { openSession(meta.sessionId) }
    : undefined
  const failed = model.state === 'error' ? <span className={css.visuallyHidden}>{t('row.failed')}</span> : null
  return (
    <div className={css.card} data-tool="session_create" data-state={model.state}>
      <div className={css.row}>
        <span className={css.leading}><IconNewChatOutlineRegular size={14} /></span>
        {failed}
        <span className={css.title}>{t('row.title')}</span>
        <span className={css.separator} aria-hidden />
        <span className={`${css.summary}${model.state === 'error' ? ` ${css.errorSummary}` : ''}`}>{summary}</span>
        {open !== undefined ? (
          <button type="button" className={css.openButton} onClick={open}>
            {t('row.open')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
