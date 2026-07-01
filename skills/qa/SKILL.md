---
name: qa
description:
  Independently verify a PR against its acceptance criteria — the review/QA pass
  (status QA - Testing). Drive a real browser step by step with browser.mjs
  (open, snapshot, click, screenshot) to reproduce a bug and PROVE the fix with
  a screenshot, and/or run the repo's checks. Then route: PASS → QA - Requested (a
  human functionally re-tests + merges), FAILED (reproduced defect) → In Progress
  for rework, BLOCKED (cannot verify) → QA - blocked for a human. Skeptical,
  behaviour-focused; never changes product code, never merges.
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
bun .codex/skills/qa/browser.mjs screenshot <path> # capture the proof
bun .codex/skills/qa/browser.mjs close
```

**Post the proof.** Screenshots are your evidence — upload each to S3 and embed it in the PR:

```
bun .codex/skills/qa/shot.mjs <path.png> <name>          # -> prints a public https URL
gh pr comment <N> --body "QA: <what it shows> ![proof](<url>)"   # renders inline in the PR
```

You don't get pixels back — use `snapshot`/`eval` to perceive and assert, and
`screenshot` to capture **proof for the human**. Loop: open → snapshot → click → snapshot.

## Verify the ticket

1. The preview URL comes from the **PR body** — read it with `gh pr view <N> --json body -q .body`. It contains a
   `Preview: https://...preview.bevyl.ai` line (the deployed app) and usually an `Action:` line with the exact
   route + repro steps. Use that preview URL and follow the Action steps. Do NOT construct `pr-<N>` hosts, guess
   hostnames, or use the deployments API / Vercel dashboard (they 403 / need a login from this VM).
2. **Sign in** (the editor / home / admin all require it): `browser.mjs open <preview>/home` then
   `browser.mjs login` — it uses the QA test account already in the VM env and lands you in the app
   (check `signedIn:true`). Public routes (marketing, glossary) need no login.
3. Reproduce the ORIGINAL bug (production `www.bevyl.ai` or the base), then go to the
   preview and **drive the exact user flow that the fix changes**:
   - perform the action (click/resize/scroll/type),
   - `eval` the precise condition the acceptance criteria name (is the option offered, did
     the modal close, did the value update),
   - **`screenshot` the proof, upload it with `shot.mjs`, and post it to the PR** (see "Post the proof"). On a PASS, the PR should carry a screenshot showing the fixed behaviour.
4. Also run the repo's checks + the plan's validation items + any applicable `bevops` smoke/eval.

If `login` genuinely fails (MFA prompt, account locked) and you can't reach the route, that's BLOCKED —
don't guess. Otherwise authed routes are fully testable.

## Route (post the verdict + confidence in the workpad first)

- **PASS** — you OBSERVED the fix working (with a screenshot), every criterion is met, checks
  are green → move to `QA - Requested` (the human QA gate — a person functionally re-tests and owns the
  merge from there). Do not merge, and don't move it past `QA - Requested`.
- **FAILED** — you reproduced a defect, a criterion is unmet, or a check is red → move **back to
  `In Progress`** with a precise `[codex]` comment: the URL + steps + the eval/screenshot that
  proves it, and what to change. A build agent reworks it.
- **BLOCKED** — you cannot actually verify (authed route with no session, a product/human call,
  not confident) → move to `QA - blocked`; record what you checked and what a human must decide.

## Honesty bar

- PASS requires PROOF you observed it working — a screenshot + the asserted condition.
- Couldn't actually verify? That's BLOCKED, not PASS and not FAILED.
- Never edit product code to make something pass — that's the build agent's job.
