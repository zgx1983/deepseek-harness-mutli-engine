/** Per-Team panel fold preferences kept in browser storage, never in the Session log. */

/** Storage namespace; the suffix bumps with the envelope shape. */
const STORAGE_KEY = 'dsh.agent-team-panel.v1'

/** Storage envelope: Team id → `section` or `section/group` → user-chosen expansion. */
type FoldEnvelope = Record<string, Record<string, boolean>>

function readEnvelope(): FoldEnvelope {
  if (typeof localStorage === 'undefined') return {}
  let raw: string | null
  try { raw = localStorage.getItem(STORAGE_KEY) }
  catch (_storageUnavailable) { return {} }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const envelope: FoldEnvelope = {}
    for (const [teamId, areas] of Object.entries(parsed)) {
      if (typeof areas !== 'object' || areas === null) continue
      const folds: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(areas as Record<string, unknown>)) {
        if (typeof value === 'boolean') folds[key] = value
      }
      envelope[teamId] = folds
    }
    return envelope
  } catch (_invalidJson) {
    return {}
  }
}

function writeEnvelope(envelope: FoldEnvelope): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope)) }
  catch (error) { console.error('Team panel preference persistence failed:', error) }
}

/**
 * Read one stored fold choice.
 * @param teamId - Team root Session id scoping the preference.
 * @param fold - Fold key: `section` for an area or `section/group` for one group.
 * @returns the user-chosen value, or undefined when that fold has no stored choice.
 */
export function readFold(teamId: string, fold: string): boolean | undefined {
  return readEnvelope()[teamId]?.[fold]
}

/**
 * Store one user fold choice; unread folds keep their defaults.
 * @param teamId - Team root Session id scoping the preference.
 * @param fold - Fold key: `section` for an area or `section/group` for one group.
 * @param expanded - Chosen expansion state.
 */
export function writeFold(teamId: string, fold: string, expanded: boolean): void {
  const envelope = readEnvelope()
  const folds = envelope[teamId] ?? {}
  writeEnvelope({ ...envelope, [teamId]: { ...folds, [fold]: expanded } })
}
