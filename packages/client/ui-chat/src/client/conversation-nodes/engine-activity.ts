/** External SDK activity cards reuse tool presentation without creating executable tool events. */
import type { Context } from '@deepseek-ai/cordis'
import type { EngineActivityRecord } from '@deepseek-ai/dsh-agent/types'
import type { ConversationNodeDefinition, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

interface ActivityState {
  readonly seq: number
  readonly time: number
  readonly id: string
  readonly revision: number
  readonly value: EngineActivityRecord
}

function parse(value: unknown): EngineActivityRecord {
  if (value === null || typeof value !== 'object'
    || !('name' in value) || typeof value.name !== 'string'
    || !('argsRaw' in value) || typeof value.argsRaw !== 'string'
    || !('output' in value) || typeof value.output !== 'string'
    || !('status' in value) || !['running', 'completed', 'failed'].includes(String(value.status))) {
    throw new Error('Invalid persisted external activity')
  }
  const status = value.status
  if (status !== 'running' && status !== 'completed' && status !== 'failed') throw new Error('Invalid native activity status')
  return { name: value.name, argsRaw: value.argsRaw, output: value.output, status }
}

/** One durable SDK operation, updated in place by its native identity and revision. */
const definition: ConversationNodeDefinition<ActivityState> = {
  kind: 'engine-activity', target: 'chat',
  match: event => event.type === 'engine/item-settled' && event.data.category === 'activity'
    ? { id: event.data.nativeItemId, role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'engine/item-settled') throw new Error('External activity requires an engine item')
    return { seq: match.event.seq, time: match.event.time, id: match.event.data.nativeItemId,
      revision: match.event.data.revision, value: parse(match.event.data.payload),
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'engine/item-settled' || match.event.data.revision <= context.state.revision) return context.state
    return { ...context.state, revision: match.event.data.revision, value: parse(match.event.data.payload) }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const location = context.start?.location
    const turn = location?.kind === 'step' || location?.kind === 'turn' ? location.turn.turn : 0
    const root: ToolCallBlock = state.value.status === 'running'
      ? { phase: 'start', callId: state.id, name: state.value.name, argsRaw: state.value.argsRaw,
        turn, step: location?.kind === 'step' ? location.step.step : 1, time: state.time, subCalls: [],
      }
      : { kind: 'tool-result', seq: state.seq, time: state.time, callId: state.id,
        call: { name: state.value.name, argsRaw: state.value.argsRaw }, callTime: state.time,
        content: [{ type: 'text', text: state.value.output }], isError: state.value.status === 'failed', subCalls: [],
      }
    return chatNode(context, 'tool-call', state.seq, { root })
  },
}

/**
 * Install engine-independent native activity presentation.
 * @param ctx - owning conversation context.
 */
export function registerEngineActivity(ctx: Context): void {
  ctx.uiConversation.events.register(definition)
}
