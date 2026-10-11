/** Fold state hooks backing the Team panel's collapsible areas and groups. */
import { useCallback, useState } from 'react'
import { readFold, writeFold } from './collapse-preferences.ts'

/** Stored override plus the team scope it was read for; re-reads on team switch. */
interface StoredOverride {
  readonly key: string
  readonly value: boolean | undefined
}

/**
 * Expansion state of one collapsible unit with a stored user override.
 * @param teamId - team whose stored fold preference applies.
 * @param fold - stable fold key inside that team.
 * @param defaultExpanded - value used before any stored override exists.
 * @returns the current expansion and its setter, which persists the override.
 */
export function useFold(teamId: string, fold: string, defaultExpanded: boolean): readonly [boolean, (expanded: boolean) => void] {
  const key = `${teamId}/${fold}`
  const [stored, setStored] = useState<StoredOverride>(() => ({ key, value: readFold(teamId, fold) }))
  if (stored.key !== key) setStored({ key, value: readFold(teamId, fold) })
  const setExpanded = useCallback((expanded: boolean): void => {
    setStored({ key, value: expanded })
    writeFold(teamId, fold, expanded)
  }, [teamId, fold])
  return [stored.value ?? defaultExpanded, setExpanded] as const
}

/** Fold controls for one area header plus its independently folded groups. */
export interface AreaFolds {
  readonly areaExpanded: boolean
  readonly setAreaExpanded: (expanded: boolean) => void
  readonly groupExpanded: (group: string) => boolean
  readonly setGroupExpanded: (group: string, expanded: boolean) => void
  /** Apply one expansion to the given currently rendered groups. */
  readonly setAllGroups: (expanded: boolean, groups: readonly string[]) => void
}

/** Stored overrides for one area; re-read whenever the team scope changes. */
interface StoredArea {
  readonly key: string
  readonly area: boolean | undefined
  readonly groups: Record<string, boolean>
}

function readStoredArea(teamId: string, area: string, groupKeys: readonly string[]): StoredArea {
  const groups: Record<string, boolean> = {}
  for (const group of groupKeys) {
    const stored = readFold(teamId, `${area}/${group}`)
    if (stored !== undefined) groups[group] = stored
  }
  return { key: teamId, area: readFold(teamId, area), groups }
}

/**
 * Back one collapsible area and its per-group folds with Team-scoped
 * preferences. Groups without a stored choice keep their default, so groups
 * that appear later render by the default rule instead of inheriting an
 * expand-all earlier applied to other groups.
 * @param teamId - Team root Session id scoping the stored choices.
 * @param area - Area fold key, also the prefix of every group key.
 * @param groupDefaults - Default expansion per group key.
 * @returns Area and group fold state plus user-facing mutators.
 */
export function useAreaFolds(teamId: string, area: string, groupDefaults: Readonly<Record<string, boolean>>): AreaFolds {
  const [stored, setStored] = useState<StoredArea>(() => readStoredArea(teamId, area, Object.keys(groupDefaults)))
  if (stored.key !== teamId) setStored(readStoredArea(teamId, area, Object.keys(groupDefaults)))

  const setAreaExpanded = useCallback((expanded: boolean): void => {
    setStored(current => ({ ...current, area: expanded }))
    writeFold(teamId, area, expanded)
  }, [teamId, area])

  const setGroupExpanded = useCallback((group: string, expanded: boolean): void => {
    setStored(current => ({ ...current, groups: { ...current.groups, [group]: expanded } }))
    writeFold(teamId, `${area}/${group}`, expanded)
  }, [teamId, area])

  const setAllGroups = useCallback((expanded: boolean, groups: readonly string[]): void => {
    setStored(current => ({ ...current, groups: { ...current.groups, ...Object.fromEntries(groups.map(group => [group, expanded])) } }))
    for (const group of groups) writeFold(teamId, `${area}/${group}`, expanded)
  }, [teamId, area])

  return {
    areaExpanded: stored.area ?? true,
    setAreaExpanded,
    groupExpanded: group => stored.groups[group] ?? groupDefaults[group] ?? true,
    setGroupExpanded,
    setAllGroups,
  }
}
