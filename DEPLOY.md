# Deploying this branch (dashboard Preact rewrite)

The production host (`bunion-brain.exe.xyz`) deploys via `git bundle create` + `git fetch` + `git reset --hard` +
`sudo systemctl restart bunion`. There is no CI and no separate build pipeline — the systemd unit runs
`bun src/cli.ts start` directly.

## One-time step this deploy needs

This branch adds `preact` as a new runtime dependency (`package.json` + `bun.lock`). The next deploy of this
branch must run `bun install` **before** `sudo systemctl restart bunion`, same as any other dependency bump —
nothing else changes about the deploy sequence.

No pre-build step is required. `Bun.serve`'s HTML-import routing (`src/dashboard-client/board.html` and
`stats.html`, wired in `src/dashboard.ts`'s `routes` object) bundles the Preact/TSX/CSS on the fly when the
server process boots — verified in both dev mode and `NODE_ENV=production` with zero prior `bun build`
invocation. `bun src/cli.ts start` with nothing else run first is sufficient once `bun install` has picked up
`preact`.

## What changed

- `src/dashboard.ts` — was the giant HTML-string-templated dashboard (Bun.serve backend + inline `<script>`
  DOM manipulation). Now re-exports the exact same server-side route/SSE plumbing (byte-identical behavior —
  see `src/dashboard.legacy.ts` to diff) but serves the client as a real Preact component tree under
  `src/dashboard-client/` instead of literal HTML string constants.
- `src/dashboard.legacy.ts` — the old file, kept only as a diffable reference. Not imported anywhere; safe to
  delete once the new dashboard has been operator-verified against production traffic.
- `src/dashboard-client/` — the new Preact app: `board.html`/`board.tsx` (main dashboard), `stats.html`/
  `stats.tsx` (the `/stats` page), `components/*.tsx`, and `lib/*.ts` (SSE/keyboard/action hooks + formatting
  helpers ported byte-faithfully from the old inline `<script>`).
- `src/orchestrator.ts` — **unchanged**. `startDashboard()`'s signature, and every route/SSE message shape it
  relies on, are identical to before.
