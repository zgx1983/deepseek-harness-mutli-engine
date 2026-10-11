/** Shared Electron preparation publishes complete distributions across checkouts. */
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { prepareDevelopmentElectron } from '../scripts/development-electron.ts'

it('shares a complete runtime across concurrent launchers and survives removal of checkout dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-cache-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const installedDist = join(root, 'checkout', 'dist')
  await mkdir(installedDist, { recursive: true })
  await writeFile(join(installedDist, 'version'), '44.0.0\n')
  await writeFile(join(installedDist, 'electron'), 'runtime', { mode: 0o755 })
  await mkdir(join(installedDist, 'Versions', 'A'), { recursive: true })
  await writeFile(join(installedDist, 'Versions', 'A', 'icudtl.dat'), 'icu-data')
  if (process.platform !== 'win32') await symlink('A', join(installedDist, 'Versions', 'Current'), 'dir')
  const options = { version: '44.0.0', platform: 'linux' as const, arch: 'x64', cache: join(root, 'shared'), installedDist }
  const paths = await Promise.all(Array.from({ length: 4 }, () => prepareDevelopmentElectron(options)))
  expect(new Set(paths).size).toBe(1)
  expect(paths[0]).toBe(join(root, 'shared', '44.0.0', 'linux-x64', 'electron'))
  await rm(join(root, 'checkout'), { recursive: true })
  expect(await prepareDevelopmentElectron(options)).toBe(paths[0])
  expect(await readFile(paths[0]!, 'utf8')).toBe('runtime')
  const versions = join(root, 'shared', '44.0.0', 'linux-x64', 'Versions')
  if (process.platform !== 'win32') expect(await readlink(join(versions, 'Current'))).toBe('A')
  if (process.platform !== 'win32') expect(await readFile(join(versions, 'Current', 'icudtl.dat'), 'utf8')).toBe('icu-data')
})

it('keeps versions and architectures in separate runtime directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-identities-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  for (const [version, arch] of [['44.0.0', 'x64'], ['44.0.1', 'x64'], ['44.0.0', 'arm64']] as const) {
    const installedDist = join(root, `seed-${version}-${arch}`)
    await mkdir(installedDist)
    await writeFile(join(installedDist, 'version'), version)
    await writeFile(join(installedDist, 'electron'), `${version}/${arch}`)
    const executable = await prepareDevelopmentElectron({ version, platform: 'linux', arch, cache: join(root, 'shared'), installedDist })
    expect(await readFile(executable, 'utf8')).toBe(`${version}/${arch}`)
  }
})

it('rejects an identity that would escape the shared cache', async () => {
  await expect(prepareDevelopmentElectron({ version: '../other', platform: 'linux', arch: 'x64',
    cache: join(tmpdir(), 'unused-electron-cache') })).rejects.toThrow('invalid Electron distribution identity')
})
