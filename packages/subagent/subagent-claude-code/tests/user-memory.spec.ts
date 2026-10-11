import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyClaudeHostPermissions, clearUserPermissions, mirrorUserMemory, readClaudeHostPermissions,
} from '../src/user-memory.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-user-memory-'))
  roots.push(root)
  const storage = join(root, 'engines', 'claude')
  const userClaude = join(root, 'home', '.claude')
  await mkdir(storage, { recursive: true })
  await mkdir(userClaude, { recursive: true })
  return { storage, userClaude }
}

describe('mirrorUserMemory', () => {
  it('copies the user CLAUDE.md into the engine config home', async () => {
    const { storage, userClaude } = await layout()
    await writeFile(join(userClaude, 'CLAUDE.md'), 'always run pnpm test')

    await mirrorUserMemory(storage, userClaude)

    expect(await readFile(join(storage, 'CLAUDE.md'), 'utf8')).toBe('always run pnpm test')
  })

  it('refreshes the mirror when the user file changes', async () => {
    const { storage, userClaude } = await layout()
    await writeFile(join(userClaude, 'CLAUDE.md'), 'v1')
    await mirrorUserMemory(storage, userClaude)
    await writeFile(join(userClaude, 'CLAUDE.md'), 'v2')

    await mirrorUserMemory(storage, userClaude)

    expect(await readFile(join(storage, 'CLAUDE.md'), 'utf8')).toBe('v2')
  })

  it('removes the stale mirror when the user file disappears', async () => {
    const { storage, userClaude } = await layout()
    await writeFile(join(userClaude, 'CLAUDE.md'), 'v1')
    await mirrorUserMemory(storage, userClaude)
    await rm(join(userClaude, 'CLAUDE.md'))

    await mirrorUserMemory(storage, userClaude)

    await expect(readFile(join(storage, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the config home untouched when no user CLAUDE.md ever existed', async () => {
    const { storage, userClaude } = await layout()

    await mirrorUserMemory(storage, userClaude)

    await expect(readFile(join(storage, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readClaudeHostPermissions', () => {
  it('projects only the permissions section out of the host settings', async () => {
    const { userClaude } = await layout()
    await writeFile(join(userClaude, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls*)'], defaultMode: 'auto' },
      env: { ANTHROPIC_AUTH_TOKEN: 'SECRET_TOKEN' },
      model: 'user-model',
    }))

    const snapshot = await readClaudeHostPermissions(userClaude)

    expect(snapshot.permissions).toEqual({ allow: ['Bash(ls*)'], defaultMode: 'auto' })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_TOKEN')
  })

  it('returns an empty snapshot when the settings file or its permissions are absent', async () => {
    const { userClaude } = await layout()
    await writeFile(join(userClaude, 'settings.json'), JSON.stringify({ model: 'user-model' }))

    await expect(readClaudeHostPermissions(userClaude)).resolves.toEqual({})

    await rm(join(userClaude, 'settings.json'))
    await expect(readClaudeHostPermissions(userClaude)).resolves.toEqual({})
  })

  it('fails loudly on malformed user settings', async () => {
    const { userClaude } = await layout()
    await writeFile(join(userClaude, 'settings.json'), '{ not json')

    await expect(readClaudeHostPermissions(userClaude)).rejects.toThrow(/malformed/)
  })

  it('rejects a non-object permissions section', async () => {
    const { userClaude } = await layout()
    await writeFile(join(userClaude, 'settings.json'), JSON.stringify({ permissions: 'allow-all' }))

    await expect(readClaudeHostPermissions(userClaude)).rejects.toThrow()
  })
})

describe('applyClaudeHostPermissions', () => {
  it('writes the snapshot permissions into the engine config home', async () => {
    const { storage, userClaude } = await layout()
    await writeFile(join(userClaude, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(ls*)'] }, env: { ANTHROPIC_AUTH_TOKEN: 'SECRET_TOKEN' },
    }))
    const snapshot = await readClaudeHostPermissions(userClaude)

    await applyClaudeHostPermissions(storage, snapshot)

    const mirrored = JSON.parse(await readFile(join(storage, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(mirrored).toEqual({ permissions: { allow: ['Bash(ls*)'] } })
  })

  it('keeps applying the snapshot after the host settings change', async () => {
    const { storage, userClaude } = await layout()
    const source = join(userClaude, 'settings.json')
    await writeFile(source, JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    const snapshot = await readClaudeHostPermissions(userClaude)
    await applyClaudeHostPermissions(storage, snapshot)
    await writeFile(source, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }))

    await applyClaudeHostPermissions(storage, snapshot)

    const mirrored = JSON.parse(await readFile(join(storage, 'settings.json'), 'utf8')) as { permissions: unknown }
    expect(mirrored.permissions).toEqual({ defaultMode: 'auto' })
  })

  it('removes the stale mirror when the snapshot carries no permissions', async () => {
    const { storage, userClaude } = await layout()
    const source = join(userClaude, 'settings.json')
    await writeFile(source, JSON.stringify({ permissions: { defaultMode: 'auto' } }))
    await applyClaudeHostPermissions(storage, await readClaudeHostPermissions(userClaude))

    await applyClaudeHostPermissions(storage, {})

    await expect(readFile(join(storage, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('clearUserPermissions', () => {
  it('removes mirrored permission rules and tolerates an absent mirror', async () => {
    const { storage } = await layout()
    await applyClaudeHostPermissions(storage, { permissions: { defaultMode: 'auto' } })

    await clearUserPermissions(storage)

    await expect(readFile(join(storage, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(clearUserPermissions(storage)).resolves.toBeUndefined()
  })
})
