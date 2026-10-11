import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/** Context usage rendered by conversation and Chat status surfaces. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Resolve bounded display occupancy from independently updated pressure fields.
 * @param pressure - latest token-meter projection.
 * @param exactOnly - use the latest engine report without Harness surface estimates.
 * @returns occupancy, or null until numerator and capacity are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
  exactOnly = false,
): ContextOccupancy | null {
  const usedTokens = exactOnly
    ? pressure?.pressureTokens
    : pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}
