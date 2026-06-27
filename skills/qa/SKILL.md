---
name: qa
description:
  Independently verify a PR against its acceptance criteria — the review/QA pass.
  Use in the QA phase (status QA Requested). Drive the real app in a headless
  browser (Playwright via qa-browser.mjs) to reproduce + confirm UI behaviour,
  and/or run the repo's checks, then route the ticket: PASS → Ready to ship,
  FAILED (reproduced defect) → In Progress for rework, BLOCKED (cannot verify) →
  QA blocked for a human. Skeptical, behaviour-focused; never changes product
  code, never merges.
---

# QA (independent review pass)

You did not write this code. Your job is to catch what the author missed — not to
rubber-stamp. You verify BEHAVIOUR (does it actually work for a user), which is
distinct from the diff review stupify already did. Change no product code; never merge.

## 1. Pick how to verify

- **UI / visual / interaction bug** (modal, scroll, button, layout, editor) → drive
  the real app in a browser (see "Browser QA" below). You can't fix a visual bug by
  reading the diff; you reproduce it and confirm the new behaviour.
- **Logic / data / backend bug** → check out the PR branch (run `pull`), run the
  repo's checks + the plan's validation items + any applicable `bevops` smoke/eval.
- Most tickets want both. Always: reproduce the ORIGINAL problem first (confirm it was
  real), then confirm it's GONE on the fix, then check each acceptance criterion.

## 2. Browser QA (Playwright)

A headless chromium + outbound network are available on this box. Use the runner:

```
bun .codex/skills/qa/qa-browser.mjs <url> '<async body using `page`, returning JSON>'
```

It prints `{ result, consoleErrors, pageErrors, shot }`. **You can't see the
screenshot** — verify with DOM assertions in the body (is the modal still visible, did
the list actually scroll, is the value correct), and read `consoleErrors`. The shot is
for the human; attach its path in the workpad if useful.

Find the PR's preview deployment (don't guess the host):
- `gh pr view <N> --json comments` and the `Deploy preview` / `Trigger Preview Check`
  check-runs usually carry a `pr-<N>.preview.bevyl.ai` (web), `pr-<N>.admin-preview.bevyl.ai`
  (admin), or `*.vercel.app` host. Confirm it 200s before testing.
- Compare against the same route on production (`www.bevyl.ai`) to reproduce a regression.

**Auth:** logged-in routes (editor, home, admin) redirect to `/auth/sign-in`. Only public
routes are testable without credentials. If the bug is on an authed route and you have no
working dev sign-in / test session, you genuinely **cannot verify** it here → BLOCKED.

Example:
```
bun .codex/skills/qa/qa-browser.mjs "https://www.bevyl.ai/glossary" \
  "return { items: await page.locator('[data-glossary-term]').count(), err: await page.locator('text=error').count() }"
```

## 3. Decide and route (post the verdict + confidence in the workpad first)

- **PASS** — you OBSERVED the fix working, every acceptance criterion is met, checks are
  green → move to `Ready to ship`. Do not merge (a human owns the merge).
- **FAILED** — you reproduced a defect, a criterion is objectively unmet, or a check is
  red → move **back to `In Progress`** with a precise `[codex]` comment: what failed, the
  exact repro (URL + steps + the DOM/assert that proves it), what to change. A build agent
  reworks it. Don't fix it yourself.
- **BLOCKED** — you cannot actually verify it (authed route with no session, needs a human
  judgement/product call, or you're not confident) → move to `QA blocked`. Terminal for the
  factory: record what you checked and what a human must decide. Never pass — or fail to
  rework — something you could not actually verify.

## Honesty bar

- PASS means you OBSERVED it working, not that the diff looks plausible.
- Couldn't actually verify it? That's BLOCKED, not PASS and not FAILED.
- Never edit product code to make something pass — that's the build agent's job.
