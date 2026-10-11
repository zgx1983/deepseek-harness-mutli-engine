import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { syncEngineSkillDirectories } from '../src/skill-directories.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('merges ordered skill roots, reflects source edits and removes only stale managed links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engine-skills-'))
  roots.push(root)
  const user = join(root, 'user')
  const home = join(root, 'home')
  const destination = join(root, 'engine')
  for (const path of [join(user, 'shared'), join(home, 'shared'), join(home, 'extra'),
    join(user, '.system'), join(destination, 'owned'), join(root, 'unrelated')]) await mkdir(path, { recursive: true })
  await writeFile(join(user, 'shared', 'SKILL.md'), 'first')
  await symlink(join(root, 'unrelated'), join(destination, 'unrelated'), process.platform === 'win32' ? 'junction' : 'dir')

  await syncEngineSkillDirectories(destination, [user, home])
  expect(resolve(destination, await readlink(join(destination, 'shared')))).toBe(join(user, 'shared'))
  expect(await readFile(join(destination, 'shared', 'SKILL.md'), 'utf8')).toBe('first')
  await writeFile(join(user, 'shared', 'SKILL.md'), 'edited')
  expect(await readFile(join(destination, 'shared', 'SKILL.md'), 'utf8')).toBe('edited')
  await expect(readlink(join(destination, '.system'))).rejects.toHaveProperty('code', 'ENOENT')

  await rm(join(home, 'extra'), { recursive: true })
  await syncEngineSkillDirectories(destination, [user, home])
  await expect(readlink(join(destination, 'extra'))).rejects.toHaveProperty('code', 'ENOENT')
  expect(await readlink(join(destination, 'unrelated'))).toBe(join(root, 'unrelated'))
  await expect(readlink(join(destination, 'owned'))).rejects.toThrow()
  expect(await readFile(join(user, 'shared', 'SKILL.md'), 'utf8')).toBe('edited')
})

it('supports concurrent preparation and absent source roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engine-skills-'))
  roots.push(root)
  await mkdir(join(root, 'user', 'skill'), { recursive: true })
  await Promise.all(Array.from({ length: 4 }, () => syncEngineSkillDirectories(join(root, 'engine'), [join(root, 'missing'), join(root, 'user')])))
  expect(resolve(join(root, 'engine'), await readlink(join(root, 'engine', 'skill')))).toBe(join(root, 'user', 'skill'))
})
