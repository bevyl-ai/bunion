# Deploying the dashboard (Preact rewrite + Tailwind CSS)

The production host (`bunion-brain.exe.xyz`) deploys via `git bundle create` + `git fetch` + `git reset --hard` +
`sudo systemctl restart bunion`. There is no CI and no separate build pipeline — the systemd unit runs
`bun src/cli.ts start` directly.

## One-time step this deploy needs

This history adds three new runtime dependencies (`package.json` + `bun.lock`): `preact`, `tailwindcss`, and
`bun-plugin-tailwind`. The next deploy must run `bun install` **before** `sudo systemctl restart bunion`, same
as any other dependency bump — nothing else changes about the deploy sequence. All three are real
`dependencies`, not `devDependencies` — verified with `rm -rf node_modules && bun install --production`, which
still installs them and boots clean.

No pre-build step is required, but the CSS pipeline does run its own compile at every process start:
`src/dashboard.ts` calls `Bun.build()` (with the `bun-plugin-tailwind` plugin) once when `startDashboard()` runs,
compiling `src/dashboard-client/styles.css` and `stats-styles.css` and serving the result from `/dashboard.css`
and `/stats.css`. Separately, `Bun.serve`'s HTML-import routing (`board.html`/`stats.html`, wired in
`src/dashboard.ts`'s `routes` object) still bundles the Preact/TSX on the fly with no separate build step. Both
verified in dev mode and against a production-mode install.

`bun-plugin-tailwind` only implements `Bun.build()`'s bundler-plugin hooks, not `Bun.plugin()`'s module-loader
hooks — do not try to register it via `Bun.plugin()` (registering it that way throws
`build.onBeforeParse is not a function`). It must stay wired the way `compileTailwindCss()` in `src/dashboard.ts`
already does it.

## What changed

- `src/dashboard.ts` — was the giant HTML-string-templated dashboard (Bun.serve backend + inline `<script>`
  DOM manipulation). Now re-exports the exact same server-side route/SSE plumbing (byte-identical behavior —
  see `src/dashboard.legacy.ts` to diff) but serves the client as a real Preact component tree under
  `src/dashboard-client/` instead of literal HTML string constants.
- `src/dashboard-client/` — the new Preact app: `board.html`/`board.tsx` (main dashboard), `stats.html`/
  `stats.tsx` (the `/stats` page), `components/*.tsx` (now Tailwind utility classes, with named CSS classes kept
  for keyframe animations / multi-layer shadows / other things utilities can't cleanly express), and `lib/*.ts`
  (SSE/keyboard/action hooks + formatting helpers).
- `src/orchestrator.ts` — **unchanged**. `startDashboard()`'s signature, and every route/SSE message shape it
  relies on, are identical to before.
