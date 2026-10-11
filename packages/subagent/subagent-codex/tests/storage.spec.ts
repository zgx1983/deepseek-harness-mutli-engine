import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { prepareCodexHome, prepareSharedCodexHome, writeTeamTaskPermissionProfile } from '../src/storage.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const nativeId = '12345678-1234-4234-8234-123456789abc'
const cwd = '/workspace'
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-storage-'))
  roots.push(root)
  return root
}
async function legacy(root: string, workspace = cwd) {
  const dir = join(root, 'engines', 'codex', 'sessions', '2026', '10', '01')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-2026-10-01-${nativeId}.jsonl`)
  await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: workspace } })}\n{"type":"event_msg"}\n`)
  return path
}

describe('Codex main session storage', () => {
  it('writes generation-specific read-only profiles with only declared task write paths', async () => {
    const root = await home()
    const profile = 'dsh-task-0123456789abcdef'
    await writeTeamTaskPermissionProfile(root, profile, ['src', 'docs/report.md'])
    const config = await readFile(join(root, 'config.toml'), 'utf8')
    expect(config).toContain('[permissions."dsh-task-0123456789abcdef"]')
    expect(config).toContain('extends = ":read-only"')
    expect(config).toContain('[permissions."dsh-task-0123456789abcdef".filesystem.":workspace_roots"]')
    expect(config).toContain('"src" = "write"')
    expect(config).toContain('"docs/report.md" = "write"')
    await expect(writeTeamTaskPermissionProfile(root, 'invalid', [])).rejects.toThrow('invalid Agent Team')
  })

  it('isolates homes across sessions and keeps the same home across provider changes', async () => {
    const root = await home()
    const first = await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false)
    const again = await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false)
    const second = await prepareCodexHome(root, SessionId('../session-b'), undefined, cwd, false)
    expect(first).toEqual(again)
    expect(second.home).not.toBe(first.home)
    expect(second.home.startsWith(join(root, 'engines', 'codex', 'session-homes'))).toBe(true)
  })

  it('copies only the selected legacy rollout and preserves its source and existing isolated history', async () => {
    const root = await home()
    const source = await legacy(root)
    await writeFile(join(root, 'engines', 'codex', 'state.sqlite'), 'shared-db')
    const migrated = await prepareCodexHome(root, SessionId('session-a'), nativeId, cwd, true)
    expect(migrated.rolloutPath).toBeDefined()
    expect(await readFile(migrated.rolloutPath!, 'utf8')).toBe(await readFile(source, 'utf8'))
    await expect(readFile(join(migrated.home, 'state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(migrated.rolloutPath!, `${await readFile(source, 'utf8')}new-history\n`)
    await prepareCodexHome(root, SessionId('session-a'), nativeId, cwd, true)
    expect(await readFile(migrated.rolloutPath!, 'utf8')).toContain('new-history')
    expect(await readFile(source, 'utf8')).not.toContain('new-history')
  })

  it('allows a fresh thread when an empty draft native thread never materialized', async () => {
    expect((await prepareCodexHome(await home(), SessionId('draft'), nativeId, cwd, false)).rolloutPath).toBeUndefined()
  })

  it('rejects lost persisted history instead of starting an empty conversation', async () => {
    await expect(prepareCodexHome(await home(), SessionId('history'), nativeId, cwd, true)).rejects.toThrow('history is missing')
  })

  it('rejects a legacy history file from another workspace', async () => {
    const root = await home()
    await legacy(root, '/other-workspace')
    await expect(prepareCodexHome(root, SessionId('history'), nativeId, cwd, true)).rejects.toThrow('workspace differs')
  })

  it('mirrors the user AGENTS.md into the session home and refreshes it on change', async () => {
    const root = await home()
    const user = join(root, 'user')
    await mkdir(user)
    const source = join(user, 'AGENTS.md')
    await writeFile(source, 'prefer pnpm')

    const prepared = await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false, source)
    expect(await readFile(join(prepared.home, 'AGENTS.md'), 'utf8')).toBe('prefer pnpm')

    await writeFile(source, 'prefer pnpm v10')
    await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false, source)
    expect(await readFile(join(prepared.home, 'AGENTS.md'), 'utf8')).toBe('prefer pnpm v10')
  })

  it('removes the stale mirror when the user file disappears or mirroring is off', async () => {
    const root = await home()
    const user = join(root, 'user')
    await mkdir(user)
    const source = join(user, 'AGENTS.md')
    await writeFile(source, 'prefer pnpm')
    const prepared = await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false, source)

    await rm(source)
    await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false, source)
    await expect(readFile(join(prepared.home, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(source, 'prefer pnpm')
    await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false, source)
    await prepareCodexHome(root, SessionId('session-a'), undefined, cwd, false)
    await expect(readFile(join(prepared.home, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares one home across conversations and migrates legacy history into it once', async () => {
    const root = await home()
    const first = await prepareSharedCodexHome(root, SessionId('shared-a'), undefined, cwd, false)
    const second = await prepareSharedCodexHome(root, SessionId('shared-b'), undefined, cwd, false)
    expect(first.home).toBe(join(root, 'engines', 'codex', 'shared-home'))
    expect(second.home).toBe(first.home)

    const source = await legacy(root)
    const migrated = await prepareSharedCodexHome(root, SessionId('shared-a'), nativeId, cwd, true)
    expect(migrated.rolloutPath).toBeDefined()
    expect(migrated.rolloutPath).toContain(first.home)
    expect(await readFile(migrated.rolloutPath!, 'utf8')).toBe(await readFile(source, 'utf8'))
    // A rediscovery keeps the migrated file; the legacy source stays untouched.
    const again = await prepareSharedCodexHome(root, SessionId('shared-a'), nativeId, cwd, true)
    expect(again.rolloutPath).toBe(migrated.rolloutPath)
    expect(await readFile(source, 'utf8')).toBe(await readFile(migrated.rolloutPath!, 'utf8'))
  })

  it('migrates history from a pre-shared per-session home without moving it', async () => {
    const root = await home()
    const sessionId = SessionId('legacy-session')
    const digest = createHash('sha256').update(sessionId).digest('hex')
    const oldDir = join(root, 'engines', 'codex', 'session-homes', digest, 'sessions', '2026', '10', '01')
    await mkdir(oldDir, { recursive: true })
    const oldPath = join(oldDir, `rollout-2026-10-01-${nativeId}.jsonl`)
    const body = `${JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd } })}\n{"type":"event_msg"}\n`
    await writeFile(oldPath, body)

    const migrated = await prepareSharedCodexHome(root, sessionId, nativeId, cwd, true)
    expect(migrated.rolloutPath).toContain(join(root, 'engines', 'codex', 'shared-home'))
    expect(await readFile(migrated.rolloutPath!, 'utf8')).toBe(body)
    // The committed per-session generation stays in place.
    expect(await readFile(oldPath, 'utf8')).toBe(body)
  })
})
