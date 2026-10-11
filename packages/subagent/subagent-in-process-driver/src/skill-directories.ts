/** Links configured skill roots into an engine-owned discovery directory. */

import { lstat, mkdir, readdir, readlink, symlink, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Merge skill folders without replacing real folders or unrelated links.
 * Earlier sources win duplicate folder names. Managed links to removed sources
 * are removed; instruction files remain in their original source directories.
 * @param destination - engine-owned skills directory.
 * @param sources - absolute skill roots in precedence order.
 */
export async function syncEngineSkillDirectories(destination: string, sources: readonly string[]): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const roots = sources.map(source => resolve(source))
  const desired = new Map<string, string>()
  for (const root of roots) {
    let entries
    try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }
    for (const entry of entries) {
      // Native runtimes own hidden caches such as Codex skills/.system.
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (!desired.has(entry.name)) desired.set(entry.name, join(root, entry.name))
    }
  }
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue
    const path = join(destination, entry.name)
    const target = resolve(destination, await readlink(path))
    if (!roots.some(root => target === join(root, entry.name))) continue
    if (desired.get(entry.name) !== target) {
      try { await unlink(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  for (const [name, target] of desired) {
    const path = join(destination, name)
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir') } catch (linkError) {
        // Concurrent Claude sessions may prepare the shared home together.
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError
      }
    }
  }
}
