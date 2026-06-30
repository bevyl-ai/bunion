// Stateful headless browser the QA agent drives step by step (real chromium via Playwright). State persists
// between commands — same page — so you open, look, click, type, and screenshot like a human at a keyboard.
//
//   bun browser.mjs open <url>          navigate (auto-starts the browser on first use)
//   bun browser.mjs snapshot            what's on the page now: url, title, visible text, and clickable elements
//                                       (read this to "see" — you don't get the pixels, you get the structure)
//   bun browser.mjs click <selector>    Playwright selector: 'text=Open billing', 'button:has-text("Save")', or CSS
//   bun browser.mjs fill <selector> <text>
//   bun browser.mjs press <key>         e.g. Enter, Escape, ArrowRight
//   bun browser.mjs text [selector]     innerText of the page (or a selector)
//   bun browser.mjs eval <js>           run JS in the page; returns the value (great for precise assertions)
//   bun browser.mjs screenshot [path]   save a PNG — your PROOF the behaviour is right; attach the path in the workpad
//   bun browser.mjs url
//   bun browser.mjs close               shut the browser down
import { chromium } from 'playwright'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// BEV audit: PORT_FILE used to be one global `/tmp` path shared by every concurrent QA session on a VM — if two
// tickets' agents both ran this skill at once, the second one's `ensure()` would happily reuse the FIRST one's
// already-running browser (same port file, pings OK), silently sharing/hijacking one browser/page across two
// unrelated tickets. Derive it from this script's OWN location instead: each ticket's workspace gets its own copy
// of the skill (installSkills), so the script's resolved path is unique per ticket and stable across invocations
// regardless of the agent's current working directory.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PORT_FILE = `/tmp/qa-browser-${SCRIPT_DIR.replace(/[^a-zA-Z0-9]/g, '_')}.port`
const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'serve') await serve()
else if (!cmd) { console.error('usage: bun browser.mjs <open|snapshot|click|fill|press|text|eval|screenshot|url|close> [args]'); process.exit(2) }
else await client(cmd, args)

async function serve() {
  const browser = await chromium.launch()
  const page = await browser.newContext({ viewport: { width: 1366, height: 900 } }).then((c) => c.newPage())
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  // BEV audit: this process is spawned detached + unref'd with nothing watching it. If the QA session ends without
  // an explicit `close` call (the common case — the agent finishes its turn and moves on) or its workspace gets
  // pruned out from under it, nothing ever reaps it — it was accumulating as a permanent chromium+bun zombie across
  // the fleet. Self-exit after IDLE_MS with no requests; generous enough to never interrupt a real QA session.
  const IDLE_MS = 30 * 60_000
  let lastActivity = Date.now()
  const idleCheck = setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) browser.close().finally(() => process.exit(0)) }, 60_000)
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      lastActivity = Date.now()
      const { cmd, args } = await req.json()
      let res
      try { res = Response.json(await handle(page, consoleErrors, cmd, args)) } catch (e) { res = Response.json({ error: e instanceof Error ? e.message : String(e) }) }
      if (cmd === 'close') { clearInterval(idleCheck); setTimeout(() => { browser.close().finally(() => process.exit(0)) }, 50) }
      return res
    },
  })
  writeFileSync(PORT_FILE, String(server.port))
}

async function handle(page, consoleErrors, cmd, args) {
  const a = args[0]
  switch (cmd) {
    case 'open': await page.goto(a, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(900); return { url: page.url(), title: await page.title() }
    case 'click': await page.click(a, { timeout: 8000 }); await page.waitForTimeout(500); return { ok: true, url: page.url() }
    case 'fill': await page.fill(a, args[1] ?? '', { timeout: 8000 }); return { ok: true }
    case 'press': await page.keyboard.press(a); await page.waitForTimeout(300); return { ok: true, url: page.url() }
    case 'text': return { text: (a ? await page.locator(a).first().innerText() : await page.locator('body').innerText()).slice(0, 4000) }
    case 'eval': return { result: await page.evaluate(args.join(' ')) }
    case 'url': return { url: page.url() }
    case 'screenshot': { const path = a || `/tmp/qa-${Date.now()}.png`; await page.screenshot({ path, fullPage: true }); return { shot: path } }
    case 'login': {
      const email = process.env.QA_USER, pass = process.env.QA_PASS
      if (!email || !pass) return { error: 'QA_USER / QA_PASS not set in the env' }
      await page.fill('input[type="email"], input[name="email"]', email, { timeout: 10000 })
      await page.fill('input[type="password"], input[name="password"]', pass, { timeout: 10000 })
      await page.click('button[type="submit"]', { timeout: 10000 }).catch(() => page.getByRole('button', { name: /sign ?in|log ?in|continue/i }).first().click())
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(1500)
      return { url: page.url(), title: await page.title(), signedIn: !/sign.?in|\/auth\//i.test(page.url()) }
    }
    case 'snapshot': return snapshot(page, consoleErrors)
    case 'close': return { ok: true }
    default: return { error: `unknown cmd: ${cmd}` }
  }
}

async function snapshot(page, consoleErrors) {
  const interactive = await page.evaluate(() => {
    const out = []
    for (const n of document.querySelectorAll('a,button,[role=button],input,textarea,select,[role=tab],[role=menuitem],[role=switch],[role=checkbox]')) {
      const r = n.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue
      const label = (n.innerText || n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.value || '').trim().replace(/\s+/g, ' ').slice(0, 70)
      out.push({ tag: n.tagName.toLowerCase(), type: n.getAttribute('type') || undefined, label, id: n.id || undefined, testid: n.getAttribute('data-testid') || undefined })
      if (out.length >= 70) break
    }
    return out
  })
  const text = (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 2500)
  return { url: page.url(), title: await page.title(), text, interactive, consoleErrors: consoleErrors.slice(-10) }
}

async function ping(port) { try { await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ cmd: 'url', args: [] }), signal: AbortSignal.timeout(1500) }); return true } catch { return false } }

async function client(cmd, args) {
  if (cmd !== 'close') await ensure()
  const port = existsSync(PORT_FILE) ? readFileSync(PORT_FILE, 'utf8').trim() : ''
  if (!port) return void console.log(JSON.stringify({ error: 'browser not running — start with: bun browser.mjs open <url>' }))
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ cmd, args }) })).json()
    console.log(JSON.stringify(j, null, 2))
    if (cmd === 'close') rmSync(PORT_FILE, { force: true })
  } catch (e) { console.log(JSON.stringify({ error: `browser daemon not reachable: ${e instanceof Error ? e.message : e}` })) }
}

async function ensure() {
  if (existsSync(PORT_FILE) && (await ping(readFileSync(PORT_FILE, 'utf8').trim()))) return
  rmSync(PORT_FILE, { force: true })
  spawn(process.execPath, [process.argv[1], 'serve'], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 250)); if (existsSync(PORT_FILE) && (await ping(readFileSync(PORT_FILE, 'utf8').trim()))) return }
}
