/** Shared Team task DAG commands and runtime-enriched views. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  DispatchTaskRefusal,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { projectTaskView, taskReady } from './task-view.ts'
import { requiredText, writeScope } from './validation.ts'
import { verifyTaskOutputs } from './task-paths.ts'

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(task => task.id === id)) {
        throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      }
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        status: 'pending',
        blockedBy: this.dependencies(request.blockedBy ?? [], state),
        writeScopes: this.writeScopes(request.writeScopes ?? []),
        approval: request.approvalRequired === true ? 'pending' : 'not-required',
        inputPaths: [...new Set((request.inputPaths ?? []).map(path => writeScope(path)))],
        outputPaths: [...new Set((request.outputPaths ?? []).map(path => writeScope(path)))],
        ...request.assignee === undefined ? {} : { assigneeId: resolveActiveMember(root, state, request.assignee).id },
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return projectTaskView(this.journal.state(root), task)
    })
  }

  /** Atomically create a validated workflow as one durable Team event. */
  async createMany(membership: TeamMembership, requests: readonly CreateTeamTaskRequest[]): Promise<TeamTaskView[]> {
    if (requests.length === 0) throw new TeamError('workflow must contain at least one task', 'TEAM_INVALID_ARGUMENT')
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active + requests.length > this.maxTasks) throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      const tasks: TeamTaskSnapshot[] = []
      for (const [index, request] of requests.entries()) {
        const id = TeamTaskId(`task-${state.nextTaskNumber + index}`)
        if (state.tasks.some(task => task.id === id)) throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
        const task: TeamTaskSnapshot = {
          id, revision: 1,
          subject: requiredText(request.subject, 'subject', 200),
          description: requiredText(request.description, 'description', 16_384),
          status: 'pending',
          blockedBy: [...request.blockedBy ?? []],
          writeScopes: this.writeScopes(request.writeScopes ?? []),
          approval: request.approvalRequired === true ? 'pending' : 'not-required',
          inputPaths: [...new Set((request.inputPaths ?? []).map(path => writeScope(path)))],
          outputPaths: [...new Set((request.outputPaths ?? []).map(path => writeScope(path)))],
          ...request.assignee === undefined ? {} : { assigneeId: resolveActiveMember(root, state, request.assignee).id },
        }
        tasks.push(task)
      }
      const combined: TeamState = { ...state, tasks: [...state.tasks, ...tasks] }
      for (const task of tasks) this.assertTaskGraph(combined, task)
      await this.journal.appendAndFlush(root, 'team/tasks', { version: 2, teamId: TeamId(root.id), tasks })
      const committed = this.journal.state(root)
      return tasks.map(task => projectTaskView(committed, task))
    })
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return projectTaskView(this.journal.state(root), task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.revision !== request.expectedRevision) {
        throw new TeamError(
          `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
          'TEAM_TASK_STALE_REVISION',
        )
      }
      if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
      const lead = membership.role === 'lead'
      const owner = current.ownerId === caller.id
      const authorizeOwner = (): void => {
        if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
      }
      let next: TeamTaskSnapshot
      switch (request.action) {
        case 'claim':
          if (current.ownerId !== undefined && current.ownerId !== caller.id) {
            throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
          }
          if (current.approval === 'pending' || current.approval === 'rejected') {
            throw new TeamError('task approval gate is not approved', 'TEAM_TASK_APPROVAL_REQUIRED')
          }
          if (current.status !== 'pending' || !taskReady(state, current)) {
            throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
          }
          next = { ...current, status: 'in_progress', ownerId: caller.id,
            generation: (current.generation ?? 0) + 1, executionState: 'starting' }
          break
        case 'release':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending', executionState: 'ended' })
          break
        case 'edit':
          authorizeOwner()
          if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
            throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
          }
          next = {
            ...current,
            ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
            ...request.description === undefined
              ? {}
              : { description: requiredText(request.description, 'description', 16_384) },
            ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
          }
          break
        case 'assign': {
          if (!lead) throw new TeamError('only the Team Lead can assign a task', 'TEAM_LEAD_REQUIRED')
          if (current.status !== 'pending') throw new TeamError('only a pending task can be assigned', 'TEAM_TASK_INVALID_TRANSITION')
          if (request.owner === undefined || request.owner.trim() === '') {
            const { assigneeId: _assigneeId, ...without } = current
            next = without
          } else {
            next = { ...current, assigneeId: resolveActiveMember(root, state, request.owner).id }
          }
          break
        }
        case 'set_dependencies':
          authorizeOwner()
          if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
          next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
          break
        case 'complete':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          if (current.approval === 'pending' || current.approval === 'rejected') {
            throw new TeamError('task approval gate is not approved', 'TEAM_TASK_APPROVAL_REQUIRED')
          }
          if ((current.outputPaths?.length ?? 0) > 0) {
            const cwd = this.ctx.agents.get(caller.id)?.session.header.cwd ?? root.session.header.cwd
            if (cwd === undefined) throw new TeamError('task owner has no workspace for output validation', 'TEAM_TASK_OUTPUT_INVALID')
            try {
              await verifyTaskOutputs(current, cwd)
            } catch (error: unknown) {
              throw new TeamError(`task outputs failed validation: ${error instanceof Error ? error.message : String(error)}`,
                'TEAM_TASK_OUTPUT_INVALID', { cause: error })
            }
          }
          next = { ...current, status: 'completed' }
          break
        case 'reopen':
          authorizeOwner()
          if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'reassign': {
          if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
          if (current.status !== 'pending' && current.status !== 'in_progress') {
            throw new TeamError(
              'only a pending or in-progress task can be reassigned',
              'TEAM_TASK_INVALID_TRANSITION',
            )
          }
          if (request.owner === undefined || request.owner.trim().length === 0) {
            next = this.withoutOwner({ ...current, status: 'pending' })
            break
          }
          if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          const assignee = resolveActiveMember(root, state, request.owner)
          next = { ...current, status: 'in_progress', ownerId: assignee.id,
            assigneeId: assignee.id, generation: (current.generation ?? 0) + 1, executionState: 'starting' }
          break
        }
        case 'delete': {
          authorizeOwner()
          const dependent = state.tasks.find(task =>
            task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
          if (dependent !== undefined) {
            throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
          }
          next = { ...current, status: 'deleted' }
          break
        }
        /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
        default:
          throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
      }
      const task: TeamTaskSnapshot = {
        ...next,
        revision: current.revision + 1,
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return projectTaskView(this.journal.state(root), task)
    })
  }

  /** Persist a one-shot user decision for a task's execution gate. */
  async decideApproval(root: Agent, taskId: TeamTaskId, approved: boolean): Promise<TeamTaskView> {
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === taskId)
      if (current === undefined) throw new TeamError(`team task "${taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.status !== 'pending' || current.approval !== 'pending') {
        throw new TeamError('task is not waiting for approval', 'TEAM_TASK_INVALID_TRANSITION')
      }
      const task: TeamTaskSnapshot = { ...current, approval: approved ? 'approved' : 'rejected', revision: current.revision + 1 }
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return projectTaskView(this.journal.state(root), task)
    })
  }

  /** Validate and de-duplicate dependency ids against the current task graph. */
  private dependencies(
    values: readonly TeamTaskId[],
    state: TeamState,
    self?: TeamTaskId,
  ): TeamTaskId[] {
    const seen = new Set<TeamTaskId>()
    const result: TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.find(candidate => candidate.id === id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Normalize and de-duplicate task write scopes. */
  private writeScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(writeScope))]
  }

  /** Map shared task-graph validation onto stable command error codes. */
  private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
    }
  }

  /** Remove an optional owner field under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, assigneeId: _assigneeId, ...without } = task
    return without
  }
}

/** One planned dispatch claim against committed Team state. */
export type DispatchClaimPlan =
  | { readonly kind: 'claimed'; readonly next: TeamTaskSnapshot }
  | { readonly kind: 'assigned'; readonly task: TeamTaskSnapshot }
  | { readonly kind: 'refused'; readonly refusal: DispatchTaskRefusal }

