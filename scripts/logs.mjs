// Review agent activity logs reproducibly — find where agents hit FRICTION (the compounding devex slowdowns).
//
//   bun scripts/logs.mjs                  friction report across every live ticket (default)
//   bun scripts/logs.mjs <BEV-123>        dump one ticket's full log, readable
//   bun scripts/logs.mjs --tail <BEV-123> live-tail one ticket (Ctrl-C to stop)
//
// Talks to the running dashboard (BUNION_URL, default http://localhost:4319).
const BASE = process.env.BUNION_URL || 'http://localhost:4319'
const args = process.argv.slice(2)

// Signals that an agent is fighting its environment rather than doing the task.
const FRICTION =
  /\b(fail(?:ed|ing|s)?|errors?|not found|cannot|can'?t|couldn'?t|denied|missing|no such|timed? ?out|unable|doesn'?t|isn'?t|won'?t|retry|retrying|try(?:ing)? again|fall ?back|stuck|hang(?:s|ing)?|guess(?:ing)?|work ?around|skipp?(?:ing|ed)?|blocked|403|404|ENOENT|EACCES|command not found|permission|not installed|exhaust|instead|no preview|wrong)\b/i

const get = async (path) => (await (await fetch(BASE + path)).json())
const logOf = async (id) => {
  try {
    return (await get('/transcript/' + encodeURIComponent(id))).log || []
  } catch {
    return []
  }
}
const norm = (c) => c.replace(/(['"]).*?\1/g, '"…"').replace(/\$\([^)]*\)/g, '$(…)').replace(/\s+/g, ' ').trim().slice(0, 64)

async function tail(id) {
  console.log(`tailing ${id} — Ctrl-C to stop`)
  let last = 0
  for (;;) {
    const log = await logOf(id)
    for (let i = last; i < log.length; i++) process.stdout.write(log[i].replace(/^\n+/, '') + '\n')
    last = log.length
    await new Promise((r) => setTimeout(r, 1000))
  }
}

function dump(id, log) {
  console.log(`\n=== ${id} (${log.length} lines) ===`)
  for (const l of log) process.stdout.write(l.replace(/^\n+/, '') + '\n')
}

async function friction() {
  const items = (await get('/state.json')).items || []
  const cmdAcross = {}
  const rows = []
  for (const it of items) {
    const log = await logOf(it.identifier)
    if (!log.length) continue
    const msgs = log.filter((l) => l.startsWith('● ') && FRICTION.test(l)).map((l) => l.slice(2).trim())
    const cmds = log.filter((l) => l.startsWith('$ ')).map((l) => norm(l.slice(2)))
    const seen = {}
    for (const c of cmds) {
      seen[c] = (seen[c] || 0) + 1
      cmdAcross[c] = (cmdAcross[c] || 0) + 1
    }
    const repeats = Object.entries(seen).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
    rows.push({ id: it.identifier, state: it.state, lines: log.length, friction: msgs.length, repeats, msgs })
  }
  rows.sort((a, b) => b.friction + b.repeats.length * 2 - (a.friction + a.repeats.length * 2))
  console.log(`FRICTION REPORT · ${rows.length} tickets with logs · ${BASE}\n`)
  for (const r of rows) {
    if (!r.friction && !r.repeats.length) continue
    console.log(`${r.id} [${r.state}] — ${r.lines} lines · ${r.friction} friction msgs · ${r.repeats.length} repeated-cmd loops`)
    for (const [c, n] of r.repeats.slice(0, 3)) console.log(`   ↻ ${n}×  ${c}`)
    for (const m of r.msgs.slice(0, 4)) console.log(`   ⚠ ${m.replace(/\s+/g, ' ').slice(0, 150)}`)
    console.log('')
  }
  console.log('=== most-repeated commands across ALL agents (the compounding ones) ===')
  Object.entries(cmdAcross)
    .filter(([, n]) => n >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([c, n]) => console.log(`  ${n}×  ${c}`))
}

if (args[0] === '--tail') await tail(args[1])
else if (args[0] && !args[0].startsWith('--')) dump(args[0], await logOf(args[0]))
else await friction()
