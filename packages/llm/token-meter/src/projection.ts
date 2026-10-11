/**
 * Pure client-safe token-projection vocabulary.
 *
 * @module @deepseek-ai/dsh-token-meter/projection
 */

/**
 * Durable cumulative provider usage for a complete session log.
 *
 * The four buckets are disjoint. In particular, reasoning tokens are already
 * included in `outputTokens` and are not accumulated again.
 */
export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * Engine-reported cumulative whole-session token total, present only when the
   * adapter surfaces a running session total. Per-call adapters omit it, and
   * consumers then sum the four buckets instead.
   */
  sessionTotalTokens?: number
}

/**
 * Approximate context occupancy for a status display.
 *
 * The fields, when present, are deliberately NOT one atomic request
 * observation: the latest request route owns the capacity. A provider/model
 * change clears the prior route's pressure until that route reports usage, so
 * the UI never divides one model's prompt size by another model's capacity.
 * Surface deltas remain approximate and are not a billing or gating input.
 */
export interface ContextPressureProjection {
  /** Provider of the latest request route. */
  provider?: string
  /** Model associated with the latest route and any later usage sample. */
  model?: string
  /**
   * Provider-reported prompt size of the most recent request: uncached input
   * plus cache reads and writes. Response output is excluded, so this does not
   * grow as the current turn streams. Absent until a provider reports usage.
   */
  pressureTokens?: number
  /**
   * What the NEXT request's prompt would cost: {@link pressureTokens} plus the
   * heuristic repricing of everything the surface gained or lost since that
   * sample. Only the delta is estimated, so the figure stays anchored to the
   * provider while still reacting the moment a compaction shadows a span —
   * which `pressureTokens` alone cannot do, since compaction reports no usage
   * of its own. Absent until a provider reports usage.
   */
  projectedTokens?: number
  /**
   * True when {@link pressureTokens} is the engine's own whole-context occupancy
   * reading (a `contextInputTokens` sample) rather than the per-call prompt-size
   * fallback. Consumers show `pressureTokens` directly only when this is true;
   * otherwise they use {@link projectedTokens} as a heuristic estimate.
   */
  reportedOccupancy?: boolean
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
}

/**
 * Heuristic composition of the next request's context: what the prompt is
 * made of, not what it costs. All three figures use the meter's fixed
 * density estimate, so they will not sum to the provider-anchored
 * `projectedTokens`: the estimator systematically underprices CJK text and
 * JSON schemas, which is exactly the error the anchoring in
 * {@link ContextPressureProjection.projectedTokens} keeps out of the occupancy
 * figure. Present these as approximations of composition, never as a total.
 */
export interface ContextBreakdownProjection {
  /** Heuristic tokens of the last nonempty surviving system prompt in surface order; 0 when none exists. */
  systemTokens: number
  /** Heuristic tokens of the newest request envelope's tool schemas; 0 before any request. */
  toolsTokens: number
  /** Heuristic tokens of every other visible surface node, including superseded system prompts. */
  messageTokens: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Heuristic system/tools/message composition of the next request. */
    contextBreakdown: ContextBreakdownProjection
  }
}