/** Render one dispatch refusal as the repair facts a caller needs. */
export function describeDispatchRefusal(refusal: DispatchTaskRefusal): string {
  switch (refusal.reason) {
    case 'unknown-target': return 'no active teammate carries that name'
    case 'member-inactive': return `member creation is ${refusal.memberPhase ?? 'inactive'}`
    case 'task-not-found': return 'the task id does not exist'
    case 'task-status': return `the task is ${refusal.taskStatus ?? 'not pending'}`
    case 'task-blocked': return `blocked by ${(refusal.blockedBy ?? []).join(', ')}`
    case 'task-approval': return 'waiting for explicit user approval'
    case 'task-owned': return `already owned by ${refusal.ownerName ?? 'another member'}`
  }
}

/**
 * Plan one dispatch claim against current state; the committing caller owns
 * the Lead-log transaction. The claim re-checks blockers on the latest
 * revision, so a ready read outside the transaction cannot authorize a stale
 * start. A task already in progress for the named member plans the idempotent
 * repeat that returns the original assignment without re-delivery.
 * @param state - current Team state read inside the caller's transaction.
 * @param taskId - shared task to claim.
 * @param targetName - model-facing teammate name receiving the claim.
 * @returns the append plan, the idempotent repeat, or the structured refusal.
 */
