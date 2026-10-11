/**
 * Native Codex permission, workspace-trust, and project-document settings read
 * from the host's `~/.codex/config.toml`, plus the host's `~/.codex/rules`
 * files.
 *
 * The main engine no longer reads the host config: the session permission
 * preset is the only permission source, so nothing in this module is wired
 * into session preparation today. The functions are retained for a future
 * host-config integration, and {@link DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES}
 * remains the deployment default for project instruction fallbacks.
 *
 * @module @deepseek-ai/dsh-subagent-codex/user-config
 */

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { z } from 'zod'

/** Native approval policies accepted by the Codex configuration file. */
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never'] as const
/** Native sandbox modes accepted by the Codex configuration file. */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
/** Native approval reviewers accepted by the Codex configuration file. */
export const CODEX_APPROVAL_REVIEWERS = ['user', 'auto_review'] as const

/**
 * Project instruction filenames a session falls back to when the workspace has
 * no `AGENTS.md`, so a repository that documents itself in `CLAUDE.md` loads
 * the same way it does for a Claude Code session.
 */
export const DEFAULT_PROJECT_DOC_FALLBACK_FILENAMES = ['CLAUDE.md'] as const

/** Native approval policy an isolated session inherits from the host config. */
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number]
/** Native sandbox mode an isolated session inherits from the host config. */
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]
/** Native approval reviewer an isolated session inherits from the host config. */
export type CodexApprovalReviewer = (typeof CODEX_APPROVAL_REVIEWERS)[number]

/** The Codex configuration file facts one session reads from the host. */
export interface CodexUserConfig {
  /** Native approval policy; absent leaves the session permission preset in charge. */
  approvalPolicy?: CodexApprovalPolicy
  /** Native sandbox mode; absent leaves the session permission preset in charge. */
  sandboxMode?: CodexSandboxMode
  /** Native approval reviewer; absent leaves the session permission preset in charge. */
  approvalsReviewer?: CodexApprovalReviewer
  /** Native project instruction fallbacks; absent uses the deployment default. */
  projectDocFallbackFilenames?: string[]
  /** Native settings mirrored verbatim into the session home, when any apply. */
  mirror?: Record<string, unknown>
}

const userConfigSchema = z.looseObject({
  approval_policy: z.enum(CODEX_APPROVAL_POLICIES).optional(),
  sandbox_mode: z.enum(CODEX_SANDBOX_MODES).optional(),
  approvals_reviewer: z.enum(CODEX_APPROVAL_REVIEWERS).optional(),
  project_doc_max_bytes: z.number().int().nonnegative().optional(),
  project_doc_fallback_filenames: z.array(z.string().min(1)).optional(),
  sandbox_workspace_write: z.looseObject({}).optional(),
  projects: z.record(z.string(), z.looseObject({})).optional(),
})

/** Configuration keys the engine mirrors; every other key belongs to the runtime. */
const MIRRORED_KEYS = [
  'approval_policy', 'sandbox_mode', 'approvals_reviewer', 'project_doc_max_bytes',
  'project_doc_fallback_filenames', 'sandbox_workspace_write', 'projects',
] as const

/** Mirrored keys that decide what a session may do rather than what it reads. */
const PERMISSION_KEYS = new Set(['approval_policy', 'sandbox_mode', 'approvals_reviewer', 'sandbox_workspace_write'])

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

function parseExistingConfig(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = parseToml(raw) } catch (error) {
    throw new Error(`subagent-codex: cannot apply native settings over malformed ${path}`, { cause: error })
  }
  return asTable(parsed)
}

