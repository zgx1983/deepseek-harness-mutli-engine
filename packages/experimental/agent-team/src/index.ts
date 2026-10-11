/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context, Service } from '@deepseek-ai/cordis'
import { relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-approval'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { engineSubagentProjection } from './engine-subagent-projection.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard, planDispatchClaim } from './task-board.ts'
import { projectTaskView, taskReady } from './task-view.ts'
import { verifyTaskInputs } from './task-paths.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  DispatchTaskRequest,
  DispatchTaskResult,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamExecutionPermit,
  TeamTaskView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './roster.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000
const READ_ONLY_TASK_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'list_files', 'search_files', 'terminal_read', 'job_output'])
const TEAM_COORDINATION_TOOLS = new Set([
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'team_task_approve', 'team_workflow_create',
  'spawn_teammate', 'list_agents', 'list_teammate_models', 'send_message', 'wait', 'interrupt_agent', 'dispatch_task',
])

function isReadOnlyTaskTool(name: string): boolean { return READ_ONLY_TASK_TOOLS.has(name) }
function isTeamCoordinationTool(name: string): boolean { return TEAM_COORDINATION_TOOLS.has(name) }

/** Check the lexical target of a native file mutation against the task's declared scopes. */
function isInsideWriteScopes(cwd: string | undefined, args: unknown, scopes: readonly string[]): boolean {
  if (cwd === undefined || scopes.length === 0 || typeof args !== 'object' || args === null
    || !('file_path' in args) || typeof args.file_path !== 'string' || args.file_path.length === 0) return false
  const target = resolve(cwd, args.file_path)
  const targetRelative = relative(resolve(cwd), target)
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || targetRelative.length === 0) return false
  return scopes.some((scope) => {
    const scopePath = resolve(cwd, scope)
    const scopeRelative = relative(resolve(cwd), scopePath)
    return targetRelative === scopeRelative || targetRelative.startsWith(`${scopeRelative}${sep}`)
  })
}

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents', 'tools']

  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
    schedulerIntervalMs: z.number().step(1).min(1).default(DEFAULT_SCHEDULER_INTERVAL_MS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard
  private readonly schedulerTimer: NodeJS.Timeout
  private readonly scheduled = new Set<string>()
  private readonly readyScans = new WeakSet<Agent>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
      schedulerIntervalMs: positiveLimit(
        'schedulerIntervalMs',
        config.schedulerIntervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS,
      ),
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers)
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
    )
    this.tasks = new TeamTaskBoard(ctx, this.journal, this.config.maxTasks)
    this.schedulerTimer = setInterval(() => { this.scheduleAllReadyTasks() }, this.config.schedulerIntervalMs)
    this.schedulerTimer.unref()

    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      return await this.authorizeNativeTool(exec, next)
    })
    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) {
        this.activity.notify(membership.id)
        if (membership.role === 'teammate') {
          void this.observeTaskRunStatus(agent, agent.status === 'running' ? 'running' : 'ended').catch((error: unknown) => {
            if (!this.lifecycle.disposed) this.ctx.logger.warn(`Agent Teams execution status for "${agent.id}" failed: ${errorMessage(error)}`)
          })
          this.scheduleReadyTasks(membership.root)
        }
        if (membership.role === 'lead' && agent.status === 'running') this.scheduleReadyTasks(membership.root)
      }
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      const disposeChildren = ctx.root.sessionProjections.register(engineSubagentProjection)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          clearInterval(this.schedulerTimer)
          disposeChildren()
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, optional child working directory, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, wake authorization, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Claim one ready shared task for a teammate through the unified dispatch
   * entry and deliver its work order with wake authorization.
   * @param caller - exact live Lead Agent authorizing the dispatch.
   * @param request - task identity, teammate target, optional instruction, and interruption.
   * @returns the claim outcome; refusals carry structured repair facts instead of throwing.
   */
  async dispatchTask(caller: Agent, request: DispatchTaskRequest): Promise<DispatchTaskResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can dispatch tasks', 'TEAM_LEAD_REQUIRED')
    }
    const root = membership.root
    const committed = await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const target = state.members.find(member => member.name === request.target.trim())
      const pendingTask = state.tasks.find(candidate => candidate.id === request.taskId)
      if (pendingTask !== undefined && target !== undefined && pendingTask.status === 'pending') {
        const cwd = this.ctx.agents.get(target.id)?.session.header.cwd ?? root.session.header.cwd
        if ((pendingTask.inputPaths?.length ?? 0) > 0 && cwd === undefined) {
          throw new TeamError('task has input paths but its assignee has no workspace', 'TEAM_TASK_INPUT_INVALID')
        }
        if (cwd !== undefined) try { await verifyTaskInputs(pendingTask, cwd) } catch (error: unknown) {
          throw new TeamError(`task inputs failed validation: ${errorMessage(error)}`, 'TEAM_TASK_INPUT_INVALID', { cause: error })
        }
      }
      const plan = planDispatchClaim(state, request.taskId, request.target)
      if (plan.kind === 'claimed') {
        await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task: plan.next })
      }
      return plan
    })
    if (committed.kind === 'refused') {
      const state = this.journal.state(root)
      const task = state.tasks.find(candidate => candidate.id === request.taskId)
      return {
        dispatched: false,
        refusal: committed.refusal,
        ...task === undefined ? {} : { task: projectTaskView(state, task) },
      }
    }
    const task = committed.kind === 'claimed' ? committed.next : committed.task
    const view = projectTaskView(this.journal.state(root), task)
    if (committed.kind === 'assigned') {
      // The same task is already claimed by this target: an identical repeat
      // returns the original assignment without re-delivering the work order.
      return { dispatched: false, task: view }
    }
    let interrupted: DispatchTaskResult['interrupted']
    if (request.interrupt === true) {
      interrupted = this.roster.interrupt(caller, request.target)
    }
    const delivery = await this.mailbox.send(caller, {
      target: request.target,
      content: request.instruction ?? [{
        type: 'text',
        text: `Your dispatched shared task is ${task.id} (${task.subject}). It is already assigned to you. Read it with team_task_get and complete it with team_task_update after meeting its acceptance criteria.\n\n${task.description}`,
      }],
      wake: true,
      signal: request.signal,
    })
    const latestState = this.journal.state(root)
    const latestTask = latestState.tasks.find(candidate => candidate.id === task.id) ?? task
    return {
      dispatched: true,
      task: projectTaskView(latestState, latestTask),
      delivery,
      ...interrupted === undefined ? {} : { interrupted },
    }
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const membership = this.roster.membership(caller)
    const view = await this.tasks.create(membership, request)
    this.scheduleReadyTasks(membership.root)
    return view
  }

  /** Create a complete planned DAG in one durable event. */
  async createTasks(caller: Agent, requests: readonly CreateTeamTaskRequest[]): Promise<TeamTaskView[]> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can create workflow plans', 'TEAM_LEAD_REQUIRED')
    const tasks = await this.tasks.createMany(membership, requests)
    this.scheduleReadyTasks(membership.root)
    return tasks
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    const membership = this.roster.membership(caller)
    const prior = this.tasks.get(membership, request.taskId)
    const view = await this.tasks.update(caller, membership, request)
    if (prior.status === 'in_progress' && (view.status !== 'in_progress'
      || prior.generation !== view.generation || prior.ownerName !== view.ownerName)
      && prior.ownerName !== undefined && prior.ownerName !== 'lead' && prior.ownerName !== membership.name) {
      const owner = this.journal.state(membership.root).members.find(member => member.name === prior.ownerName)
      if (owner !== undefined) this.ctx.subagents.interrupt(owner.id, { kind: 'ancestor', agent: membership.root })
    }
    this.scheduleReadyTasks(membership.root)
    return view
  }

  /** Ask the configured human approval surface, then persist its one-shot decision. */
  async requestTaskApproval(caller: Agent, taskId: TeamTaskId, signal: AbortSignal): Promise<TeamTaskView> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead may request task approval', 'TEAM_LEAD_REQUIRED')
    const task = this.tasks.get(membership, taskId)
    if (task.approval !== 'pending') throw new TeamError('task is not waiting for approval', 'TEAM_TASK_INVALID_TRANSITION')
    const approval = this.ctx.get('approval')
    if (approval === undefined) throw new TeamError('task approval service is unavailable', 'TEAM_TASK_APPROVAL_REQUIRED')
    const outcome = await approval.request({ agent: caller, toolName: 'agent-team task execution',
      reason: `Approve starting ${task.id}: ${task.subject}`, signal })
    const result = await this.tasks.decideApproval(membership.root, taskId, outcome === 'allowed-once')
    this.scheduleReadyTasks(membership.root)
    return result
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /** Resolve the current durable task lease; non-Team agents are unmanaged. */
  executionPermit(agent: Agent): TeamExecutionPermit {
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate') return { managed: false, authorized: true, writeScopes: [] }
    const task = this.journal.state(membership.root).tasks.find(candidate =>
      candidate.ownerId === agent.id && candidate.status === 'in_progress')
    if (task === undefined || task.executionState === 'startup-unconfirmed'
      || (task.executionState !== 'starting' && task.executionState !== 'running')
      || task.approval === 'pending' || task.approval === 'rejected') {
      return { managed: true, authorized: false, writeScopes: [] }
    }
    return { managed: true, authorized: true, taskId: task.id,
      generation: task.generation ?? 0, writeScopes: [...task.writeScopes] }
  }

  /** Persist the active execution edge and revoke its turn permit when the member goes idle. */
  private async observeTaskRunStatus(agent: Agent, status: 'running' | 'ended'): Promise<void> {
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate' || this.lifecycle.disposed) return
    await this.journal.transact(membership.root.id, async () => {
      if (this.lifecycle.disposed) return
      const task = this.journal.state(membership.root).tasks.find(candidate =>
        candidate.ownerId === agent.id && candidate.status === 'in_progress')
      if (task === undefined || task.executionState === 'startup-unconfirmed') return
      const nextState = status === 'running' ? 'running' : task.executionState === 'running' ? 'ended' : task.executionState
      if (nextState === undefined || task.executionState === nextState) return
      await this.journal.appendAndFlush(membership.root, 'team/task', { version: 2, teamId: TeamId(membership.root.id),
        task: { ...task, executionState: nextState, revision: task.revision + 1 } })
    })
  }

  /** Recheck an engine's captured task generation at an operation callback. */
  executionPermitIsCurrent(agent: Agent, taskId: TeamTaskId, generation: number): boolean {
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'teammate') return false
    const task = this.journal.state(membership.root).tasks.find(candidate => candidate.id === taskId)
    return task?.status === 'in_progress' && task.ownerId === agent.id
      && task.generation === generation && (task.executionState === 'starting' || task.executionState === 'running')
      && task.approval !== 'pending' && task.approval !== 'rejected'
  }

  /** Apply task fencing to native Harness tools before their execution policy runs. */
  private async authorizeNativeTool(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const agent = exec.agent
    const membership = agent === undefined ? undefined : this.roster.tryMembership(agent)
    if (agent === undefined || membership?.role !== 'teammate') return await next()
    if (isTeamCoordinationTool(exec.name) || isReadOnlyTaskTool(exec.name)) return await next()
    const permit = this.executionPermit(agent)
    if (!permit.authorized || permit.taskId === undefined || permit.generation === undefined) {
      return { kind: 'deny', reason: 'This teammate has no active, fenced task permit for a work tool.' }
    }
    if ((exec.name === 'write' || exec.name === 'edit') && !isInsideWriteScopes(
      agent.session.header.cwd, exec.arguments, permit.writeScopes,
    )) return { kind: 'deny', reason: 'This file path is outside the active task write scopes.' }
    const approval = this.ctx.get('approval')
    if (approval === undefined) return { kind: 'deny', reason: 'A user approval channel is required for this task operation.' }
    const outcome = await approval.request({ agent, toolName: exec.name,
      callId: exec.callId, reason: `Task ${permit.taskId} generation ${permit.generation}: ${JSON.stringify(exec.arguments)}`,
      signal: exec.signal })
    if (outcome !== 'allowed-once' || !this.executionPermitIsCurrent(agent, permit.taskId, permit.generation)) {
      return { kind: 'deny', reason: 'The task operation was denied or its execution permit expired.' }
    }
    return await next()
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    const membership = this.roster.tryMembership(agent)
    if (membership?.role === 'lead') {
      await this.reconcileUncertainTasks(membership.root)
      this.scheduleReadyTasks(membership.root)
    }
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Mark persisted claims without a live owner as uncertain; they require explicit user recovery. */
  private async reconcileUncertainTasks(root: Agent): Promise<void> {
    await this.journal.transact(root.id, async () => {
      let state: ReturnType<TeamJournal['state']>
      try { state = this.journal.state(root) } catch (error: unknown) {
        if (!this.lifecycle.disposed) this.ctx.logger.warn(`Agent Teams scheduler could not read the task board: ${errorMessage(error)}`)
        return
      }
      for (const task of state.tasks) {
        if (task.status !== 'in_progress' || task.executionState === 'startup-unconfirmed'
          || this.ctx.agents.get(task.ownerId ?? root.id) !== undefined) continue
        const next: typeof task = { ...task, executionState: 'startup-unconfirmed', revision: task.revision + 1 }
        await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task: next })
      }
    })
  }

  /** Start explicitly assigned ready tasks once; uncertain delivery is never retried automatically. */
  private scheduleReadyTasks(root: Agent): void {
    if (this.ctx.agents.get(root.id) !== root || this.readyScans.has(root)) return
    this.readyScans.add(root)
    queueMicrotask(() => {
      this.readyScans.delete(root)
      if (this.lifecycle.disposed || this.ctx.agents.get(root.id) !== root) return
      const state = this.journal.state(root)
      for (const task of state.tasks) {
        if (task.status !== 'pending' || task.assigneeId === undefined || task.approval === 'pending'
          || task.approval === 'rejected' || !taskReady(state, task)) continue
        const member = this.roster.list(this.roster.membership(root)).find(row => row.id === task.assigneeId)
        if (member === undefined || member.role !== 'teammate' || member.status === 'failed'
          || member.status === 'provisioning') continue
        const key = `${root.id}:${task.id}`
        if (this.scheduled.has(key)) continue
        this.scheduled.add(key)
        void this.dispatchTask(root, { taskId: task.id, target: member.name, signal: this.lifecycle.signal })
          .catch(async (error: unknown) => {
            if (this.lifecycle.disposed) return
            this.ctx.logger.warn(`Agent Teams task "${task.id}" auto-dispatch failed: ${errorMessage(error)}`)
            try { await this.markTaskUnconfirmed(root, task.id) } catch (markError: unknown) {
              if (!this.lifecycle.disposed) this.ctx.logger.warn(`Agent Teams task "${task.id}" recovery record failed: ${errorMessage(markError)}`)
            }
          }).finally(() => { this.scheduled.delete(key) })
      }
    })
  }

  /** Retry scans for every live Team root after missed lifecycle notifications. */
  private scheduleAllReadyTasks(): void {
    if (this.lifecycle.disposed) return
    for (const agent of this.ctx.agents.list()) {
      if (this.roster.tryMembership(agent)?.role === 'lead') this.scheduleReadyTasks(agent)
    }
  }

  /** Persist an ambiguous scheduler failure as non-retryable until a user resolves it. */
  private async markTaskUnconfirmed(root: Agent, taskId: TeamTaskId): Promise<void> {
    await this.journal.transact(root.id, async () => {
      const task = this.journal.state(root).tasks.find(candidate => candidate.id === taskId)
      if (task === undefined || task.status !== 'in_progress') return
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id),
        task: { ...task, executionState: 'startup-unconfirmed', revision: task.revision + 1 } })
    })
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
