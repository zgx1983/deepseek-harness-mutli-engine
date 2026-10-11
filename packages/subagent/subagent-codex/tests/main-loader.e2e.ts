/** Credentialed main-engine acceptance uses a configured Responses endpoint directly. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/main/driver.ts', import.meta.url))
const patch = fileURLToPath(new URL('./fixtures/main/main.patch.yml', import.meta.url))

describe.skipIf(!process.env.DSH_CODEX_ACCEPTANCE_KEY)('Codex main native catalog and real-provider acceptance', () => {
  it('loads the native catalog, switches models in one process and resumes history', { timeout: 180000, retry: 0 }, async () => {
    const { stdout } = await runLoaderSmoke({ label: 'Codex main Loader acceptance', tempDirPrefix: 'dsh-codex-main-loader-',
      binScript: driver, libBinScript: driver, configPath: patch, binArgs: [patch], mode: 'lib', processTimeoutMs: 170000,
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
      env: { DSH_CODEX_ACCEPTANCE_KEY: process.env.DSH_CODEX_ACCEPTANCE_KEY,
        DSH_CODEX_ACCEPTANCE_URL: process.env.DSH_CODEX_ACCEPTANCE_URL },
    })
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toEqual({
      turns: 3, nativeCatalog: true, modelSwitch: true, resumed: true, errors: [],
    })
  })
})
