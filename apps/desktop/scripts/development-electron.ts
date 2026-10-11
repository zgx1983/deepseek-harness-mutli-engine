/** Immutable per-user Electron distributions shared by workspace launchers. */
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'

/** Inputs identifying one native Electron distribution. */
export interface DevelopmentElectronOptions {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly cache: string
  readonly installedDist?: string
}

function executableName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : platform === 'win32' ? 'electron.exe' : 'electron'
}

async function complete(directory: string, options: DevelopmentElectronOptions): Promise<boolean> {
  try {
    return (await readFile(join(directory, 'version'), 'utf8')).trim().replace(/^v/, '') === options.version
      && (await stat(join(directory, executableName(options.platform)))).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Reuse or atomically publish a complete version/platform/architecture-specific distribution.
 * @param options - Distribution identity and per-user cache; installedDist may seed a matching local installation.
 * @returns Absolute Electron executable path, without running the package's automatic installer.
 */
export async function prepareDevelopmentElectron(options: DevelopmentElectronOptions): Promise<string> {
  for (const value of [options.version, options.platform, options.arch]) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('desktop development: invalid Electron distribution identity')
  }
  const directory = join(resolve(options.cache), options.version, `${options.platform}-${options.arch}`)
  const executable = join(directory, executableName(options.platform))
  if (await complete(directory, options)) return executable
  await mkdir(dirname(directory), { recursive: true })
  const staging = await mkdtemp(`${directory}-`)
  try {
    if (options.installedDist !== undefined && await complete(options.installedDist, options)) {
      await cp(options.installedDist, staging, { recursive: true, verbatimSymlinks: true })
    } else {
      const archive = await downloadArtifact({ version: options.version, platform: options.platform,
        arch: options.arch, artifactName: 'electron', cacheRoot: join(options.cache, 'downloads') })
      await extractZip(archive, { dir: staging })
    }
    if (!await complete(staging, options)) throw new Error('desktop development: incomplete Electron distribution')
    try { await rename(staging, directory) } catch (error) {
      // Another launcher may publish first; never replace a completed distribution.
      if (!await complete(directory, options)) throw error
    }
    return executable
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/**
 * Resolve the installed Electron version and prepare its shared native runtime.
 * @returns Executable for this host, cached outside checkout-specific node_modules.
 */
export async function developmentElectron(): Promise<string> {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('electron/package.json')
  const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string }
  const cache = process.env.DSH_DESKTOP_ELECTRON_CACHE_DIR ?? join(homedir(), '.cache', 'deepseek-harness', 'electron')
  return prepareDevelopmentElectron({ version, platform: process.platform, arch: process.arch,
    cache, installedDist: join(dirname(manifest), 'dist') })
}
