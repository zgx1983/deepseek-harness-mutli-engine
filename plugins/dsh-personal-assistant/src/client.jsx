/** Project, session, and token usage dashboard. */
import * as React from 'react'
import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS, zh, en } from './locales.js'
import { CSS } from './css.js'

export const inject = ['slots', 'locale']
const PANEL = 'personal-assistant'

/** Register the dashboard in the application sidebar and main panel. */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'personal-assistant: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.personalAssistant = ''
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'personal-assistant: styles')
  const injected = () => ({ t })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 1, locale: NS, label: () => t('title'), inject: injected,
  }, DashboardIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL, locale: NS, inject: injected,
  }, DashboardHome))
}

function DashboardIcon({ size }) {
  return <IconGaugeOutlineRegular size={size} />
}

function DashboardHome({ t }) {
  const [period, setPeriod] = React.useState('today')
  const [snapshot, setSnapshot] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const timeZone = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', [])
  const load = React.useCallback(async (fresh = false, signal) => {
    if (fresh) setRefreshing(true)
    try {
      const query = new URLSearchParams({ timeZone, ...(fresh ? { fresh: 'true' } : {}) })
      const response = await fetch(new URL(`/api/personal-assistant/dashboard?${query}`, document.baseURI), {
        credentials: 'include', signal,
      })
      const value = await response.json()
      if (!response.ok) throw new Error(value?.error?.code ?? `HTTP ${response.status}`)
      setSnapshot(parseSnapshot(value))
      setError(null)
    } catch (cause) {
      if (!signal?.aborted) setError(String(cause?.message ?? cause))
    } finally {
      if (!signal?.aborted) { setLoading(false); setRefreshing(false) }
    }
  }, [timeZone])

  React.useEffect(() => {
    const controller = new AbortController()
    void load(false, controller.signal)
    return () => controller.abort()
  }, [load])

  const summary = snapshot?.[period]
  const projects = snapshot?.projects
    .map(project => ({ ...project, stats: project[period] }))
    .filter(project => project.stats.activeSessions > 0 || project.stats.createdSessions > 0
      || project.stats.inputTokens > 0 || project.stats.outputTokens > 0)
    .sort((left, right) => total(right.stats) - total(left.stats)
      || right.stats.activeSessions - left.stats.activeSessions) ?? []
  const sessions = snapshot?.sessions.filter(session => period === 'today'
    ? session.activeToday || session.today.createdSessions > 0
    : session.activeWeek || session.week.createdSessions > 0) ?? []
  const bins = period === 'today' ? snapshot?.hours ?? [] : snapshot?.days ?? []
  const maxTokens = Math.max(1, ...bins.map(bin => total(bin)))

  return <main className="pa-dashboard">
    <header className="pa-dashboard-head">
      <div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className="pa-dashboard-actions">
        <div className="pa-period" role="group" aria-label={t('periodLabel')}>
          {['today', 'week'].map(key => <button key={key} type="button" aria-pressed={period === key}
            onClick={() => setPeriod(key)}>{t(key)}</button>)}
        </div>
        <button className="pa-refresh" type="button" disabled={refreshing} onClick={() => void load(true)}>
          {refreshing ? t('refreshing') : t('refresh')}
        </button>
      </div>
    </header>

    {error && <div className="pa-dashboard-error" role="alert">
      <span>{t('loadError')} <code>{t('diagnosticCode')(error)}</code></span><button type="button" onClick={() => void load(true)}>{t('retry')}</button>
    </div>}
    {snapshot?.incompleteSessions > 0 && <p className="pa-dashboard-note">{t('incompleteSessions')(snapshot.incompleteSessions)}</p>}
    {loading && snapshot === null
      ? <div className="pa-dashboard-loading" role="status"><span /></div>
      : summary && <>
        <section className="pa-metrics" aria-label={t('summaryLabel')}>
          <Metric label={t('activeProjects')} value={t('formatCount')(summary.projects)} detail={t('projectUnit')} />
          <Metric label={t('activeSessions')} value={t('formatCount')(summary.activeSessions)} detail={t('createdSessions')(t('formatCount')(summary.createdSessions))} />
          <Metric label={t('totalTokens')} value={t('formatCount')(total(summary))}
            detail={t('tokenBreakdown')(summary)} />
        </section>

        <section className="pa-dashboard-section pa-usage-section">
          <div className="pa-section-heading"><h2>{period === 'today' ? t('todayUsage') : t('weekUsage')}</h2>
            <span>{t('inputOutputLegend')}</span></div>
          <div className={`pa-usage-chart${period === 'today' ? ' pa-usage-hours' : ''}`} role="img" aria-label={t('usageChartLabel')(period === 'today')}>
            {bins.map(bin => {
              const amount = total(bin)
              const height = amount === 0 ? 4 : Math.max(8, amount / maxTokens * 100)
              return <div className="pa-usage-day" key={bin.date ?? bin.hour}>
                <span className="pa-usage-value">{t('formatCount')(amount)}</span>
                <div className="pa-usage-track"><div className="pa-usage-bar" style={{ height: `${height}%` }} /></div>
                <span className="pa-usage-label">{dayLabel(bin.date ?? bin.hour, period, timeZone)}</span>
              </div>
            })}
          </div>
        </section>

        <section className="pa-dashboard-section">
          <div className="pa-section-heading"><h2>{t('projectsHeading')}</h2><span>{t('projectCount')(projects.length)}</span></div>
          {projects.length === 0 ? <p className="pa-empty">{t('emptyProjects')}</p>
            : <div className="pa-project-list">
              {projects.map(project => <div className="pa-project-row" key={project.id}>
                <div className="pa-project-name"><strong>{project.title}</strong>
                  <span>{t('projectSessions')(t('formatCount')(project.stats.activeSessions), t('formatCount')(project.stats.createdSessions))}</span></div>
                <div className="pa-project-tokens"><strong>{t('formatCount')(total(project.stats))}</strong>
                  <span>{t('tokenBreakdown')(project.stats)}</span></div>
              </div>)}
            </div>}
        </section>

        <section className="pa-dashboard-section">
          <div className="pa-section-heading"><h2>{t('sessionsHeading')}</h2><span>{t('sessionCount')(sessions.length)}</span></div>
          {sessions.length === 0 ? <p className="pa-empty">{t('emptySessions')}</p>
            : <div className="pa-session-list">
              {sessions.slice(0, 30).map(session => {
                const stats = session[period]
                return <article className="pa-session-row" key={session.id}>
                  <div className="pa-session-main"><strong title={session.title}>{session.title}</strong>
                    <span>{session.projectTitle} · {t('lastActive')(formatDate(session.lastActivity, timeZone))}</span></div>
                    <div className="pa-session-tokens"><strong>{t('formatCount')(total(stats))} {t('tokensShort')}</strong>
                    <span>{t('tokenBreakdown')(stats)}</span></div>
                </article>
              })}
            </div>}
        </section>
        <footer className="pa-dashboard-foot">{t('updatedAt')(formatDate(snapshot.generatedAt, timeZone))}</footer>
      </>}
  </main>
}