function asTable(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/**
 * Parse one native configuration file into the facts a session applies.
 * @param raw - complete `config.toml` text.
 * @param source - path reported in a parse or validation failure.
 * @returns native permission, trust, and project-document settings.
 */
export function parseCodexUserConfig(raw: string, source: string): CodexUserConfig {
  let parsed: unknown
  try { parsed = parseToml(raw) } catch (error) {
    throw new Error(`subagent-codex: cannot read native settings from malformed ${source}`, { cause: error })
  }
  let settings: z.infer<typeof userConfigSchema>
  try { settings = userConfigSchema.parse(parsed) } catch (error) {
    throw new Error(`subagent-codex: native settings in ${source} use a value the engine cannot apply`, { cause: error })
  }
  // Only the settings that decide permissions, workspace trust, and project
  // instructions travel into the session home; model, provider, MCP, plugin,
  // and credential-adjacent fields stay native to the host config.
  const mirror: Record<string, unknown> = {}
  if (settings.approval_policy !== undefined) mirror.approval_policy = settings.approval_policy
  if (settings.sandbox_mode !== undefined) mirror.sandbox_mode = settings.sandbox_mode
  if (settings.approvals_reviewer !== undefined) mirror.approvals_reviewer = settings.approvals_reviewer
  if (settings.project_doc_max_bytes !== undefined) mirror.project_doc_max_bytes = settings.project_doc_max_bytes
  if (settings.project_doc_fallback_filenames !== undefined) {
    mirror.project_doc_fallback_filenames = settings.project_doc_fallback_filenames
  }
  if (settings.sandbox_workspace_write !== undefined) mirror.sandbox_workspace_write = settings.sandbox_workspace_write
  if (settings.projects !== undefined) mirror.projects = settings.projects
  return {
    ...settings.approval_policy === undefined ? {} : { approvalPolicy: settings.approval_policy },
    ...settings.sandbox_mode === undefined ? {} : { sandboxMode: settings.sandbox_mode },
    ...settings.approvals_reviewer === undefined ? {} : { approvalsReviewer: settings.approvals_reviewer },
    ...settings.project_doc_fallback_filenames === undefined
      ? {} : { projectDocFallbackFilenames: settings.project_doc_fallback_filenames },
    ...Object.keys(mirror).length === 0 ? {} : { mirror },
  }
}

/**
 * Read the host's native Codex settings. A missing configuration file yields no
 * native overrides; a malformed or invalid file fails loudly instead of
 * silently dropping native permissions.
 * @param userCodexDir - the user's real `~/.codex` directory.
 * @returns the native settings a session applies, empty when the host sets none.
 */
export async function readCodexUserConfig(userCodexDir: string): Promise<CodexUserConfig> {
  const source = join(userCodexDir, 'config.toml')
  let raw: string
  try { raw = await readFile(source, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
    throw error
  }
  return parseCodexUserConfig(raw, source)
}

/** One verbatim host rule file mirrored into a session home. */
export interface CodexHostRule {
  /** File name inside `rules/`, always ending in `.rules`. */
  name: string
  /** Complete file text; the native Codex runtime parses it. */
  content: string
}

/** Process-level snapshot of the host's native Codex configuration. */
export interface CodexHostConfig {
  /** Parsed `config.toml` settings a session applies. */
  config: CodexUserConfig
  /** Verbatim `rules/*.rules` files, in file-name order; empty without a rules directory. */
  rules: CodexHostRule[]
}

/**
 * Read the host's native configuration into a process-level snapshot: the
 * `config.toml` settings plus every `rules/*.rules` file. Rules are mirrored
 * verbatim and parsed by the native Codex runtime, so only their readability
 * is checked here. A missing config file or rules directory contributes
 * nothing; an unreadable or malformed file fails loudly.
 * @param userCodexDir - the user's real `~/.codex` directory.
 * @returns the snapshot every session of this process applies.
 */
export async function readCodexHostConfig(userCodexDir: string): Promise<CodexHostConfig> {
  const rulesDir = join(userCodexDir, 'rules')
  let entries
  try { entries = await readdir(rulesDir, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    return { config: await readCodexUserConfig(userCodexDir), rules: [] }
  }
  const rules: CodexHostRule[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.rules')) continue
    rules.push({ name: entry.name, content: await readFile(join(rulesDir, entry.name), 'utf8') })
  }
  return { config: await readCodexUserConfig(userCodexDir), rules }
}

/**
 * Mirror the snapshot's rule files into the per-session `CODEX_HOME`. Rule
 * content stays verbatim — the native runtime parses it — and stale mirrored
 * `.rules` files are removed, so an empty list clears the session home.
 * @param storage - the engine-owned session home the app-server reads.
 * @param rules - rules from the snapshot read by {@link readCodexHostConfig}.
 */
export async function mirrorCodexRules(storage: string, rules: readonly CodexHostRule[]): Promise<void> {
  const rulesDir = join(storage, 'rules')
  const wanted = new Map(rules.map(rule => [rule.name, rule]))
  let existing: string[] = []
  try { existing = (await readdir(rulesDir)).filter(name => name.endsWith('.rules')) } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  for (const name of existing) {
    if (!wanted.has(name)) await rm(join(rulesDir, name), { force: true })
  }
  if (wanted.size === 0) return
  await mkdir(rulesDir, { recursive: true, mode: 0o700 })
  for (const [name, rule] of wanted) {
    const target = join(rulesDir, name)
    let current: string | undefined
    try { current = await readFile(target, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    if (current !== rule.content) await writeFileAtomic(target, rule.content, { mode: 0o600 })
  }
}

/**
 * Mirror the read native settings into the per-session `CODEX_HOME`. Keys the
 * engine mirrors are refreshed from the host config and, when the host stops
 * setting them, removed; everything else in that file is preserved. The native
 * runtime records its own workspace trust there, and the host entry wins only
 * for the paths the host config names.
 * @param storage - the engine-owned session home the app-server reads.
 * @param native - settings returned by {@link readCodexUserConfig}.
 */
export async function mirrorUserCodexConfig(storage: string, native: CodexUserConfig): Promise<void> {
  const target = join(storage, 'config.toml')
  const current = await readOptional(target)
  const existing = current === undefined ? {} : parseExistingConfig(current, target)
  const managed = new Set<string>(MIRRORED_KEYS)
  const merged: Record<string, unknown> = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !managed.has(key)),
  )
  const mirror = native.mirror ?? {}
  for (const [key, value] of Object.entries(mirror)) {
    if (key !== 'projects') merged[key] = value
  }
  const projects = { ...asTable(existing.projects), ...asTable(mirror.projects) }
  if (Object.keys(projects).length > 0) merged.projects = projects
  if (Object.keys(merged).length === 0) {
    await rm(target, { force: true })
    return
  }
  const content = `${stringifyToml(merged)}\n`
  if (content !== current) await writeFileAtomic(target, content, { mode: 0o600 })
}

/**
 * Drop every native permission decision while keeping workspace trust and
 * project-document sources. A session that grants full access applies this, so
 * the host config can neither restrict nor redefine the chosen access.
 * @param native - settings read from the host config.
 * @returns the same settings without native permission fields or mirror keys.
 */
export function withoutNativePermissions(native: CodexUserConfig): CodexUserConfig {
  const mirror = native.mirror === undefined ? undefined
    : Object.fromEntries(Object.entries(native.mirror).filter(([key]) => !PERMISSION_KEYS.has(key)))
  return {
    ...native.projectDocFallbackFilenames === undefined
      ? {} : { projectDocFallbackFilenames: native.projectDocFallbackFilenames },
    ...mirror === undefined || Object.keys(mirror).length === 0 ? {} : { mirror },
  }
}

/** Permission values one session's thread receives. */
export interface CodexPermissionSettings {
  /** Sandbox mode handed to `thread/start` or `thread/resume`. */
  sandbox: CodexSandboxMode
  /** Approval policy handed to the thread request. */
  approvalPolicy: CodexApprovalPolicy
  /** Approval reviewer handed to the thread request. */
  approvalsReviewer: CodexApprovalReviewer
}

/**
 * Choose the native permission values a session runs under. Each field the host
 * config sets is authoritative; the session permission preset supplies only the
 * fields the host config leaves unset.
 * @param native - settings read from the host config; omission applies the preset alone.
 * @param fallback - session permission preset values.
 * @returns the effective thread permission settings.
 */
export function resolveCodexPermissions(
  native: CodexUserConfig | undefined, fallback: CodexPermissionSettings,
): CodexPermissionSettings {
  return {
    sandbox: native?.sandboxMode ?? fallback.sandbox,
    approvalPolicy: native?.approvalPolicy ?? fallback.approvalPolicy,
    approvalsReviewer: native?.approvalsReviewer ?? fallback.approvalsReviewer,
  }
}

/**
 * Choose the project instruction filenames Codex falls back to when the
 * workspace has no `AGENTS.md`. A native list is authoritative; otherwise the
 * deployment default applies.
 * @param native - native fallback filenames, when the host config sets them.
 * @param configured - deployment default filenames.
 * @returns filenames to pass to the app-server, empty when none apply.
 */
export function resolveProjectDocFallbackFilenames(
  native: readonly string[] | undefined, configured: readonly string[],
): string[] {
  return [...native ?? configured]
}
