/** Stable per-session and process-shared Codex homes with legacy rollout migration. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { z } from 'zod'
import { mirrorFile, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function rolloutFiles(root: string, nativeId: string): Promise<string[]> {
  const found: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()
    if (dir === undefined) break
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error: unknown) {
      if (missing(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith(`-${nativeId}.jsonl`)) found.push(join(dir, entry.name))
    }
  }
  return found
}

async function validateRollout(path: string, nativeId: string, cwd: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    for await (const line of file.readLines({ autoClose: false })) {
      const header = z.object({ type: z.literal('session_meta'), payload: z.object({ id: z.string(), cwd: z.string() }) }).parse(JSON.parse(line))
      if (header.payload.id !== nativeId || header.payload.cwd !== cwd) throw new Error('Legacy Codex rollout identity or workspace differs from the session')
      return
    }
    throw new Error('Legacy Codex rollout is empty')
  } finally { await file.close() }
}

/** Native home and optional exact rollout path for persistent resume. */
export interface CodexSessionStorage {
  /** Stable per-session CODEX_HOME. */
  home: string
  /** Existing native history file; supplied to resume without a database-index race. */
  rolloutPath?: string
}

/** Write one least-privilege Codex profile for a Team execution generation. */
export async function writeTeamTaskPermissionProfile(
  home: string, profileId: string, writeScopes: readonly string[],
): Promise<void> {
  if (!/^dsh-task-[a-f0-9]{16}$/u.test(profileId)) throw new Error('invalid Agent Team Codex permission profile id')
  const lines = [
    `[permissions.${JSON.stringify(profileId)}]`,
    'extends = ":read-only"',
  ]
  if (writeScopes.length > 0) {
    lines.push('', `[permissions.${JSON.stringify(profileId)}.filesystem.":workspace_roots"]`)
    for (const scope of [...new Set(writeScopes)]) lines.push(`${JSON.stringify(scope)} = "write"`)
  }
  await writeFileAtomic(join(home, 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Prepare an isolated persistent native home without copying shared databases.
 * @param home - Harness home, independent of the user's personal Codex home.
 * @param sessionId - durable Harness identity; hashed to a safe directory component.
 * @param nativeId - acknowledged native UUID; omission creates a fresh home.
 * @param cwd - persisted workspace used to validate legacy migration.
 * @param hasHistory - whether this session has accepted user history and must retain its native identity.
 * @param userAgentsMd - the user's global `~/.codex/AGENTS.md` to mirror into the session home; null disables the mirror.
 * @returns the stable home and exact history path, when materialized.
 */
export async function prepareCodexHome(
  home: string, sessionId: SessionId, nativeId: string | undefined, cwd: string, hasHistory: boolean,
  userAgentsMd: string | null = null,
): Promise<CodexSessionStorage> {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  return prepareCodexHomeAt(join(home, 'engines', 'codex', 'session-homes', digest), home,
    nativeId, cwd, hasHistory, userAgentsMd, [])
}

/**
 * Prepare the process-shared native home every non-team conversation attaches
 * its thread through. Concurrent sessions share this home; older native state
 * migrates read-only, first from the legacy root and then from this session's
 * former per-session home, so committed generations are copied, never moved.
 * @param home - Harness home, independent of the user's personal Codex home.
 * @param sessionId - durable Harness identity; names the pre-shared per-session home to migrate from.
 * @param nativeId - acknowledged native UUID; omission creates a fresh home.
 * @param cwd - persisted workspace used to validate legacy migration.
 * @param hasHistory - whether this session has accepted user history and must retain its native identity.
 * @param userAgentsMd - the user's global `~/.codex/AGENTS.md` to mirror into the shared home; null disables the mirror.
 * @returns the stable shared home and exact history path, when materialized.
 */
export async function prepareSharedCodexHome(
  home: string, sessionId: SessionId | undefined, nativeId: string | undefined, cwd: string, hasHistory: boolean,
  userAgentsMd: string | null = null,
): Promise<CodexSessionStorage> {
  const legacy = join(home, 'engines', 'codex')
  const digest = sessionId === undefined ? undefined : createHash('sha256').update(sessionId).digest('hex')
  return prepareCodexHomeAt(join(legacy, 'shared-home'), home, nativeId, cwd, hasHistory, userAgentsMd,
    digest === undefined ? [] : [join(legacy, 'session-homes', digest, 'sessions')])
}

/** Shared home preparation behind both the per-session and process-shared layouts. */
async function prepareCodexHomeAt(
  storage: string, home: string, nativeId: string | undefined, cwd: string, hasHistory: boolean,
  userAgentsMd: string | null, migrationRoots: readonly string[],
): Promise<CodexSessionStorage> {
  const legacy = join(home, 'engines', 'codex')
  await mkdir(storage, { recursive: true, mode: 0o700 })
  // The native runtime reads the same `$CODEX_HOME/AGENTS.md` as a direct CLI
  // run; a null or missing source removes the stale mirror instead of keeping it.
  await mirrorFile(join(storage, 'AGENTS.md'), userAgentsMd)
  if (nativeId === undefined) return { home: storage }
  z.uuid().parse(nativeId)
  const destinationRoot = join(storage, 'sessions')
  const existing = await rolloutFiles(destinationRoot, nativeId)
  if (existing.length > 1) throw new Error('Several Codex rollouts claim the saved thread identity')
  if (existing[0] !== undefined) {
    await validateRollout(existing[0], nativeId, cwd)
    return { home: storage, rolloutPath: existing[0] }
  }
  const sourceRoots = [join(legacy, 'sessions'), ...migrationRoots]
  const sources: Array<{ root: string; path: string }> = []
  for (const root of sourceRoots) {
    for (const path of await rolloutFiles(root, nativeId)) sources.push({ root, path })
  }
  if (sources.length === 0 && !hasHistory) return { home: storage }
  if (sources.length !== 1 || sources[0] === undefined) throw new Error('Saved Codex history is missing or ambiguous; restore its native rollout before resuming')
  const source = sources[0]
  await validateRollout(source.path, nativeId, cwd)
  const destination = join(destinationRoot, relative(source.root, source.path))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  await copyFile(source.path, temporary, constants.COPYFILE_EXCL)
  try {
    await chmod(temporary, 0o600)
    try { await link(temporary, destination) } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      await validateRollout(destination, nativeId, cwd)
    }
  } finally { await unlink(temporary) }
  return { home: storage, rolloutPath: destination }
}
