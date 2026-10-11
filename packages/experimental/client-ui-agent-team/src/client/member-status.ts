/** Shared roster classification from runtime activity and recorded task intervals. */
import type { TeamMemberProjection, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team/client'

/** Member display states, including unstarted work and completed execution. */
export type TeamMemberStatus = 'failed' | 'unknown' | 'running' | 'pending' | 'completed' | 'idle' | 'unstarted' | 'provisioning'

/**
 * Classify members without treating an inactive Session or an unstarted task as completed.
 * @param member - Durable Team member phase.
 * @param running - Known Session activity, or undefined before status loads.
 * @param tasks - Current nondeleted tasks assigned to this member.
 * @returns Display state shared by the header roster and sidebar.
 */
export function memberStatus(member: TeamMemberProjection, running: boolean | undefined, tasks: readonly TeamTaskView[]): TeamMemberStatus {
  if (member.phase !== 'active') return member.phase
  if (running === undefined) return 'unknown'
  if (running) return 'running'
  if (tasks.some(task => task.status !== 'completed')) return 'pending'
  if (tasks.length > 0 && tasks.every(task => task.startedAt !== undefined && task.endedAt !== undefined)) return 'completed'
  return tasks.length === 0 || tasks.some(task => task.startedAt !== undefined) ? 'idle' : 'unstarted'
}
