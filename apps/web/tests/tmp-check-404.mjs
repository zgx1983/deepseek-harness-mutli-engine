// Log every 404 resource during a plain app load.
import { chromium } from 'playwright'

const token = process.argv[2]
const browser = await chromium.launch({
  executablePath: '/Users/hhh/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell',
})
const page = await browser.newPage({ locale: 'zh-CN' })
page.on('response', (r) => { if (r.status() === 404) console.log('404:', r.url()) })
await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'load' })
await page.waitForTimeout(4000)
await browser.close()
