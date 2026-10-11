/** Pure task-view derivation shared by the task board and the client projection. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamState } from './projection.ts'
import type { TeamTaskSnapshot, TeamTaskView } from './types.ts'

/**
 * Whether two normalized file or directory prefixes overlap on path components.
 * @param left - normalized write scope.
 * @param right - normalized write scope.
 * @returns whether either scope contains the other.
 */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Whether every current blocker of one task completed.
 * @param state - Team state supplying sibling tasks.
 * @param task - durable task snapshot to test.
 * @returns whether the task has no incomplete blockers.
 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.approval !== 'pending' && task.approval !== 'rejected'
    && task.executionState !== 'startup-unconfirmed'
    && task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed')
}

/**
 * Derive one task view with owner name, readiness, and advisory write overlaps.
 * Committing callers supply the committed state so event-derived task times
 * include the new transition.
 * @param state - Team state supplying members and sibling tasks.
 * @param task - durable task snapshot to view.
 * @returns a detached task view.
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const ownerName = task.ownerId === undefined
    ? undefined
    : task.ownerId === brandString<SessionId>(state.id)
      ? 'lead'
      : state.members.find(member => member.id === task.ownerId)?.name
  const warnings = new Set<string>()
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue
    if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`)
    }
  }
  const timing = state.taskTimes[task.id]
  return {
    ...timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt },
    ...timing?.endedAt === undefined ? {} : { endedAt: timing.endedAt },
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    approval: task.approval ?? 'not-required',
    inputPaths: [...task.inputPaths ?? []],
    outputPaths: [...task.outputPaths ?? []],
    generation: task.generation ?? 0,
    executionState: task.executionState ?? (task.status === 'pending' ? 'none' : task.status === 'in_progress' ? 'running' : 'ended'),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...ownerName === undefined ? {} : { ownerName },
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
  }
}
