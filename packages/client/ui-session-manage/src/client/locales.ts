/** `session-manage` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'session-manage'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '创建会话',
  'row.preparing': '准备创建会话',
  'row.running': '正在创建会话',
  'row.failed': '会话创建失败',
  'row.open': '打开会话',
} satisfies Record<string, string>

/** The session-manage namespace key union. */
export type SessionManageKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Create session',
  'row.preparing': 'Preparing to create a session',
  'row.running': 'Creating session',
  'row.failed': 'Session creation failed',
  'row.open': 'Open session',
} satisfies Record<SessionManageKey, string>
