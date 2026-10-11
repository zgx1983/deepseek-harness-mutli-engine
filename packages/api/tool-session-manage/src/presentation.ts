/**
 * Generic tool-call presentation for the session-manage tools.
 *
 * @module @deepseek-ai/dsh-tool-session-manage/presentation
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ListModelsArgs, SessionCreateArgs } from './input.ts'

function presentListProjectsCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List projects' }
}

function presentListEnginesCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List engines' }
}

function presentListModelsCall(args: ListModelsArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'read',
    title: args.engine_id === undefined ? 'List models' : `List ${args.engine_id} models`,
  }
}

function presentSessionCreateCall(args: SessionCreateArgs): GenericCallView {
  const target = args.workspace_id ?? args.cwd ?? ''
  const detail = [args.engine_id, args.model].filter(value => value !== undefined).join(' · ')
  return {
    card: 'generic',
    kind: 'other',
    title: 'Create session',
    rawInput: detail.length === 0 ? target : `${target} (${detail})`,
  }
}

/** Pending-call cards for every session-manage tool. */
export const presentation = {
  presentListProjectsCall,
  presentListEnginesCall,
  presentListModelsCall,
  presentSessionCreateCall,
}
