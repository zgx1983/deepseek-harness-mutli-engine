/** Quiet build output retains complete logs while bounding failure diagnostics. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

for (const exit of [0, 7]) {
  it(`preserves exit ${exit} and keeps routine output in the log`, () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'dsh-quiet-build-'))
    let log: string | undefined
    try {
      const runner = resolve(directory, 'pnpm.mjs')
      writeFileSync(runner, `process.stdout.write('routine-output\\n'.repeat(2000)); process.stderr.write('diagnostic-end\\n'); process.exit(${exit});`)
      const child = spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/build-quiet.ts', '--', 'build'], {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, npm_execpath: runner },
        encoding: 'utf8',
      })
      log = /log: ([^\n]+)/u.exec(child.stdout)?.[1]
      expect(log).toBeDefined()
      expect(child.status).toBe(exit)
      expect(child.stdout).toContain('running build;')
      expect(child.stdout).not.toContain('routine-output')
      expect(readFileSync(log!, 'utf8')).toContain('diagnostic-end')
      if (exit === 0) expect(child.stderr).toBe('')
      else {
        expect(child.stderr).toContain('diagnostic-end')
        expect(child.stderr.length).toBeLessThan(12_300)
        expect(child.stderr.split('\n').length).toBeLessThanOrEqual(83)
      }
    } finally {
      if (log !== undefined) rmSync(log, { force: true })
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
