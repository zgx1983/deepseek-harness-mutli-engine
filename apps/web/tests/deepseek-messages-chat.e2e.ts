/** Historical Messages provider replay preserves its recorded identity and DeepSeek model group. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: DeepSeek Messages conversation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayFixture: string

  beforeAll(async () => {
    replayFixture = await selectedSessionFixture(FIXTURE, false)
    scaffold = await launchWebScaffold({
      replayFixture,
      paceMs: 5,
      replayProviders: [{
        id: 'deepseek-messages', name: 'DeepSeek',
        models: [{
          id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
          contextWindow: 1_000_000, defaultMaxTokens: 256_000,
          reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high',
        }],
      }],
    })
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('replays the historical Messages provider while displaying DeepSeek in the model selector', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-chat'))
    const prompts = fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByText('DeepSeek', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^选择模型/ }).click()
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.sessions.get(sessionId)!
    expect(session.requestHeader()?.config.provider).toBe('deepseek-messages')
    await page.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('offers an unchecked changelog summary option when archiving the replayed conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-archive-summary-choice'))
    const sessionRow = page.locator('[role="treeitem"][aria-selected="true"]').last()
    await sessionRow.hover()
    await sessionRow.getByRole('button', { name: '归档会话', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '归档此会话？', exact: true })
    await dialog.waitFor()
    const option = dialog.getByRole('checkbox', { name: '将会话摘要追加到项目 CHANGELOG.md' })
    expect(await option.isChecked()).toBe(false)
    const archiveOnly = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await option.check()
    expect(await dialog.getByRole('button', { name: '归档并总结', exact: true }).isVisible()).toBe(true)
    const withSummary = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'archive.expected.md'),
      `## Archive only\n\n${archiveOnly}\n\n## Archive and summarize\n\n${withSummary}`, MODE)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await sessionRow.hover()
    await sessionRow.getByRole('button', { name: '归档会话', exact: true }).click()
    expect(await option.isChecked()).toBe(false)
    await dialog.getByRole('button', { name: '归档', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).toHaveLength(1)
    await expect(readFile(join(scaffold.workspaceCwd, 'CHANGELOG.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the recorded-session inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'ui.expected.md', 'archive.expected.md'])
  })
})
