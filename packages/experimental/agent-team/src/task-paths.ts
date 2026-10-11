/** Host checks for declared task inputs and outputs. */

import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TeamTaskSnapshot } from './types.ts'
import { writeScope } from './validation.ts'

/** Resolve one declared path and reject symlinks that escape the task workspace. */
async function resolveInside(cwd: string, value: string): Promise<string> {
  const root = await realpath(cwd)
  if (isAbsolute(value)) throw new Error(`task path must be workspace-relative: ${value}`)
  const path = resolve(root, value)
  const resolved = await realpath(path)
  const rel = relative(root, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`task path escapes its workspace: ${value}`)
  }
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`task path cannot be a symbolic link: ${value}`)
  if (resolved !== path) throw new Error(`task path contains a symbolic link: ${value}`)
  if (!info.isFile() && !info.isDirectory()) throw new Error(`task path is not a file or directory: ${value}`)
  return resolved
}

/** Verify declared inputs exist in the owner's workspace before a task starts. */
export async function verifyTaskInputs(task: TeamTaskSnapshot, cwd: string): Promise<void> {
  for (const path of task.inputPaths ?? []) await resolveInside(cwd, writeScope(path))
}

/** Verify declared outputs exist inside both the workspace and a declared write scope. */
export async function verifyTaskOutputs(task: TeamTaskSnapshot, cwd: string): Promise<void> {
  for (const path of task.outputPaths ?? []) {
    const resolved = await resolveInside(cwd, writeScope(path))
    const root = await realpath(cwd)
    const rel = relative(root, resolved).split(sep).join('/')
    if (!task.writeScopes.some(scope => rel === scope || rel.startsWith(`${scope}/`))) {
      throw new Error(`task output is outside declared write scopes: ${path}`)
    }
  }
}
