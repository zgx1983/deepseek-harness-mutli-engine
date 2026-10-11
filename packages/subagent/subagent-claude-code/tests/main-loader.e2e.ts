/** Real-provider acceptance runs the actual artifact Loader in its own process. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/main/driver.ts', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/main/main.patch.yml', import.meta.url))

describe.skipIf(!process.env.DSH_CLAUDE_ACCEPTANCE_KEY)('Claude main engine real-provider Loader acceptance', () => {
  it('persists two turns and resumes the same native identity after driver teardown', { retry: 0 }, async () => {
    const { stdout } = await runLoaderSmoke({
      label: 'Claude main Loader acceptance', tempDirPrefix: 'dsh-claude-main-loader-',
      binScript: driver, libBinScript: driver, configPath: patch, binArgs: [patch],
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
      mode: 'lib', processTimeoutMs: 110_000,
      env: {
        DSH_CLAUDE_ACCEPTANCE_KEY: process.env.DSH_CLAUDE_ACCEPTANCE_KEY,
        DSH_CLAUDE_ACCEPTANCE_URL: process.env.DSH_CLAUDE_ACCEPTANCE_URL,
        DSH_CLAUDE_ACCEPTANCE_MODEL: process.env.DSH_CLAUDE_ACCEPTANCE_MODEL,
      },
    })
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toEqual({ turns: 3, persisted: true, resumed: true, errors: [] })
  })
})
