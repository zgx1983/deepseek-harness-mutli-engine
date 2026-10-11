/** Read-only engine child status using the native Team roster components. */
import { useState } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EngineSubagentRecord } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { RosterGroups, MemberCard } from './Roster.tsx'
import css from './TeamAction.module.css'

const statuses = ['failed', 'unknown', 'running', 'pending', 'completed', 'stopped'] as const

function EngineChild({ child, t }: { child: EngineSubagentRecord; t: TranslateNS<typeof NS> }) {
  const [expanded, setExpanded] = useState(false)
  const dot: StateDotState = child.status === 'running' ? 'ongoing' : child.status === 'completed' ? 'done'
    : child.status === 'failed' ? 'error' : child.status === 'unknown' ? 'warning' : 'idle'
  return <article>
    <MemberCard marker={<StateDot state={dot} />} expanded={expanded} onClick={() => { setExpanded(value => !value) }}
      title={<span className={css.memberNameText}>{child.title}</span>}>
      <small>{t(`engine.${child.status}`)} · {child.engine}{child.model === undefined ? '' : ` · ${child.model}`}</small>
      {child.progress && <small className={css.diagnostic}>{child.progress}</small>}
    </MemberCard>
    {expanded && <div className={css.engineDetails}>
      <p className={css.notice}>{t('engine.readOnly')}</p>
      <p>{child.id}</p>
      {child.parentId !== undefined && <p>{t('engine.parent')}: {child.parentId}</p>}
      <pre>{child.output || t('engine.noOutput')}</pre>
    </div>}
  </article>
}

/**
 * Show native-engine child groups without advertising Harness continuation capabilities.
 * @param props - Validated projection records and shared Team dictionaries.
 * @returns The same roster grouping and cards used by native members.
 */
export function EngineSubagents({ children, t }: { children: readonly EngineSubagentRecord[]; t: TranslateNS<typeof NS> }) {
  return <RosterGroups groups={statuses.map(status => ({ key: status, label: t(`engine.${status}`),
    items: children.filter(child => child.status === status),
  }))} renderItem={child => <EngineChild key={`${child.engine}:${child.id}`} child={child} t={t} />} />
}
