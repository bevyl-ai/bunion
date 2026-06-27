---
name: plan
description:
  Scope and groom a Linear ticket into a buildable plan before any code is
  written — the clerk pass. Use at the start of the PLAN phase (status Todo) to
  find the real owner of the change, reproduce the problem, and write explicit
  acceptance criteria + a validation plan into the Codex Workpad. Does not write
  product code.
---

# Plan (the clerk pass)

Turn a raw ticket into something the build phase can execute without guessing.
You write NO product code here — the deliverable is a plan, not a diff.

## Workflow

1. Sync first: run the `pull` skill so you investigate against current `origin/main`.
2. Find the real owner of the change. Don't patch the first symptom — trace to the
   schema / action / loader / service / component / route that actually owns the
   behavior (follow the repo's `AGENTS.md` "Source of truth" guidance).
3. Reproduce or otherwise confirm the problem, and record the exact signal
   (failing test, console error, wrong row, screenshot path) in the workpad.
4. Write the PLAN into the single `## Codex Workpad` comment:
   - **Root cause** — what's actually wrong and where.
   - **Change** — the intended fix and the owner files it touches; keep it the
     smallest change at the right owner.
   - **Acceptance criteria** — what "fixed" means, stated observably (a reviewer
     or QA agent can check each one without you).
   - **Validation plan** — the exact checks/tests/preview steps that will prove
     it, so the build and QA phases run the same bar.
   - **Risks / out-of-scope** — anything to avoid or split into a separate
     `Backlog` issue.
5. Confidence gate:
   - If the ticket is clear enough to build, move it to `In Progress`. Done —
     a fresh build agent takes over.
   - If it's too vague, ambiguous, or looks wrong, do NOT guess. Post `[codex]`
     questions in the workpad and leave it in `Todo` for a human to clarify.

## Bar before handing off to BUILD

- The root cause is identified at the real owner, not a symptom.
- Acceptance criteria are explicit and observable.
- The validation plan is concrete (named checks/tests/preview steps).
- The change is scoped minimal and in-scope; out-of-scope work is split out.
