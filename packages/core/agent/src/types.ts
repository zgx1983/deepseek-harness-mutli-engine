/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// Type-only: the Workspace registry's archive-admission family map this registry merges `turn` into.
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Browser-safe descriptor for one slash command exposed by the selected engine. */
export interface AgentEngineCommand {
  /** Command name without its leading slash. */
  readonly name: string
  /** Command summary supplied by the SDK or app-server mapping. */
  readonly description: string
  /** Argument hint for commands accepting trailing text. */
  readonly argumentHint?: string
  /** Prompt commands use durable user input; actions call an app-server operation. */
  readonly execution: 'prompt' | 'action'
  /** Native command or discovered skill; omitted when the engine cannot distinguish them. */
  readonly kind?: 'command' | 'skill'
}

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** The session's own Agent is inside a turn, including one waiting for an approval or an answer. */
    turn: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
  }
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
  }
}

/**
 * Turn and step boundaries folded from one agent session log.
 *
 * Reader contract: the key is registered by `dsh-agent-loop` and absent
 * otherwise. Without agent-loop no turn events exist, so readers treat an
 * absent key as "no open turn / no boundaries" — capability absence, not a
 * corrupt state. A reader whose behavior has no safe fallback for that
 * absence (the step-open decision, for example) may fail loud instead.
 */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}

/** SDK-owned activity projected without invoking the Harness tool executor. */
export interface EngineActivityRecord {
  /** Native operation name. */
  readonly name: string
  /** Complete operation arguments represented as JSON or native command text. */
  readonly argsRaw: string
  /** Current native execution state. */
  readonly status: 'running' | 'completed' | 'failed'
  /** Bounded native output for the card. */
  readonly output: string
}

/** Opaque child identity supplied by a native engine protocol. */
export type EngineSubagentId = Branded<'EngineSubagentId'>

/** Engine-owned child execution observed without creating a Harness Session. */
export interface EngineSubagentRecord {
  readonly engine: 'claude' | 'codex'
  readonly id: EngineSubagentId
  readonly title: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown'
  readonly startedAt?: number | undefined
  readonly endedAt?: number | undefined
  readonly model?: string | undefined
  readonly progress: string
  readonly output: string
  readonly parentId?: EngineSubagentId | undefined
}

/** Native process observations before identity branding by the persistence owner. */
export type EngineSubagentPatch = Partial<Omit<EngineSubagentRecord, 'id' | 'engine' | 'parentId'>> & {
  readonly parentId?: string | undefined
}
