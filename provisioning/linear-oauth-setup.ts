// One-time Linear OAuth `actor=app` authorization, so bunion's agents can post comments under their own app
// identity (and per-phase names via createAsUser) instead of the operator's personal account.
//
//   LINEAR_OAUTH_CLIENT_ID / LINEAR_OAUTH_CLIENT_SECRET must be in the env (from ~/.bevyl/.env).
//   bun provisioning/linear-oauth-setup.ts   → prints an authorize URL; open it, click Authorize; the
//   localhost:4321 callback catches the code, exchanges it, and appends LINEAR_APP_TOKEN to ~/.bevyl/.env.
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV = join(homedir(), '.bevyl', '.env')
const CID = process.env.LINEAR_OAUTH_CLIENT_ID
const SECRET = process.env.LINEAR_OAUTH_CLIENT_SECRET
const REDIRECT = 'http://localhost:4321/callback'
const SCOPE = 'read,write'
if (!CID || !SECRET) {
  console.error('missing LINEAR_OAUTH_CLIENT_ID / LINEAR_OAUTH_CLIENT_SECRET in the env')
  process.exit(1)
}

const state = crypto.randomUUID()
const authUrl =
  `https://linear.app/oauth/authorize?client_id=${CID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&actor=app&state=${state}`
console.log('AUTHORIZE_URL ' + authUrl)

Bun.serve({
  port: 4321,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/callback') return new Response('bunion oauth catcher')
    const code = url.searchParams.get('code')
    if (url.searchParams.get('state') !== state) return new Response('state mismatch', { status: 400 })
    if (!code) return new Response('no code: ' + (url.searchParams.get('error') ?? 'unknown'), { status: 400 })
    const res = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, redirect_uri: REDIRECT, client_id: CID, client_secret: SECRET, grant_type: 'authorization_code' }),
    })
    const body = (await res.json()) as { access_token?: string; scope?: string; token_type?: string }
    if (!body.access_token) {
      console.error('TOKEN_EXCHANGE_FAILED ' + JSON.stringify(body))
      return new Response('exchange failed', { status: 500 })
    }
    appendFileSync(ENV, `\nLINEAR_APP_TOKEN=${body.access_token}\n`)
    console.log(`TOKEN_SAVED scope=${body.scope} type=${body.token_type}`)
    setTimeout(() => process.exit(0), 300)
    return new Response('<h2>bunion authorized ✓ — close this tab</h2>', { headers: { 'content-type': 'text/html' } })
  },
})
console.log('CALLBACK_LISTENING ' + REDIRECT)
setTimeout(() => {
  console.error('timed out waiting for the callback (5 min)')
  process.exit(1)
}, 300000)
