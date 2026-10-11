/** Public Agent Teams identities, durable records, and service request values. */

import type { EngineSubagentRecord } from '@deepseek-ai/dsh-agent/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  /**
   * Resolved absolute working directory requested at creation, recorded only
   * when the spawn named one. Immutable for the member's durable life and
   * equal to the child Session header's `cwd`.
   */
  readonly cwd?: string
  readonly phase: TeamMemberPhase
  readonly error?: string
}

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  /** Resolved working directory recorded at creation; absent when the member runs in the Lead workspace. */
  readonly cwd?: string
  readonly model?: string
  readonly diagnostics: string[]
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  /** Explicit durable assignee; assignment alone never starts execution. */
  readonly assigneeId?: SessionId
  /** User approval gate. Only an approved task may be claimed. */
  readonly approval?: 'not-required' | 'pending' | 'approved' | 'rejected'
  /** Workspace-relative paths that must exist before execution begins. */
  readonly inputPaths?: string[]
  /** Workspace-relative paths checked by the Host before completion. */
  readonly outputPaths?: string[]
  /** Monotonic fencing generation for the currently authorized attempt. */
  readonly generation?: number
  /** `startup-unconfirmed` blocks retry after an ambiguous crash. */
  readonly executionState?: 'reserved' | 'starting' | 'running' | 'ended' | 'failed' | 'stopped' | 'startup-unconfirmed'
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
}

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly approval: 'not-required' | 'pending' | 'approved' | 'rejected'
  readonly inputPaths: string[]
  readonly outputPaths: string[]
  readonly generation: number
  readonly executionState: NonNullable<TeamTaskSnapshot['executionState']> | 'none'
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly writeScopeWarnings: string[]
  /** First transition into in_progress, in Unix epoch milliseconds. */
  readonly startedAt?: number
  /** Last transition out of in_progress, in Unix epoch milliseconds. */
  readonly endedAt?: number
}

/** Current Host-issued authority for one task-owned external-engine turn. */
export interface TeamExecutionPermit {
  readonly managed: boolean
  readonly authorized: boolean
  readonly taskId?: TeamTaskId
  readonly generation?: number
  readonly writeScopes: string[]
}

/** One durable roster row published through the `agentTeam` Session projection. */
export interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  /**
   * Execution engine derived from the durable provider: the `engine:` provider
   * namespace carries its engine id; every other provider is `native`. The
   * Lead row is always `native`.
   */
  readonly engine: string
  readonly error?: string
}

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
export interface TeamProjection {
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable roster and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
  /** Milliseconds between fallback scans for explicitly assigned ready tasks. */
  readonly schedulerIntervalMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  /** Per-child LLM route; omitted fields inherit compatible parent values. */
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: ReasoningEffortId
  }
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  /**
   * Shared task the spawned member executes. The provisioning transaction
   * claims it for the reserved child id after validating it is unowned,
   * pending, and ready; a creation failure releases the claim. Omitted spawns
   * create no task binding.
   */
  readonly taskId?: TeamTaskId
  /**
   * Working directory for the child Session: absolute, or relative resolved
   * against the Lead workspace. Validated as an existing enterable directory
   * before any durable member record; the child runs its tools and loads
   * project instructions there. Omitted inherits the Lead working directory.
   */
  readonly cwd?: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for the unified dispatch entry claiming one ready task for a teammate. */
export interface DispatchTaskRequest {
  readonly taskId: TeamTaskId
  /** Model-facing teammate name receiving the claim and work order. */
  readonly target: string
  /** Work-order content; the task subject and description when omitted. */
  readonly instruction?: ContentBlock[]
  /** Interrupt the target's current turn before delivering the work order. */
  readonly interrupt?: boolean
  readonly signal: AbortSignal
}

/** Why one dispatch claim was refused; carries the repair facts a caller needs. */
export interface DispatchTaskRefusal {
  readonly reason:
    | 'unknown-target'
    | 'member-inactive'
    | 'task-not-found'
    | 'task-status'
    | 'task-blocked'
    | 'task-approval'
    | 'task-owned'
  /** Provisioning phase of a named but non-active target. */
  readonly memberPhase?: TeamMemberPhase
  /** Current status when the task exists but is not claimable. */
  readonly taskStatus?: TeamTaskStatus
  /** Incomplete blocker ids for a blocked refusal. */
  readonly blockedBy?: string[]
  /** Model-facing owner name when another member or the Lead holds the task. */
  readonly ownerName?: string
}

/** Result of one unified dispatch claim and work-order delivery. */
export interface DispatchTaskResult {
  /** Whether this call performed the claim; false on an idempotent repeat or a refusal. */
  readonly dispatched: boolean
  /** Latest task view; absent only when the task id does not exist. */
  readonly task?: TeamTaskView
  /** Structured refusal; absent on a claim or idempotent repeat. */
  readonly refusal?: DispatchTaskRefusal
  /** Work-order mailbox outcome; absent on an idempotent repeat and a refusal. */
  readonly delivery?: SendTeamMessageResult
  /** Interruption outcome when the dispatch requested one. */
  readonly interrupted?: { readonly previousStatus: 'running' | 'inactive' }
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  /**
   * Whether an inactive target may be started or cold-resumed to consume this
   * message. Peer discussion defaults to false — the mail waits for the
   * target's next authorized execution — while dispatch and stop flows pass
   * true for their authoritative wake. A running target always receives the
   * message at its nearest step boundary.
   */
  readonly wake?: boolean
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly approvalRequired?: boolean
  readonly inputPaths?: readonly string[]
  readonly outputPaths?: readonly string[]
  /** Assign to an existing active member without starting it. */
  readonly assignee?: string
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'assign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** One atomic batch of newly planned shared tasks. */
    'team/tasks': { version: 2; teamId: TeamId; tasks: TeamTaskSnapshot[] }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}


declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Latest engine-owned child observations, excluding Harness continuation addresses. */
    engineSubagents: EngineSubagentRecord[]
  }
  interface SessionProjectionStateMap {
    /** Durable external child status folded from the parent's observational records. */
    engineSubagents: EngineSubagentRecord[]
  }
}
