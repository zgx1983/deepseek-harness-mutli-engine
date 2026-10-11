/** Dependency closure for coordinated local Web and Desktop builds. */

import { dirname, resolve } from 'node:path'
import ts from 'typescript'

/** One workspace package and every declared package-level build dependency. */
export interface BuildPackage {
  readonly name: string
  readonly directory: string
  readonly dependencies: readonly string[]
}

/**
 * Include changed packages and all transitive consumers, including development and peer inputs.
 * @param packages - Discovered workspace package manifests.
 * @param changed - Package names whose build inputs changed.
 * @returns Package names that require fresh bundles.
 */
export function affectedBuildPackages(packages: readonly BuildPackage[], changed: readonly string[]): Set<string> {
  const affected = new Set(changed)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.dependencies.some(name => affected.has(name))) {
        affected.add(pkg.name)
        expanded = true
      }
    }
  }
  return affected
}

/**
 * Select affected emitting projects from an existing compiler-face reference graph.
 * @param root - Repository or fixture root.
 * @param aggregate - Existing Host or Client aggregate config.
 * @param directories - Package directories requiring fresh output.
 * @returns Explicit project config paths; tsc follows their dependency references.
 */
export function compilerBuildProjects(root: string, aggregate: string, directories: readonly string[]): string[] {
  const targets = new Set(directories.map(directory => resolve(root, directory)))
  const visited = new Set<string>()
  const selected: string[] = []
  const visit = (path: string): void => {
    const configPath = path.endsWith('.json') ? path : resolve(path, 'tsconfig.json')
    if (visited.has(configPath)) return
    visited.add(configPath)
    const parsed = ts.readConfigFile(configPath, ts.sys.readFile)
    if (parsed.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
    const value: unknown = parsed.config
    if (typeof value !== 'object' || value === null || !('references' in value)) {
      if (targets.has(dirname(configPath))) selected.push(configPath)
      return
    }
    if (targets.has(dirname(configPath))) selected.push(configPath)
    if (!Array.isArray(value.references)) throw new Error(`local build: invalid project references in ${configPath}`)
    for (const reference of value.references) {
      if (typeof reference !== 'object' || reference === null || !('path' in reference) || typeof reference.path !== 'string') {
        throw new Error(`local build: invalid project reference in ${configPath}`)
      }
      visit(resolve(dirname(configPath), reference.path))
    }
  }
  visit(resolve(root, aggregate))
  return selected.sort()
}
