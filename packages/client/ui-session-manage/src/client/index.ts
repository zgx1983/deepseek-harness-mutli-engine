/**
 * Session-manage browser half: registers the `session_create` keyed toolview
 * with an open-session action. The card derives everything from the durable
 * call slice — the result `meta` (sessionId, engineId, model, title, reused)
 * persisted by the Host tool's `presentationMeta` — so replay renders the
 * same card without any live Host lookup.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, NS, zh, type SessionManageKey } from './locales.ts'
import { SessionCreateRow } from './SessionCreateRow.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated session_create tool row's copy. */
    'session-manage': SessionManageKey
  }
}

/** Required services: the tool-row and locale registries plus navigation feeds. */
export const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

/**
 * Client plugin body: register the dictionaries and the keyed tool row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-manage: dictionaries')
  const openSession = (id: string): void => {
    // Only sessions the Host list still carries are reachable; a dropped or
    // archived row renders its card without a dead navigation target.
    if (!ctx.sessions.list.getSnapshot().ids.includes(SessionId(id))) return
    ctx.uiWorkspace.openSession(SessionId(id))
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'session_create', priority: -10, locale: NS, inject: () => ({ openSession }) },
    SessionCreateRow,
  ))
}
