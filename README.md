# bunion

A small, repo-agnostic **dark factory**: point it at a GitHub repo + a Linear board, drop a ticket into a column, and it has Codex implement it in an isolated worktree, runs your checks, and opens a PR. It stops at the PR — the merge is the trust boundary.

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony) spec, built to run Codex through the [exe.dev](https://exe.dev) gateway (your ChatGPT/Codex plan, no API keys).

## Linear is the state machine

There is no gate predicate and no local database. **The board is the run state, the claim, and the dashboard.** bunion only needs to know which states map to four roles; your board can have any number of other columns it ignores.

```
Ready ──▶ Working ──▶ In review ──▶ Done
(you drag) (bunion    (PR open,     (Linear moves it
           claims)    your turn)    when you merge)
             │
             └──▶ Needs human   (agent declined or errored)
```

- **The gate is a column.** Dropping a ticket into a ready state *is* the eligibility decision — you made it. No estimate ceiling, no allowlist, no carve-out matrix.
- **The claim is a transition.** Moving Ready→Working is an atomic write to Linear, the single source of truth, so the ticket falls out of the next poll on its own.
- **Failure is a column, not a retry loop.** The agent declines or errors → `Needs human`. You look, fix the ticket, drag it back to a ready state — that re-runs it, with your comment folded into the prompt.

## Config is the board

```
READY_STATES=Bunion ready,Rework   # any of these triggers a pickup (a list)
WORKING_STATE=Bunion working
REVIEW_STATE=In review
ESCALATE_STATE=Needs human
```

State names are resolved to ids at startup; a typo fails loudly listing your real states. That's the whole policy — it replaces the old estimate/allowlist/carve-out/blocker machinery.

## The feedback loop

- **Per-ticket:** the agent's PR + your review *are* the signal. Merge = good, close = reject, **drag back to a ready state with a comment = retry with feedback** — bunion re-runs and folds your note into the prompt.
- **Aggregate:** the column flow + PR outcomes give you the metric (merge-rate, revert-rate, time-in-review). That's what earns auto-merge for a class of work, when you decide it has.

## Security model (inherited from stupify)

Codex runs `--sandbox workspace-write` with **no network**; the runner — never the agent — does all `git`/`gh` I/O. A prompt-injected ticket body can at worst leave a bad diff in the worktree (caught by backpressure, review, and the human merge), and can never exfiltrate, reach a token, or run a network command.

## Carve-outs

There is no carve-out list in bunion. If you want a hard wall around `auth`/`billing`/`migrations`, put it in GitHub branch protection / CODEOWNERS on those paths — that's a real wall an autonomous PR can't merge past. An eligibility check is just a sticky note.

## Setup

1. **Runner host/image** — needs `bun`, `git`, `gh` (authed), and `codex` configured for the exe.dev gateway. `bunion doctor` checks the tools. (This is the stupify VM image; reuse it.)
2. In Linear: add the workflow states you named in `.env` (`Bunion ready`, `Bunion working`, `In review`, `Needs human`, …).
3. `cp .env.example .env`, fill in `REPO` / `LINEAR_API_KEY` / `LINEAR_TEAM` and the state names.
4. `bun install`

## Use

```bash
bunion doctor                 # tools + env present?
bunion run BEV-1234 --dry     # checkout only, no agent — proves the wiring
bunion run BEV-1234           # claim + run one ticket end to end
bunion start                  # the daemon
bunion status                 # live board: counts per bunion state
```

Run a single ticket with `bunion run` before you ever `bunion start`. Run **one** daemon, and don't `bunion run` against the same board while it's up — bunion owns the working state, and the startup orphan sweep escalates anything it finds sitting there.

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
