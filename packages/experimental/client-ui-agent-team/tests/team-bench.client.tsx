// @vitest-environment jsdom

/** Shared Team panel render bench: snapshot stores, localized copy, and projections. */
import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection, TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot, SessionSummary, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { type TeamActionInjected, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

export const SESSION = 'lead' as SessionId
export const WORKER = 'worker-id' as SessionId
export const TASK_1 = 'task-1' as TeamTaskId
export const TASK_2 = 'task-2' as TeamTaskId
export const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  blockedBy: [],
  approval: 'not-required',
  inputPaths: [],
  outputPaths: [],
  generation: 1,
  executionState: 'none',
  writeScopes: ['src'],
  ownerName: 'lead',
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
export const lead: TeamMemberProjection = { id: SESSION, name: 'lead', role: 'lead', phase: 'active', engine: 'native' }
export const worker: TeamMemberProjection = {
  id: WORKER, name: 'worker', role: 'teammate', phase: 'active', engine: 'claude',
}
export const team: TeamProjection = { members: [lead, worker], tasks: [task] }

export type Projections = SessionListState['projectionsBySession']

export function summary(id: SessionId, running: boolean): SessionSummary {
  return { id, displayTitle: id, running, retainedBy: {}, blank: false, updatedAt: 0 }
}

export function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  parentSessionId?: SessionId
  openState?: SessionSnapshot['openState']
  statuses?: SessionStatusSnapshot
  running?: Record<SessionId, boolean>
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId: Record<SessionId, SessionSummary> = {}
  for (const [id, running] of Object.entries(options.running ?? {}) as [SessionId, boolean][]) byId[id] = summary(id, running)
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: team } } },
  })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(options.statuses ?? new Map())
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId,
    pendingSubmissions: [],
    running: false,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
    removed: false,
    openState: options.openState ?? 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })
  const useSessions = bindSnapshotSelector(sessions)
  const injected: TeamActionInjected = {
    openTeammate: vi.fn(), openDashboard: vi.fn(),
  }
  const props: TeamActionProps = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useProjection: ((key: string, select?: (value: unknown) => unknown) => {
      const value = useSessions(state => state.projectionsBySession[sessionId]?.values[
        key as keyof SessionListState['projectionsBySession'][SessionId]['values']
      ])
      return select === undefined ? value : select(value)
    }) as UseProjection,
    useSessions,
    useSessionStatus: bindSnapshotSelector(statuses),
    ...injected,
    t: makeTranslate(zh, commonZh),
  } as TeamActionProps
  return { props, injected, sessions, statuses, session }
}

export function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'],
  sessionId: SessionId,
  snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

export function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

export { zh }
