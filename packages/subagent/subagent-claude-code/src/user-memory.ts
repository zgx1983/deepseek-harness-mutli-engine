/**
 * Mirrors of the user's global Claude memory into the engine-owned config
 * home.
 *
 * {@link mirrorUserMemory} runs on every session start. The host permission
 * snapshot functions ({@link readClaudeHostPermissions},
 * {@link applyClaudeHostPermissions}, {@link clearUserPermissions}) are
 * retained for a future host-permission integration; the main engine no
 * longer reads the host `permissions` section — the session permission
 * preset is the only permission source — so nothing calls them today.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/user-memory
 */

import { mirrorFile, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Mirror the user's global `CLAUDE.md` into the engine's redirected
 * `CLAUDE_CONFIG_DIR`, so a `user` setting source reads the same instructions
 * as a native CLI run while credentials and sessions stay isolated.
 * A missing source removes the stale mirror instead of keeping old instructions.
 * @param storage - the engine-owned config home the CLI reads user memory from.
 * @param userClaudeDir - the user's real `~/.claude` directory.
 */
export async function mirrorUserMemory(storage: string, userClaudeDir: string): Promise<void> {
  await mirrorFile(join(storage, 'CLAUDE.md'), join(userClaudeDir, 'CLAUDE.md'))
}

/** The global settings fields the snapshot projects; everything else stays isolated. */
const userPermissionsSchema = z.object({
  permissions: z.looseObject({}).optional(),
}).loose()

/** Process-level snapshot of the host's Claude permission settings. */
export interface ClaudeHostPermissions {
  /** The validated `permissions` section, when the host settings define one. */
  permissions?: Record<string, unknown>
}

/**
 * Read and validate the `permissions` section of the user's global
 * `settings.json` into a process-level snapshot. A missing file is an empty
 * snapshot; a malformed or invalid file fails loudly instead of silently
 * dropping native permission rules.
 * @param userClaudeDir - the user's real `~/.claude` directory.
 * @returns the snapshot every session of this process applies.
 */
export async function readClaudeHostPermissions(userClaudeDir: string): Promise<ClaudeHostPermissions> {
  const source = join(userClaudeDir, 'settings.json')
  let raw: string
  try { raw = await readFile(source, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    return {}
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) {
    throw new Error(`subagent-claude-code: cannot read permission settings from malformed ${source}`, { cause: error })
  }
  const settings = userPermissionsSchema.parse(parsed)
  return settings.permissions === undefined ? {} : { permissions: settings.permissions }
}

/**
 * Remove the mirrored permission rules from the engine config home. A session
 * that grants full access translates into the native bypass mode and must not
 * keep reading allow/ask/deny rules or a `defaultMode` from the host.
 * @param storage - the engine-owned config home the CLI reads user settings from.
 */
export async function clearUserPermissions(storage: string): Promise<void> {
  await rm(join(storage, 'settings.json'), { force: true })
}

/**
 * Apply a permission snapshot into the engine's redirected `CLAUDE_CONFIG_DIR`,
 * so a `user` setting source applies the same allow/ask/deny rules and
 * `defaultMode` as a native CLI run while `env`, credentials, and every other
 * settings field stay isolated. `storage/settings.json` is engine-managed:
 * hand-placed content is replaced. An empty snapshot removes the stale mirror.
 * @param storage - the engine-owned config home the CLI reads user settings from.
 * @param snapshot - permissions read by {@link readClaudeHostPermissions}.
 */
export async function applyClaudeHostPermissions(storage: string, snapshot: ClaudeHostPermissions): Promise<void> {
  const target = join(storage, 'settings.json')
  if (snapshot.permissions === undefined) {
    await rm(target, { force: true })
    return
  }
  const content = `${JSON.stringify({ permissions: snapshot.permissions }, null, 2)}\n`
  let current: string | undefined
  try { current = await readFile(target, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  if (current !== content) await writeFileAtomic(target, content, { mode: 0o600 })
}
