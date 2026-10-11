/** Durable execution-engine selection projection: the engine selected before the first user message. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Durable fold state: the resolved engine id, or null before selection. */
export interface EngineSelectionProjectionState {
  readonly engineId: string | null
  /** Whether a user message has committed the engine choice. */
  readonly locked?: boolean
}

/** Client view of the durable engine-selection fold. */
export interface EngineSelectionProjection {
  readonly engineId: string | null
  /** Whether a user message has committed the engine choice. */
  readonly locked?: boolean
}

const engineSelectionStateSchema = z.object({
  engineId: z.string().min(1).nullable(),
  locked: z.boolean().optional(),
}) as z.ZodType<EngineSelectionProjectionState>

const engineSelectionProjectionSchema = z.object({
  engineId: z.string().min(1).nullable(),
  locked: z.boolean().optional(),
}) as z.ZodType<EngineSelectionProjection>

/**
 * Advance durable engine-selection state by one Session event. The last
 * `engine/selected` event wins until the first user message locks the choice.
 * @param state - engine state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced engine state.
 */
function applyEngineSelectionProjection(
  state: EngineSelectionProjectionState,
  event: SessionEvent,
): EngineSelectionProjectionState {
  if (event.type === 'user/message' || (event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.source.kind === 'user'))) return { engineId: state.engineId ?? 'native', locked: true }
  if (event.type !== 'engine/selected' || state.locked === true) return state
  const engineId = typeof event.data.engineId === 'string' && event.data.engineId.length > 0
    ? event.data.engineId
    : null
  return engineId === state.engineId ? state : { engineId, locked: false }
}

const engineSelectionProjection = {
  key: 'engineSelection',
  stateSchema: engineSelectionStateSchema,
  init: () => ({ engineId: null, locked: false }),
  apply: applyEngineSelectionProjection,
  wire: {
    viewSchema: engineSelectionProjectionSchema,
    view: state => ({ engineId: state.engineId, locked: state.locked === true }),
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'engineSelection', EngineSelectionProjectionState>

/**
 * Register the durable engine-selection projection when the registry is present.
 * @param ctx - Session Controller context.
 */
export function installEngineSelectionProjection(ctx: Context): void {
  ctx.sessionProjections.register(engineSelectionProjection)
}
