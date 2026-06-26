# bunion

A small, repo-agnostic **dark factory**. Drop a Linear ticket into a column; bunion has Codex implement it in an isolated worktree, runs your checks, and opens a PR. It stops at the PR — the merge is yours.

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony) spec, running Codex through the [exe.dev](https://exe.dev) gateway (your ChatGPT/Codex plan, no API keys).

---

## Setup

### Prerequisites

On the machine that will run bunion (or in your runner image):

- `bun` ≥ 1.3, `git`, `gh` (logged in: `gh auth login`), and `codex` configured for the exe.dev gateway.
- `bunion doctor` checks all four are present.

### 1. Wire up Linear

This is the only non-obvious part. You need **four workflow statuses**, an **API key**, and your **team key**.

**a. Create the statuses.** In Linear: **Settings → Teams → `<your team>` → Issue statuses**. Hit **+** to add each one. bunion filters by the status itself (not its category), so the category is just cosmetic — pick `Unstarted`/`Started` so they show up as columns on the board:

| Status (rename freely) | role | what it means |
| --- | --- | --- |
| `Bunion ready` | trigger | you drop a ticket here = "go" |
| `Rework` *(optional)* | trigger | a second trigger column for re-runs |
| `Bunion working` | working | bunion is on it (it moves the ticket here) |
| `In review` | review | PR is open — your turn |
| `Needs human` | escalate | bunion declined or errored |

`Done` isn't bunion's — Linear moves the ticket there when you merge the linked PR. You can reuse existing columns (e.g. your real `In review`) instead of making new ones; just put the exact names in `.env`.

**b. Get an API key.** **Settings → Account → Security & Access → New API key** (a personal key, starts with `lin_api_`). This is the identity bunion comments and moves tickets as — a personal key is fine.

**c. Find your team key.** It's the prefix on your issue IDs — the `BEV` in `BEV-1234` (also under **Settings → Teams → `<team>` → General**).

### 2. Configure

```bash
cp .env.example .env
```

```ini
# target repo
REPO=bevyl-ai/your-repo
BASE_BRANCH=main

# linear
LINEAR_API_KEY=lin_api_xxxxxxxx
LINEAR_TEAM=BEV

# the four roles — names EXACTLY as they appear in Linear
READY_STATES=Bunion ready,Rework    # a comma-separated list; any of these triggers a pickup
WORKING_STATE=Bunion working
REVIEW_STATE=In review
ESCALATE_STATE=Needs human

# checks run in the worktree before a PR is opened (';'-separated; any failure → Needs human)
BACKPRESSURE=bun run typecheck
MAX_CONCURRENT=3
```

State **names** are resolved to ids at startup — a typo fails loudly listing your real statuses, so you'll know immediately. That map *is* the config; there's no allowlist or estimate gate to tune.

### 3. Install & check

```bash
bun install
bunion doctor        # tools + env present?
```

---

## Run it

```bash
bunion run BEV-1234 --dry     # checkout only, no agent — proves the wiring end to end
bunion run BEV-1234           # claim + run one ticket for real
bunion start                  # the daemon: poll the ready states, ship, review/escalate
bunion status                 # live board: how many tickets in each bunion state
```

Validate one ticket with `bunion run` before you ever `bunion start`. Run **one** daemon, and don't `bunion run` against the same board while it's up — bunion owns the working state, and startup escalates anything it finds sitting there.

---

## How it works

Linear is the state machine. There's no gate predicate and no local database — **the board is the run state, the claim, and the dashboard.**

```
Ready ──▶ Working ──▶ In review ──▶ Done
(you drop) (bunion    (PR open,     (Linear moves it
           claims)    your turn)    when you merge)
             │
             └──▶ Needs human   (agent declined or errored)
```

- **The gate is a column.** Dropping a ticket into a ready state *is* the eligibility decision — you made it.
- **The claim is a transition.** Ready→Working is an atomic write to Linear (the source of truth), so the ticket falls out of the next poll on its own.
- **Failure is a column, not a retry loop.** Errors or declines land in `Needs human`. Fix the ticket, drag it back to a ready state — that re-runs it.

## The feedback loop

- **Per-ticket:** the PR + your review are the signal. Merge = good, close = reject, **drag back to a ready state with a comment = retry with feedback** — bunion folds your newest comments into the prompt on the next run.
- **Aggregate:** the column flow + PR outcomes give you merge-rate / revert-rate / time-in-review. That's the number that earns auto-merge for a class of work, when you decide it has.

## Security model (from stupify)

Codex runs `--sandbox workspace-write` with **no network**; the runner — never the agent — does all `git`/`gh` I/O. A prompt-injected ticket body can at worst leave a bad diff in the worktree (caught by your checks, your review, and the human merge), and can never exfiltrate, reach a token, or run a network command.

## Carve-outs

There's no carve-out list in bunion. If you want a hard wall around `auth`/`billing`/`migrations`, put it in GitHub branch protection / CODEOWNERS on those paths — a real wall an autonomous PR can't merge past. An eligibility check is just a sticky note.

## Workers

- `PROVIDER=local` (default) — runs the pipeline in a per-ticket worktree on this host. Isolation = the worktree + the Codex sandbox. Needs no extra infra.
- `PROVIDER=exedev` — a fresh exe.dev VM per ticket. The seam is stubbed in `src/worker.ts` (three marked spots: create / exec / destroy).

## Symphony → bunion

| Symphony component | here |
| --- | --- |
| Config layer | `src/config.ts` |
| Workflow loader | `src/workflow.ts` + `workflow.md` |
| Issue tracker client | `src/linear.ts` |
| Orchestrator (poll → claim → settle) | `src/orchestrator.ts` + `src/dispatch.ts` |
| Workspace manager | `src/git.ts` |
| Agent runner | `src/codex.ts` + `src/runner.ts` |

MIT.
