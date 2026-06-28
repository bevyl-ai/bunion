# AGENTS.md

Guidance for an agent working **on the bunion codebase**. (For how the *agents bunion drives* behave, that's
the prompt in [`WORKFLOW.md`](WORKFLOW.md) and the [`skills/`](skills/) — see [Two layers](#two-layers).)

## What this is

A Bun/TypeScript port of OpenAI's Symphony: a thin host that drives **Codex** (over its `app-server` JSON-RPC
stream) to take Linear tickets through a staged pipeline — plan → build → QA → verify → human merge. The
orchestrator only polls, dispatches, reconciles, and answers the agent's tool calls. Everything else (git, `gh`,
code, Linear writes) is done by the Codex agent driven by `WORKFLOW.md`.

The single load-bearing idea: **the host is thin, the agent is fat.** Resist moving agent work into the host.

## Commands

```bash
bun install
bun run typecheck          # tsc -p tsconfig.json — the only "build"; run before claiming done
bun test                   # bun:test; currently just src/orchestrator.test.ts (pure fns)
bun src/cli.ts doctor      # tools + env + WORKFLOW.md load
bun src/cli.ts status      # issues per active state
bun src/cli.ts run BEV-123 # one worker session for a ticket (testing)
bun run start              # the daemon (bun src/cli.ts start)
```

There is no bundler, no emit (`noEmit`), no lint step. `bun run typecheck` is the gate.

## Two layers

Changing behavior means editing one of two places — know which:

- **Host behavior** → `src/` (polling, dispatch, retry, the app-server client, placement, the dashboard).
- **Agent behavior** → [`WORKFLOW.md`](WORKFLOW.md) (the prompt + front-matter config) and [`skills/`](skills/).
  Most "the agent should do X" changes are prompt/skill edits, **not** TypeScript. The prompt *is* the state
  machine; the host just re-dispatches at phase boundaries.

`WORKFLOW.md` is both: YAML front matter (config, parsed by [`config.ts`](src/config.ts)) **and** the Liquid
prompt body below the second `---` ([`workflow.ts`](src/workflow.ts)).

## Architecture map

```
cli.ts            start | run | status | doctor
config.ts         WORKFLOW.md front matter → typed Config (one upfront normalize pass; $VAR → env)
workflow.ts       split front matter / Liquid prompt; render per-ticket
orchestrator.ts   the daemon: poll → reconcile → dispatch → retry; deadlock; placement; chat/actions; pool
agent-runner.ts   one worker session: turns on a single thread until handoff / phase-cross / max_turns
role-runner.ts    one run of a pool role (ambient agent on a cadence; files tickets, never fixes)
linear.ts         tracker reads + the raw graphql() the host tool and host reads share
codex/app-server.ts   JSON-RPC client over codex stdio: thread/turn lifecycle, auto-approve, token usage
codex/dynamic-tool.ts the linear_graphql host tool the agent calls
workspace.ts      per-issue workspace, hooks, skill install (local or over ssh)
ssh.ts            run workspace ops + spawn codex on a worker VM
persist.ts        readJson / writeJson / throttledWriter for the ~/.bunion state files
tokens.ts         per-ticket/phase token tally helpers (pure): foldDelta, phaseBreakdown, grandTotal, totals
thread-backfill.ts  recover codex threads from worker rollouts when bunion has no record
dashboard.ts      live status server: /state.json, /transcript/<id>, /action, /chat
types.ts          the shared interfaces
```

Deeper detail lives in [`docs/`](docs/): [architecture](docs/architecture.md) ·
[configuration](docs/configuration.md) · [operations](docs/operations.md).

## Invariants — don't break these

- **No automerge.** The agent stops at `Ready to ship`; a human merges. Never add `gh pr merge`/auto-merge.
- **The host doesn't touch Linear state or git for normal flow** — the agent does, via `linear_graphql`. The
  only host-side Linear writes are *operator* actions (dashboard buttons) and *deadlock* auto-moves, both using
  the operator key in [`linear.ts`](src/linear.ts).
- **One codex thread per ticket**, persisted (`~/.bunion/threads.json`) so plan→build→QA and operator chat all
  resume the same conversation. A thread is pinned to the worker that holds its rollout.
- **Phase handoff = a fresh agent.** When a ticket crosses a phase boundary the worker stops; the next phase
  runs as a new session (so QA isn't graded by the author). See [`agent-runner.ts`](src/agent-runner.ts).
- **The daemon must never die on one ticket's failure.** Every tick is wrapped; there's an `unhandledRejection`
  guard; setup/host failures resolve a session as `{ ok: false }` to be retried, never thrown to the top.
- **State survives restarts.** Threads, per-ticket/phase tokens, and logs are persisted under `~/.bunion/`.

## Code style

Matches the rest of `src/` — minimal, closure-based, comment the *why*:

- ESM + Bun APIs; strict TS with `noUncheckedIndexedAccess`. Keep modules small and single-purpose.
- **No classes** except `AppServerSession` (it owns a subprocess + JSON-RPC state). Handles are plain objects
  with a `done` promise + `stop()`, state in closures (`startAgent`, `startRole`).
- **Normalize input once, upfront** ([`config.ts`](src/config.ts)) so every downstream function gets a fully
  resolved struct — don't re-parse config at call sites.
- Small pure helpers (`deadlockReason`, `phaseOf`, `byDispatch`); prefer early-return guards over nesting.
- Comments explain the non-obvious *why* (the turn-waiter armed before `turn/start`, ssh stdout-only capture,
  the `.git` write-protect → `dangerFullAccess`). Don't narrate the what.
- Don't add speculative config seams, generic params, or abstractions nothing uses yet. The simplest change
  that fits the surrounding code is the right one.

## Testing

Pure logic is unit-tested with `bun:test` ([`orchestrator.test.ts`](src/orchestrator.test.ts) covers
`deadlockReason`). There's no integration harness for the daemon — exercise real flows with
`bun src/cli.ts run <ID>` against a test ticket. When you add a pure function with real branching, add a test.

## Gotchas

- **Config hot-reloads** at the top of every poll; a bad edit keeps the last-known-good config (the daemon logs
  it and keeps running). Role/`server.port` changes are read at startup only — restart to apply.
- **The app-server protocol is pinned** to the Codex build the host spawns (`codex.command`). Message shapes in
  `codex/app-server.ts` track that build; bumping codex can require updating the handlers.
- **ssh capture reads stdout only** ([`ssh.ts`](src/ssh.ts) `remoteHome`): a diagnostic on stderr concatenated
  into `$HOME` once corrupted a path. Keep that separation if you touch ssh.
- **Secrets/`$VAR`**: front-matter values like `$LINEAR_API_KEY` resolve from env with a canonical-env fallback
  ([`config.ts`](src/config.ts) `secret()`). The host needs a real `LINEAR_API_KEY`; an interactive MCP
  connection does not carry into the daemon.
