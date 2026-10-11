const CACHE_MS = 60_000
const READ_CONCURRENCY = 5

/** Build project and token totals for the local day and its preceding six days. */
export function createDashboardReader(ctx) {
  const logger = ctx.logger('personal-assistant')
  let cached

  return async function readDashboard(timeZone, fresh = false) {
    const now = Date.now()
    if (!fresh && cached?.timeZone === timeZone && now - cached.createdAt < CACHE_MS) return cached.value

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    const dateKey = time => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(time))
        .filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
      return `${parts.year}-${parts.month}-${parts.day}`
    }
    const today = dateKey(now)
    const [year, month, day] = today.split('-').map(Number)
    const days = Array.from({ length: 7 }, (_, index) => {
      const calendarDay = new Date(Date.UTC(year, month - 1, day - index))
      return `${calendarDay.getUTCFullYear()}-${String(calendarDay.getUTCMonth() + 1).padStart(2, '0')}-${String(calendarDay.getUTCDate()).padStart(2, '0')}`
    }).reverse()
    const daySet = new Set(days)
    const hours = new Map(Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, '0')
      return [key, { hour: key, ...emptyTotals() }]
    }))
    const workspaces = ctx.workspaceRegistry.list()
    const owners = new Map()
    for (const workspace of workspaces) {
      for (const id of workspace.sessionIds) if (!owners.has(id)) owners.set(id, workspace)
    }
    const projects = new Map(workspaces.map(workspace => [workspace.id, {
      id: workspace.id, title: workspace.title, today: emptyTotals(), week: emptyTotals(),
      todaySessions: new Set(), weekSessions: new Set(),
    }]))
    projects.set('unassigned', {
      id: 'unassigned', title: '未归属项目', today: emptyTotals(), week: emptyTotals(),
      todaySessions: new Set(), weekSessions: new Set(),
    })
    const daily = new Map(days.map(key => [key, { date: key, ...emptyTotals(), sessions: new Set() }]))
    const records = await ctx.sessionQuery.listSessions()
    const sessionRows = []
    let failures = 0
    let cursor = 0

    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, records.length) }, async () => {
      while (cursor < records.length) {
        const record = records[cursor++]
        try {
          const snapshot = await ctx.sessionQuery.readSession(record.header.id)
          const header = snapshot.session
          const workspace = owners.get(header.id)
          const project = workspace?.path === header.cwd
            ? projects.get(workspace.id)
            : projects.get('unassigned')
          const createdDay = dateKey(header.createdAt)
          const session = {
            id: header.id,
            title: titleFrom(snapshot.events) ?? `会话 ${header.id.slice(0, 8)}`,
            projectId: project.id,
            projectTitle: project.title,
            cwd: header.cwd ?? '',
            createdAt: header.createdAt,
            lastActivity: header.createdAt,
            today: emptyTotals(),
            week: emptyTotals(),
            activeToday: false,
            activeWeek: false,
          }
          const ownedEvents = snapshot.events.slice(snapshot.inheritedEventCount)
          const inheritedEvents = snapshot.events.slice(0, snapshot.inheritedEventCount)
          let engineId = inheritedEvents.reduce((current, event) =>
            event.type === 'engine/selected' ? event.data.engineId : current, undefined)
          const cumulativeUsage = new Map()
          for (const event of ownedEvents) {
            if (event.type === 'engine/selected') {
              engineId = event.data.engineId
              continue
            }
            const key = dateKey(event.time)
            const inPeriod = daySet.has(key)
            const isConversation = event.type === 'user/message' || event.type === 'assistant/message'
            if (inPeriod && isConversation && event.time > session.lastActivity) session.lastActivity = event.time
            if (inPeriod && isConversation) {
              daily.get(key).sessions.add(session.id)
              if (key === today) {
                session.activeToday = true
                project.todaySessions.add(session.id)
              }
              session.activeWeek = true
              project.weekSessions.add(session.id)
            }
            if (event.type !== 'assistant/message') continue
            const usage = event.data.usage
            if (usage === undefined) continue
            const input = finiteCount(usage.inputTokens)
            const output = finiteCount(usage.outputTokens)
            const cacheRead = finiteCount(usage.cacheReadTokens)
            const cacheWrite = finiteCount(usage.cacheWriteTokens)
            const itemizedTotal = input + output + cacheRead + cacheWrite
            const reportedTotal = Math.max(itemizedTotal, finiteCount(usage.totalTokens))
            let additional = reportedTotal - itemizedTotal
            if (Number.isSafeInteger(usage.sessionTotalTokens) && usage.sessionTotalTokens >= 0) {
              const cumulative = usage.sessionTotalTokens
              const state = cumulativeUsage.get(engineId) ?? { pending: 0 }
              const cumulativeDelta = state.previous === undefined
                ? cumulative
                : cumulative >= state.previous ? cumulative - state.previous : cumulative
              state.pending += reportedTotal
              additional += Math.max(0, cumulativeDelta - state.pending)
              state.previous = cumulative
              state.pending = 0
              cumulativeUsage.set(engineId, state)
            } else if (engineId === 'codex' || engineId === 'claude') {
              const state = cumulativeUsage.get(engineId) ?? { pending: 0 }
              state.pending += reportedTotal
              cumulativeUsage.set(engineId, state)
            }
            if (inPeriod) {
              add(session.week, input, output, cacheRead, cacheWrite, additional)
              add(project.week, input, output, cacheRead, cacheWrite, additional)
              add(daily.get(key), input, output, cacheRead, cacheWrite, additional)
            }
            if (key === today) {
              add(session.today, input, output, cacheRead, cacheWrite, additional)
              add(project.today, input, output, cacheRead, cacheWrite, additional)
              const hourParts = hourFormatter.formatToParts(new Date(event.time))
              const hour = hourParts.find(part => part.type === 'hour')?.value
              if (hour !== undefined) add(hours.get(hour), input, output, cacheRead, cacheWrite, additional)
            }
          }
          if (daySet.has(createdDay)) daily.get(createdDay).createdSessions += 1
          if (createdDay === today) {
            session.today.createdSessions = 1
            project.today.createdSessions += 1
          }
          if (daySet.has(createdDay)) {
            session.week.createdSessions = 1
            project.week.createdSessions += 1
          }
          if (session.activeWeek || session.week.createdSessions > 0) sessionRows.push(session)
        } catch (error) {
          failures += 1
          logger.warn('Dashboard could not read Session %s: %s', record.header.id, String(error))
        }
      }
    }))

    for (const [, project] of projects) {
      project.today.activeSessions = project.todaySessions.size
      project.week.activeSessions = project.weekSessions.size
      delete project.todaySessions
      delete project.weekSessions
    }
    const dailyRows = days.map(key => {
      const value = daily.get(key)
      value.activeSessions = value.sessions.size
      delete value.sessions
      return value
    })
    const totals = period => {
      const values = [...projects.values()].map(project => project[period])
      const periodSessions = period === 'today'
        ? sessionRowsFor('today')
        : sessionRowsFor('week')
      const activeSessions = periodSessions.filter(session => period === 'today'
        ? session.activeToday
        : session.activeWeek)
      return {
        activeSessions: new Set(activeSessions.map(session => session.id)).size,
        projects: new Set(activeSessions.map(session => session.projectId).filter(id => id !== 'unassigned')).size,
        createdSessions: values.reduce((sum, value) => sum + value.createdSessions, 0),
        inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
        outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
        cacheReadTokens: values.reduce((sum, value) => sum + value.cacheReadTokens, 0),
        cacheWriteTokens: values.reduce((sum, value) => sum + value.cacheWriteTokens, 0),
        additionalTokens: values.reduce((sum, value) => sum + value.additionalTokens, 0),
      }
    }
    function sessionRowsFor(period) {
      return sessionRows.filter(session => period === 'today'
        ? session.activeToday || session.today.createdSessions > 0
        : session.activeWeek || session.week.createdSessions > 0)
    }

    const value = {
      generatedAt: now,
      timeZone,
      incompleteSessions: failures,
      today: totals('today'),
      week: totals('week'),
      days: dailyRows,
      hours: [...hours.values()],
      projects: [...projects.values()].map(project => ({
        id: project.id, title: project.title, today: project.today, week: project.week,
      })),
      sessions: sessionRows.sort((left, right) => right.lastActivity - left.lastActivity).slice(0, 100),
    }
    cached = { timeZone, createdAt: now, value }
    return value
  }
}

function titleFrom(events) {
  let latest
  for (const event of events) {
    if (event.type === 'session/title' && (latest === undefined || event.seq > latest.seq)) {
      latest = { seq: event.seq, title: event.data.title }
    }
  }
  return latest?.title
}

function finiteCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function emptyTotals() {
  return {
    activeSessions: 0, createdSessions: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, additionalTokens: 0,
  }
}

function add(target, input, output, cacheRead = 0, cacheWrite = 0, additional = 0) {
  target.inputTokens += input
  target.outputTokens += output
  target.cacheReadTokens += cacheRead
  target.cacheWriteTokens += cacheWrite
  target.additionalTokens += additional
}
