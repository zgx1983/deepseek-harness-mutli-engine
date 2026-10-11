/** Build coordinated Web/Desktop artifacts from a verified local content baseline. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { affectedBuildPackages, compilerBuildProjects, type BuildPackage } from './local-build-plan.ts'
import {
  CLIENT_BUILD_RECORD_PATH, CLIENT_BUILD_PROFILE_SELECTOR, clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment, resolveClientBuildEnvironment, writeClientBuildRecord,
} from './client-build-environment.ts'

const root = resolve(import.meta.dirname, '..')
const cachePath = resolve(root, '.dsh-build/local-build.json')
const ignored = /(?:^|\/)(?:node_modules|lib|dist|bin|\.git|\.desktop-build|\.typecheck)(?:\/|$)|\.tsbuildinfo$/u
const relevant = /\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|html|svg|png|woff2?|c|h|cc|cpp|rs|sh)$/u

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(item => typeof item === 'string')
}

function digest(paths: readonly string[]): string {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    const content = readFileSync(resolve(root, path))
    hash.update(`${Buffer.byteLength(path)}:${path}${content.length}:`)
    hash.update(content)
  }
  return hash.digest('hex')
}

function inputs(directory: string): string {
  return digest(globSync(`${directory}/**/*`, { cwd: root, exclude: path => ignored.test(path) })
    .filter(path => statSync(resolve(root, path)).isFile() && !/\/README(?:\.[^/]*)?\.md$/u.test(path) && !path.includes('/tests/')))
}

function packages(): BuildPackage[] {
  return globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'plugins/*/package.json'], { cwd: root })
    .map((path) => {
      const manifest: unknown = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
      if (!object(manifest) || typeof manifest.name !== 'string') throw new Error(`local build: invalid manifest ${path}`)
      const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((key) => {
        const value = manifest[key]
        if (value === undefined) return []
        if (!strings(value)) throw new Error(`local build: invalid ${key} in ${path}`)
        return Object.keys(value)
      })
      return { name: manifest.name, directory: path.slice(0, -'/package.json'.length), dependencies }
    })
}

function outputs(): string {
  return digest(globSync([
    'packages/*/*/lib/**/*', 'vendor/*/lib/**/*', 'apps/*/lib/**/*', 'apps/web/dist/**/*',
    'plugins/*/lib/**/*', 'native/system/packages/*/bin/*', CLIENT_BUILD_RECORD_PATH,
  ], { cwd: root, exclude: path => /\.tsbuildinfo$/u.test(path) })
    .filter(path => statSync(resolve(root, path)).isFile()))
}

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv): void {
  console.log(`local build: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`local build: stage failed (${String(result.status ?? result.signal)})`)
}

function pnpm(args: readonly string[], environment: NodeJS.ProcessEnv): void {
  const invocation = pnpmInvocation(args, environment)
  run(invocation.command, invocation.args, environment)
}

