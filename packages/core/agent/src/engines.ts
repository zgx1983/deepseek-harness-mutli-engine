/**
 * Named execution engines: capability and endpoint declarations owned by the
 * Agent registry. Empty sessions retain replaceable draft selection; the
 * first accepted user input locks the persisted engine.
 *
 * @module @deepseek-ai/dsh-agent/engines
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AgentFactory } from './index.ts'
import type { Agent, AgentEngineCommand } from './types.ts'
import type { ModelSelection } from './model-selection.ts'
import type { LlmModelReasoningInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'

/** Branded identity of one registered execution engine (e.g. `native`, `codex`). */
export type AgentEngineId = Branded<'AgentEngineId'>

/**
 * Brand a string as an execution engine identity.
 * @param id - registry engine name.
 * @returns the branded engine identity.
 */
export function AgentEngineId(id: string): AgentEngineId {
  return brandString<AgentEngineId>(id)
}

/**
 * Explicit capability modes one engine advertises. Unsupported capabilities
 * stay disabled: an unsupported request must be rejected before inbox
 * mutation, never silently converted into a different behavior.
 */
export interface AgentEngineCapabilities {
  /** How the engine streams assistant text: per-delta or per-settled-item. */
  readonly textStream: 'delta' | 'item'
  /** Whether the engine accepts active-turn steering (`Agent.steer`). */
  readonly steering: 'active-turn' | 'unsupported'
  /** Whether the engine resumes a persisted native identity. */
  readonly resume: 'native' | 'unsupported'
  /** Whether the engine forks a native session. */
  readonly fork: 'native' | 'unsupported'
  /** Whether the engine supports approvals. */
  readonly approval: boolean
  /** Whether the engine supports user input mid-turn. */
  readonly userInput: boolean
  /** Whether the engine supports attachments. */
  readonly attachment: boolean
}

/** Provider-owned execution retained by the shared Agent lifecycle. */
export interface EngineTurnDriver {
  /**
   * Validate and bind execution without submitting user input.
   * @param selection - complete session selection.
   * @param signal - admission cancellation.
   * @returns after the selected route is ready to accept input.
   */
  prepare(selection: ModelSelection, signal: AbortSignal): Promise<void>
  /**
   * Execute one accepted turn and publish observable chunks.
   * @param messages - accepted input in order.
   * @param signal - cancellation of this turn.
   * @param emit - transcript stream publisher; never executes tools.
   * @returns after authoritative native settlement.
   */
  run(messages: readonly UserMessage[], signal: AbortSignal, emit: (chunk: StreamChunk) => void): Promise<void>
  /** List slash commands available after the engine has been prepared. */
  commands?(): Promise<readonly AgentEngineCommand[]>
  /** Execute one engine action command that is not a prompt, such as Codex app-server compaction. */
  executeCommand?(name: string, args: string, signal: AbortSignal): Promise<void>
  /**
   * Context capacity in tokens for the prepared selection, when the engine has
   * resolved it from its native catalog or a native report. The shared loop
   * reads it around each turn and records changes as `request/context`.
   * @returns context window in tokens, or undefined while unknown.
   */
  contextWindow?(): number | undefined
  /** Stop and await owned execution during lifecycle disposal. */
  close(): Promise<void>
}

/**
 * One registered agent engine definition. A definition declares the endpoint
 * ids it routes to, so the engine resolved for a session selects which
 * provider endpoints its model catalog and call routing may use.
 */
export interface AgentEngineDefinition {
  /** Human-readable engine name for selectors. */
  readonly name: string
  /** Optional short description for selectors and diagnostics. */
  readonly description?: string
  /** Explicit capability modes. */
  readonly capabilities: AgentEngineCapabilities
  /**
   * Endpoint ids this engine routes to. Empty when the engine owns no LLM
   * endpoint of its own (the native loop routes through the regular LLM
   * registry). A model whose provider exposes no endpoint configured for the
   * active engine is not offered to that session.
   */
  readonly endpoints: readonly string[]
  /**
   * Resolve selectable reasoning and native parameter mappings for one exact route.
   * @param provider - configured provider identity.
   * @param model - exact model identity.
   * @param reasoning - model adapter metadata, when declared.
   * @returns engine-compatible reasoning metadata, or undefined for engine defaults only.
   */
  readonly resolveReasoning?: (
    provider: string,
    model: string,
    reasoning: LlmModelReasoningInfo | undefined,
  ) => LlmModelReasoningInfo | undefined
  /**
   * Engine-owned agent factory. When present, {@link AgentRegistry.create} and
   * {@link AgentRegistry.resume} route through this factory for the engine;
   * when absent they fall back to the single registered factory slot.
   */
  readonly factory?: AgentFactory
  /** Create the execution provider for a scoped, persistence-owned main Agent. */
  readonly driver?: (agent: Agent) => EngineTurnDriver
}

/** Public listing entry for one registered engine. */
export interface AgentEngineInfo {
  /** Branded engine identity. */
  readonly id: AgentEngineId
  /** Human-readable engine name. */
  readonly name: string
  /** Optional short description. */
  readonly description?: string
  /** Explicit capability modes. */
  readonly capabilities: AgentEngineCapabilities
  /** Endpoint ids this engine routes to. */
  readonly endpoints: readonly string[]
}

/** Identity of the native DSH loop engine. */
export const NATIVE_ENGINE_ID = AgentEngineId('native')

/** Capability modes of the native DSH loop engine. */
export const NATIVE_ENGINE_CAPABILITIES: AgentEngineCapabilities = {
  textStream: 'delta',
  steering: 'active-turn',
  resume: 'native',
  fork: 'native',
  approval: true,
  userInput: true,
  attachment: true,
}
