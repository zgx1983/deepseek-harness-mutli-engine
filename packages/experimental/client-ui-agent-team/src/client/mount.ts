/** Source-safe Agent Teams browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamDashboard, TeamDashboardTitle } from './TeamDashboard.tsx'
import { TeamAction, type TeamActionInjected } from './TeamAction.tsx'
import { WorkflowPlanCard } from './WorkflowPlanCard.tsx'
import { workflowDefinition } from './workflow-definition.ts'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    'agent-team': TeamKey
  }
}

/** Required browser services for navigation, slots, conversation nodes, and localized copy. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiConversation']

/**
 * Register the Team locale dictionaries, the conversation-header action, and
 * the workflow plan Conversation card. The panel reads the Lead Session's
 * `agentTeam` projection from the shared Session store; this registration
 * performs no Team RPC.
 * @param ctx - Client Context carrying the injected navigation, locale, slot, conversation, and Session services.
 */
export function registerAgentTeamUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-team: dictionaries')
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const dashboardId = '@deepseek-ai/dsh-experimental-client-ui-agent-team'
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: dashboardId, kind: 'agent-team', title: () => t('dashboard.title'),
    guide: [{ id: 'agent-team', order: 20, title: () => t('dashboard.title'), icon: IconUsersOutlineRegular }],
  }), 'client-ui-agent-team: dashboard type')
  const actions: TeamActionInjected = {
    openDashboard(sessionId) {
      ctx.sidebarRight.openTabIn(sessionId, 'agent-team')
    },
    openTeammate(sessionId: SessionId, childSessionId: SessionId): void {
      const parentSessionId = leadSessionId(sessionId)
      if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      if (childSessionId === parentSessionId) {
        ctx.uiWorkspace.openSession(parentSessionId)
        return
      }
      ctx.uiWorkspace.openSession({
        parentSessionId,
        childSessionId,
        mode: 'continuable',
      })
    },
  }

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: dashboardId, locale: NS, inject: () => actions,
  }, TeamDashboard))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: dashboardId, locale: NS,
  }, TeamDashboardTitle))

  ctx.effect(() => ctx.uiConversation.events.register(workflowDefinition), 'client-ui-agent-team: workflow definition')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'team-workflow', locale: NS,
  }, WorkflowPlanCard))

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: -20,
      locale: NS,
      inject: () => actions,
    }, TeamAction),
  )
}