function main(): void {
  const argv = process.argv.slice(2).filter(arg => arg !== '--')
  const { values } = parseArgs({ args: argv, options: { full: { type: 'boolean' }, profile: { type: 'string' } } })
  const environment = resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, process.env),
    values.profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR])
  const buildEnvironment = clientBuildProcessEnvironment(process.env, environment)
  const workspace = packages()
  const fingerprints = Object.fromEntries(workspace.map(pkg => [pkg.directory, inputs(pkg.directory)]))
  const globalFingerprint = (): string => digest(globSync(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig*.json',
    'tsdown.config.ts', 'packages/*/*.ts', 'packages/*/*.json', 'scripts/**/*.ts', 'scripts/**/*.mjs', 'native/**/*'], {
    cwd: root, exclude: path => ignored.test(path),
  }).filter(path => relevant.test(path) && !path.endsWith('.spec.ts')).concat(workspace.map(pkg => `${pkg.directory}/package.json`)))
    + JSON.stringify(environment) + `${process.version}/${process.platform}/${process.arch}`
  const globals = globalFingerprint()
  let cached: unknown
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')) } catch (error) {
    // The cache is disposable: absent or malformed records require a complete baseline build.
    if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const reusable = object(cached) && cached.version === 1 && cached.global === globals
    && strings(cached.inputs) && typeof cached.outputs === 'string' && cached.outputs === outputs()
    && JSON.stringify(Object.keys(cached.inputs).sort()) === JSON.stringify(Object.keys(fingerprints).sort())
    && existsSync(resolve(root, CLIENT_BUILD_RECORD_PATH))
  const changed = workspace.filter(pkg => !reusable || !object(cached) || !strings(cached.inputs)
    || cached.inputs[pkg.directory] !== fingerprints[pkg.directory])
  const full = values.full === true || !reusable
  const prepareDesktop = (): void => {
    run(process.execPath,
      ['--import', 'tsx/esm', 'apps/desktop/scripts/dev.ts', '--skip-build', '--prepare-only'], buildEnvironment)
  }
  if (!full && changed.length === 0) {
    prepareDesktop()
    console.log('local build: Web, Desktop and dependency artifacts unchanged; reused verified baseline')
    return
  }
  rmSync(cachePath, { force: true })
  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  if (full) {
    console.log('local build: complete baseline required')
    pnpm(['run', 'build', ...values.profile === undefined ? [] : ['--profile', values.profile]], buildEnvironment)
  } else {
    const affected = affectedBuildPackages(workspace, changed.map(pkg => pkg.name))
    const bundleNames = workspace.filter(pkg => affected.has(pkg.name) && !pkg.directory.startsWith('plugins/')
      && (pkg.directory.startsWith('packages/') || pkg.directory.startsWith('vendor/')
        || pkg.directory === 'apps/cli' || pkg.directory === 'apps/desktop-host')).map(pkg => pkg.name)
    console.log(`local build: ${changed.length} changed package(s), ${affected.size} affected package(s)`)
    const directories = workspace.filter(pkg => affected.has(pkg.name)).map(pkg => pkg.directory)
    const hostProjects = compilerBuildProjects(root, 'tsconfig.host.json', directories)
    const clientProjects = compilerBuildProjects(root, 'tsconfig.client.json', directories)
    if (hostProjects.length > 0) run(process.execPath,
      ['--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '-b', ...hostProjects], buildEnvironment)
    if (bundleNames.length > 0) {
      // tsdown 0.22 CLI keeps --filter values as strings, which filterConfig
      // exact-matches against package names; a /regex/ literal matches nothing.
      const filterArgs = bundleNames.flatMap(name => ['--filter', name])
      pnpm(['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'host', ...filterArgs], buildEnvironment)
      if (clientProjects.length > 0) run(process.execPath,
        ['node_modules/typescript/bin/tsc', '-b', ...clientProjects], buildEnvironment)
      const clientFilterArgs = bundleNames.flatMap(name => ['--filter', name, '--filter', `${name}/client`])
      pnpm(['exec', 'tsdown', '--env.DSH_BUILD_FACE', 'client', ...clientFilterArgs], buildEnvironment)
    } else if (clientProjects.length > 0) {
      run(process.execPath, ['node_modules/typescript/bin/tsc', '-b', ...clientProjects], buildEnvironment)
    }
    pnpm(['run', 'build:web'], buildEnvironment)
  }
  // Local plugin browser bundles may inline shared libraries; refresh each plugin with a build entry.
  for (const pkg of workspace.filter(pkg => pkg.directory.startsWith('plugins/'))) {
    const entry = `${pkg.directory}/build.mjs`
    if (existsSync(resolve(root, entry))) run(process.execPath, [entry], buildEnvironment)
  }
  pnpm(['run', 'build:desktop'], buildEnvironment)
  const after = Object.fromEntries(workspace.map(pkg => [pkg.directory, inputs(pkg.directory)]))
  const changedInputs = workspace.filter(pkg => after[pkg.directory] !== fingerprints[pkg.directory])
    .map(pkg => pkg.directory)
  if (changedInputs.length > 0 || globals !== globalFingerprint()) {
    rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
    throw new Error('local build: source changed during the build; rerun before accepting these artifacts'
      + ` (inputs: ${changedInputs.length === 0 ? 'none' : changedInputs.join(', ')};`
      + ` global fingerprint: ${globals === globalFingerprint() ? 'unchanged' : 'changed'})`)
  }
  prepareDesktop()
  writeClientBuildRecord(root, environment)
  mkdirSync(resolve(root, '.dsh-build'), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify({ version: 1, global: globals, inputs: fingerprints, outputs: outputs() })}\n`)
  console.log('local build: Web, Desktop, workspace dependencies and local plugins ready')
}

try { main() } catch (error) {
  rmSync(cachePath, { force: true })
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
}