export function planDispatchClaim(
  state: TeamState,
  taskId: TeamTaskId,
  targetName: string,
): DispatchClaimPlan {
  const name = targetName.trim()
  const member = name === 'lead'
    ? undefined
    : state.members.find(candidate => candidate.name === name)
  if (member === undefined) {
    return { kind: 'refused', refusal: { reason: 'unknown-target' } }
  }
  if (member.phase !== 'active') {
    return { kind: 'refused', refusal: { reason: 'member-inactive', memberPhase: member.phase } }
  }
  return planTaskClaim(state, taskId, member.id)
}

/**
 * Plan one task claim for an explicit durable assignee without member
 * resolution. Provisioning calls this for a reserved child id that has no
 * roster row yet; the assignee name only appears in refusals.
 * @param state - current Team state read inside the caller's transaction.
 * @param taskId - shared task to claim.
 * @param assigneeId - durable member identity receiving the claim.
 * @returns the append plan, the idempotent repeat, or the structured refusal.
 */
export function planTaskClaim(
  state: TeamState,
  taskId: TeamTaskId,
  assigneeId: SessionId,
): DispatchClaimPlan {
  const task = state.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) {
    return { kind: 'refused', refusal: { reason: 'task-not-found' } }
  }
  if (task.status === 'in_progress' && task.ownerId === assigneeId) {
    return { kind: 'assigned', task }
  }
  // Ownership precedes status so a stale caller learns who holds the task,
  // not only that the task moved on.
  if (task.ownerId !== undefined && task.ownerId !== assigneeId) {
    const ownerName = task.ownerId === brandString<SessionId>(state.id)
      ? 'lead'
      : state.members.find(candidate => candidate.id === task.ownerId)?.name
    return { kind: 'refused', refusal: { reason: 'task-owned', ...ownerName === undefined ? {} : { ownerName } } }
  }
  if (task.status !== 'pending') {
    return { kind: 'refused', refusal: { reason: 'task-status', taskStatus: task.status } }
  }
  if (task.approval === 'pending' || task.approval === 'rejected') {
    return { kind: 'refused', refusal: { reason: 'task-approval' } }
  }
  const incomplete = task.blockedBy
    .filter(id => state.tasks.find(candidate => candidate.id === id)?.status !== 'completed')
  if (incomplete.length > 0) {
    return { kind: 'refused', refusal: { reason: 'task-blocked', blockedBy: incomplete.map(String) } }
  }
  const next: TeamTaskSnapshot = {
    ...task,
    status: 'in_progress',
    ownerId: assigneeId,
    assigneeId,
    generation: (task.generation ?? 0) + 1,
    executionState: 'starting',
    revision: task.revision + 1,
  }
  return { kind: 'claimed', next }
}

/**
 * Release every in-progress task one member still owns back to pending.
 * Spawn failure and failed provisioning reconciliation call this so a member
 * that never started cannot hold its claim; completed work keeps its history.
 * @param journal - authoritative Lead-log transaction owner.
 * @param root - exact live Team Lead.
 * @param ownerId - durable member identity whose claims are released.
 */
export async function releaseMemberClaims(
  journal: TeamJournal,
  root: Agent,
  ownerId: SessionId,
): Promise<void> {
  await journal.transact(root.id, async () => {
    const state = journal.state(root)
    for (const task of state.tasks) {
      if (task.status !== 'in_progress' || task.ownerId !== ownerId) continue
      const { ownerId: _ownerId, ...without } = task
      await journal.appendAndFlush(root, 'team/task', {
        version: 2,
        teamId: TeamId(root.id),
        task: { ...without, status: 'pending', revision: task.revision + 1 },
      })
    }
  })
}
