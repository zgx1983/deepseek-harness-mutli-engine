// Final verification: on a non-blank session, settings → 模型 must stay open and offer the add entry.
import { chromium } from 'playwright'

const outDir = new URL('.', import.meta.url).pathname
const token = process.argv[2]
const browser = await chromium.launch({
  executablePath: '/Users/hhh/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const consoleLines = []
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') consoleLines.push(`[${msg.type()}] ${msg.text().slice(0, 500)}`)
})
page.on('pageerror', (err) => { consoleLines.push(`[pageerror] ${String(err).slice(0, 800)}`) })

await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

// Make the main view non-blank so the blank-session onboarding never activates.
await page.getByText('构建下项目', { exact: true }).first().click()
await page.waitForTimeout(2000)

await page.getByRole('button', { name: /设置|Settings/ }).first().click()
const dialog = page.getByRole('dialog', { name: '设置' })
await dialog.waitFor({ timeout: 10_000 })
await dialog.getByRole('button', { name: '模型', exact: true }).click()
await page.waitForTimeout(2500)

console.log('dialog visible after 模型:', await dialog.isVisible())
await page.screenshot({ path: `${outDir}31-models.png` })

const add = dialog.getByRole('button', { name: '添加模型提供商' })
console.log('add-provider count:', await add.count(), 'enabled:', await add.count() > 0 && await add.isEnabled())
if (await add.count() > 0) {
  await add.click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${outDir}32-models-add.png` })
  const tabs = dialog.getByRole('tab')
  const tabNames = []
  for (const tab of await tabs.all()) tabNames.push((await tab.textContent() ?? '').trim())
  console.log('add-card tabs:', JSON.stringify(tabNames))
}
console.log('--- console errors/warnings ---')
for (const line of consoleLines) console.log(line)
await browser.close()
