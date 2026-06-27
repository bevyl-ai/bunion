---
name: qa
description:
  Independently verify a PR against its acceptance criteria — the review/QA pass
  (status QA Requested). Drive a real browser step by step with browser.mjs
  (open, snapshot, click, screenshot) to reproduce a bug and PROVE the fix with
  a screenshot, and/or run the repo's checks. Then route: PASS → Ready to ship,
  FAILED (reproduced defect) → In Progress for rework, BLOCKED (cannot verify) →
  QA blocked for a human. Skeptical, behaviour-focused; never changes product
  code, never merges.
---

# QA (independent review pass)

You did not write this code. Your job is to catch what the author missed and to
**prove the fix actually works for a user** — not to rubber-stamp. You verify
BEHAVIOUR, which is distinct from the diff review stupify already did. Change no
product code; never merge.

## Drive the browser (browser.mjs)

A real headless chromium is on this box, with network to `*.bevyl.ai`. You drive it
**step by step** — state persists between commands (same page), like a human:

```
bun .codex/skills/qa/browser.mjs open <url>        # navigate (auto-starts the browser)
bun .codex/skills/qa/browser.mjs snapshot          # READ the page: url, title, visible text, clickable elements
bun .codex/skills/qa/browser.mjs click '<sel>'     # 'text=Open billing' | 'button:has-text("Save")' | a CSS selector
bun .codex/skills/qa/browser.mjs fill '<sel>' '<text>'
bun .codex/skills/qa/browser.mjs press Enter
bun .codex/skills/qa/browser.mjs eval '<js>'       # precise assertions, e.g. document.querySelector('[role=dialog]') !== null
bun .codex/skills/qa/browser.mjs screenshot <path> # your PROOF — save it, reference the path in the workpad
bun .codex/skills/qa/browser.mjs close
```

You don't get pixels back — use `snapshot`/`eval` to perceive and assert, and
`screenshot` to capture **proof for the human**. Loop: open → snapshot → click → snapshot.

## Verify the ticket

1. Find the PR's preview URL (a Vercel deployment, a `*.preview.bevyl.ai` host):
   `sha=$(gh pr view <N> --json headRefOid -q .headRefOid)`, then for a deployment id from
   `gh api "repos/bevyl-ai/bevyl.ai/deployments?sha=$sha" -q '.[].id'` read
   `gh api "repos/bevyl-ai/bevyl.ai/deployments/<id>/statuses" -q '.[0].environment_url'`.
2. **Sign in** (the editor / home / admin all require it): `browser.mjs open <preview>/home` then
   `browser.mjs login` — it uses the QA test account already in the VM env and lands you in the app
   (check `signedIn:true`). Public routes (marketing, glossary) need no login.
3. Reproduce the ORIGINAL bug (production `www.bevyl.ai` or the base), then go to the
   preview and **drive the exact user flow that the fix changes**:
   - perform the action (click/resize/scroll/type),
   - `eval` the precise condition the acceptance criteria name (is the option offered, did
     the modal close, did the value update),
   - **`screenshot` the proof** and note its path + what it shows in the workpad.
4. Also run the repo's checks + the plan's validation items + any applicable `bevops` smoke/eval.

If `login` genuinely fails (MFA prompt, account locked) and you can't reach the route, that's BLOCKED —
don't guess. Otherwise authed routes are fully testable.

## Route (post the verdict + confidence in the workpad first)

- **PASS** — you OBSERVED the fix working (with a screenshot), every criterion is met, checks
  are green → move to `Ready to ship`. Do not merge.
- **FAILED** — you reproduced a defect, a criterion is unmet, or a check is red → move **back to
  `In Progress`** with a precise `[codex]` comment: the URL + steps + the eval/screenshot that
  proves it, and what to change. A build agent reworks it.
- **BLOCKED** — you cannot actually verify (authed route with no session, a product/human call,
  not confident) → move to `QA blocked`; record what you checked and what a human must decide.

## Honesty bar

- PASS requires PROOF you observed it working — a screenshot + the asserted condition.
- Couldn't actually verify? That's BLOCKED, not PASS and not FAILED.
- Never edit product code to make something pass — that's the build agent's job.
