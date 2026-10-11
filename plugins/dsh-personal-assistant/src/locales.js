/** Locale-owned copy for the project usage dashboard. */
export const NS = 'personal-assistant'
export const zh = {
  title: '项目看板', subtitle: '查看项目与会话活动，以及模型 token 用量。',
  periodLabel: '统计周期', today: '今天', week: '近 7 天', refresh: '刷新', refreshing: '更新中…', retry: '重试',
  loadError: '看板数据加载失败。', diagnosticCode: code => `诊断代码：${code}`, incompleteSessions: count => `${count} 个会话暂时无法读取，统计可能不完整。`,
  summaryLabel: '用量摘要', activeProjects: '活跃项目', activeSessions: '活跃会话', projectUnit: '个项目',
  createdSessions: count => `新建 ${count} 个`, totalTokens: 'Token 总量',
  formatCount: value => new Intl.NumberFormat('zh-CN', { notation: 'compact', compactDisplay: 'short', minimumFractionDigits: value >= 10_000 ? 2 : 0, maximumFractionDigits: 2 }).format(value),
  tokenBreakdown: stats => `输入 ${formatCount(stats.inputTokens)} · 输出 ${formatCount(stats.outputTokens)} · 缓存读/写 ${formatCount(stats.cacheReadTokens)}/${formatCount(stats.cacheWriteTokens)} · 引擎补充 ${formatCount(stats.additionalTokens)}`,
  todayUsage: '今日 token 用量', weekUsage: '每日 token 用量', inputOutputLegend: '输入 + 输出 + 缓存 + 引擎补充', usageChartLabel: hourly => hourly ? '今日每小时 token 用量' : '近七日 token 用量',
  projectsHeading: '项目', projectCount: count => `${count} 个项目`, emptyProjects: '这个周期还没有项目活动。',
  projectSessions: (active, created) => `活跃会话 ${active} · 新建 ${created}`,
  sessionsHeading: '会话', sessionCount: count => `${count} 个会话`, emptySessions: '这个周期还没有会话活动。',
  lastActive: date => `最近活动 ${date}`, tokensShort: 'tokens', updatedAt: date => `更新于 ${date}`,
}
export const en = {
  title: 'Project dashboard', subtitle: 'Project and session activity with model token usage.',
  periodLabel: 'Reporting period', today: 'Today', week: 'Last 7 days', refresh: 'Refresh', refreshing: 'Updating…', retry: 'Retry',
  loadError: 'Could not load dashboard data.', diagnosticCode: code => `Diagnostic code: ${code}`, incompleteSessions: count => `${count} sessions could not be read; totals may be incomplete.`,
  summaryLabel: 'Usage summary', activeProjects: 'Active projects', activeSessions: 'Active sessions', projectUnit: 'projects',
  createdSessions: count => `${count} new`, totalTokens: 'Tokens used',
  formatCount: value => new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 2 }).format(value),
  tokenBreakdown: stats => `Input ${formatCount(stats.inputTokens)} · Output ${formatCount(stats.outputTokens)} · Cache read/write ${formatCount(stats.cacheReadTokens)}/${formatCount(stats.cacheWriteTokens)} · Engine extra ${formatCount(stats.additionalTokens)}`,
  todayUsage: 'Today’s token usage', weekUsage: 'Daily token usage', inputOutputLegend: 'Input + output + cache + engine-reported extra', usageChartLabel: hourly => hourly ? 'Hourly token usage today' : 'Daily token usage over the last seven days',
  projectsHeading: 'Projects', projectCount: count => `${count} projects`, emptyProjects: 'No project activity in this period.',
  projectSessions: (active, created) => `${active} active · ${created} new sessions`,
  sessionsHeading: 'Sessions', sessionCount: count => `${count} sessions`, emptySessions: 'No session activity in this period.',
  lastActive: date => `Last active ${date}`, tokensShort: 'tokens', updatedAt: date => `Updated ${date}`,
}

function formatCount(value) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', compactDisplay: 'short', minimumFractionDigits: value >= 10_000 ? 2 : 0, maximumFractionDigits: 2 }).format(value)
}
