/** Conversation definition folding `team_workflow_create` calls into one durable plan card. */
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { workflowPlan, type WorkflowPlan } from './workflow-plan.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Workflow plan submitted through `team_workflow_create`, stages in call order. */
    'team-workflow': WorkflowPlan
  }
}

/** One card per invocation; a settled PTC dispatch keeps the original card. */
export const workflowDefinition: ConversationNodeDefinition<WorkflowPlan> = {
  kind: 'team-workflow',
  target: 'chat',
  match: (event) => {
    const plan = workflowPlan(event)
    return plan === undefined ? null : { id: plan.callId, role: event.type === 'tool/ptc-dispatch' ? 'update' : 'start' }
  },
  start: (_context, match) => workflowPlan(match.event) as WorkflowPlan,
  update: context => context.state,
  buildViewNode: (context) => {
    const start = context.start ?? context.matches[0]
    const data = context.state ?? (start === undefined ? undefined : workflowPlan(start.event))
    if (data === undefined || start === undefined) return null
    return {
      key: context.key, kind: 'team-workflow', id: context.id, target: 'chat',
      anchorSeq: start.event.seq, location: start.location, visibility: 'visible', data,
    } satisfies ChatNode<'team-workflow'>
  },
}