function Metric({ label, value, detail }) {
  return <article className="pa-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function parseSnapshot(value) {
  const checkUsage = totals => totals && ['activeSessions', 'createdSessions', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'additionalTokens']
    .every(key => Number.isSafeInteger(totals[key]) && totals[key] >= 0)
  const checkTotals = totals => checkUsage(totals) && Number.isSafeInteger(totals.projects) && totals.projects >= 0
  if (!value || !checkTotals(value.today) || !checkTotals(value.week) || !Array.isArray(value.days)
    || !Array.isArray(value.hours)
    || !Array.isArray(value.projects) || !Array.isArray(value.sessions)
    || typeof value.timeZone !== 'string' || !Number.isSafeInteger(value.generatedAt)
    || !Number.isSafeInteger(value.incompleteSessions) || value.incompleteSessions < 0) {
    throw new Error('Invalid dashboard data')
  }
  for (const day of value.days) if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !checkUsage(day)) throw new Error('Invalid daily dashboard data')
  for (const hour of value.hours) if (!/^\d{2}$/.test(hour.hour) || !checkUsage(hour)) throw new Error('Invalid hourly dashboard data')
  for (const project of value.projects) {
    if (typeof project.id !== 'string' || typeof project.title !== 'string'
      || !checkUsage(project.today) || !checkUsage(project.week)) throw new Error('Invalid project dashboard data')
  }
  for (const session of value.sessions) {
    if (typeof session.id !== 'string' || typeof session.title !== 'string'
      || typeof session.projectTitle !== 'string' || !Number.isSafeInteger(session.lastActivity)
      || !Number.isSafeInteger(session.createdAt) || typeof session.activeToday !== 'boolean' || typeof session.activeWeek !== 'boolean'
      || !checkUsage(session.today) || !checkUsage(session.week)) throw new Error('Invalid session dashboard data')
  }
  return value
}

function total(value) {
  return value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.additionalTokens
}

function formatDate(value, timeZone) {
  return new Intl.DateTimeFormat(undefined, { timeZone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

function dayLabel(value, period, timeZone) {
  if (period === 'today') return Number(value) % 3 === 0 ? `${value}:00` : ''
  return new Intl.DateTimeFormat(undefined, { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(`${value}T12:00:00`))
}
