/** Durable read-only projection of children owned by external execution engines. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EngineSubagentId } from '@deepseek-ai/dsh-agent/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { EngineSubagentRecord } from '@deepseek-ai/dsh-agent/types'

const recordSchema: z.ZodType<EngineSubagentRecord> = z.object({
  engine: z.enum(['claude', 'codex']), id: z.string().min(1).transform(value => brandString<EngineSubagentId>(value)), title: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'stopped', 'unknown']),
  startedAt: z.number().nonnegative().optional(), endedAt: z.number().nonnegative().optional(),
  model: z.string().optional(), progress: z.string(), output: z.string(),
  parentId: z.string().transform(value => brandString<EngineSubagentId>(value)).optional(),
}).strict()
const stateSchema = z.array(recordSchema)

import type {} from './types.ts'

/** Complete child snapshot carried by existing projection RPC and stream updates. */
export const engineSubagentProjection = {
  key: 'engineSubagents', stateVersion: 1, stateSchema,
  init: () => [],
  apply(state, event) {
    if (event.type !== 'engine/item-settled') return state
    if (event.data.category === 'subagent-disconnected') {
      const marker = z.object({ engine: z.enum(['claude', 'codex']) }).strict().parse(event.data.payload)
      if (!state.some(child => child.engine === marker.engine && ['running', 'pending'].includes(child.status))) return state
      return state.map(child => child.engine === marker.engine && ['running', 'pending'].includes(child.status)
        ? { ...child, status: 'unknown' as const } : child)
    }
    if (event.data.category !== 'subagent') return state
    const child = recordSchema.parse(event.data.payload)
    const index = state.findIndex(previous => previous.engine === child.engine && previous.id === child.id)
    if (index < 0) return [...state, child]
    const previous = state[index]
    const next = [...state]
    next[index] = { ...child,
      ...previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt },
    }
    return next
  },
  wire: { viewSchema: stateSchema, view: state => state },
} satisfies ProjectionDefinition<'engineSubagents'>
