/** Run an existing repository script with file-backed output and bounded failure diagnostics. */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const inputs = process.argv.slice(2)
const [script, ...args] = inputs[0] === '--' ? inputs.slice(1) : inputs
if (script === undefined || script === 'build:quiet') {
  console.error('Usage: pnpm run build:quiet -- <script> [arguments]; recursive build:quiet is forbidden.')
  process.exit(1)
}
const directory = resolve(root, '.dsh-build/build-logs')
mkdirSync(directory, { recursive: true })
const log = resolve(directory, `${Date.now()}-${process.pid}.log`)
const fd = openSync(log, 'wx')
const start = Date.now()
console.log(`build:quiet: running ${script}; log: ${log}`)
let status = 1
try {
  const invocation = pnpmInvocation(['run', script, ...args])
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', fd, fd],
  })
  status = result.status ?? 1
  if (result.error !== undefined) console.error(result.error.message)
  if (result.signal !== null) console.error(`build:quiet: terminated by ${result.signal}`)
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
} finally {
  closeSync(fd)
}
console.log(`build:quiet: ${status === 0 ? 'passed' : 'failed'} ${script}; ${(Date.now() - start) / 1000}s; log: ${log}`)
if (status !== 0) {
  // Read a bounded suffix rather than retaining compiler output in process memory.
  const input = openSync(log, 'r')
  try {
    const size = statSync(log).size
    const buffer = Buffer.alloc(Math.min(size, 12_000))
    readSync(input, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
    console.error('build:quiet: last 80 lines, at most 12000 bytes; inspect the log if the cause is earlier:')
    console.error(buffer.toString('utf8').replace(/\u001b\[[0-9;]*m/gu, '').split('\n').slice(-80).join('\n'))
  } finally {
    closeSync(input)
  }
}
process.exitCode = status
