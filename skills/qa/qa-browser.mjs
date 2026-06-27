// Simple headless-browser runner for QA. Loads a URL in chromium and runs YOUR async body with `page`
// (the Playwright Page API), then prints JSON: { result, consoleErrors, pageErrors, shot }.
//
//   bun qa-browser.mjs <url> '<async body that uses `page` and returns a JSON-able value>'
//
// You verify BEHAVIOUR with DOM assertions (you can't see a screenshot) — e.g. is the modal still in the DOM,
// did the list actually scroll, is the value correct. The screenshot is saved for the human, not for you.
// Example:
//   bun qa-browser.mjs "https://pr-1234.preview.bevyl.ai/home/x" \
//     "await page.getByText('Open billing').click(); return { modalStillOpen: await page.locator('[role=dialog]').isVisible() }"
import { chromium } from 'playwright'

const [url, body = 'return {}'] = process.argv.slice(2)
if (!url) {
  console.error('usage: bun qa-browser.mjs <url> "<async page-script body>"')
  process.exit(2)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => pageErrors.push(String(e)))

const out = { url }
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const run = new Function('page', `return (async () => { ${body} })()`)
  out.result = await run(page)
  out.shot = `/tmp/qa-shot-${process.pid}.png`
  await page.screenshot({ path: out.shot, fullPage: true }).catch(() => {})
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e)
} finally {
  out.consoleErrors = consoleErrors.slice(0, 25)
  out.pageErrors = pageErrors.slice(0, 25)
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
