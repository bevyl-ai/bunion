# bunion

A small, repo-agnostic **dark factory**: point it at a GitHub repo + a Linear project, and it picks up eligible tickets, has Codex implement them in an isolated worktree, runs your checks, and opens a PR. It stops at the PR — the merge is the trust boundary.

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony) spec, built to run Codex through the [exe.dev](https://exe.dev) gateway (your ChatGPT/Codex plan, no API keys).

## How it runs

Two programs, no queue or broker:

- **`bunion start`** — a daemon. Polls Linear, runs the eligibility gate, claims tickets in a local SQLite db, and dispatches up to `MAX_CONCURRENT` at once.
- **the runner** — the per-ticket pipeline (`src/runner.ts`): fresh shallow checkout → `codex exec` in a sandbox → backpressure (typecheck/tests) → commit, push, open PR. Runs in-process (`local` worker) or on a fresh exe.dev VM per ticket (`exedev` worker).

```
Linear ticket ──▶ eligibility gate ──▶ worktree ──▶ codex exec ──▶ backpressure ──▶ PR ──▶ (you merge)
   label:factory    pure predicate      isolated     no network      typecheck       stops here
```

## The gate (`src/eligibility.ts`)

Decided before any worker spawns. A ticket is eligible iff:

- it has the `factory` label, **and**
- its estimate ≤ `MAX_ESTIMATE`, **and**
- it declares scope via an `area:<component>` label, **and**
- that component is in `ALLOWLIST` and **not** in `CARVE_OUTS`, **and**
- it isn't blocked by an open dependency.

Carve-outs (`auth`, `billing`, `migrations`, `rls`, `secrets`, `infra`, …) are never autonomous, full stop. Widening `ALLOWLIST` one component at a time is how you grow the factory. Candidates are dispatched in Symphony's order: priority (urgent→low), then oldest first.

## Security model (inherited from stupify)

Codex runs `--sandbox workspace-write` with **no network**; the runner — never the agent — does all `git`/`gh` I/O. So a prompt-injected ticket body can at worst leave a bad diff in the worktree (caught by backpressure, review, and the human merge), and can never exfiltrate, reach a token, or run a network command.

## Staged autonomy

Bunion opens PRs; **it does not merge.** Run it in shadow for ~20–30 PRs, watch the would-merge and revert rates per component, then add a trusted component to `AUTO_MERGE` and wire `gh pr merge --auto` behind your branch protection. Until then every PR is human-merged.

## Reliability

- **Retry with backoff** — a transient failure (flaky test, network blip, codex timeout) parks the ticket in `retry` and re-dispatches with exponential backoff up to `MAX_ATTEMPTS`, then escalates. It is never silently burned.
- **Reconcile before publish** — the runner re-reads the ticket's state after the agent finishes; if a human cancelled or resolved it mid-run, no PR is opened.
- **Crash recovery** — a run interrupted by a daemon restart is re-queued, not wedged.
- **Empty diff = escalation** — if the agent declines (underspecified, needs a human decision), that's a distinct `escalated` status in `bunion status`, not a failure.

## Setup

1. **Runner host/image** — needs `bun`, `git`, `gh` (authed), and `codex` configured for the exe.dev gateway. `bunion doctor` checks the tools. (This is the stupify VM image; reuse it.)
2. `cp .env.example .env` and fill in `REPO`, `LINEAR_API_KEY`, `LINEAR_TEAM`, and the policy.
3. In Linear: create the `factory` label and `area:<x>` labels for your allowlisted components.
4. `bun install`

## Use

```bash
bunion doctor                 # tools + env present?
bunion run BEV-1234 --dry     # checkout only, no agent — proves the wiring
bunion run BEV-1234           # one ticket, end to end, prints the result JSON
bunion start                  # the daemon
bunion status                 # recent runs
```

Validate a single ticket with `bunion run` before you ever `bunion start`.

## Symphony → bunion

| Symphony component | here |
| --- | --- |
| Config layer | `src/config.ts` (env + policy) |
| Workflow loader | `src/workflow.ts` + `workflow.md` |
| Issue tracker client | `src/linear.ts` |
| Orchestrator (poll → dispatch → reconcile) | `src/orchestrator.ts` + `src/runner.ts` |
| Run state + retry/backoff | `src/state.ts` |
| Workspace manager | `src/git.ts` |
| Agent runner | `src/codex.ts` |

MIT.
