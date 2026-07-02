# Architecture

How the host works internally. For user-facing setup see the [README](../README.md); for the agent's
behavior see [`WORKFLOW.md`](../WORKFLOW.md).

## The shape

```
                         ┌──────────────── orchestrator (one daemon) ───────────────┐
   Linear  ◀── poll ───  │  reconcile → poll board → deadlock sweep → dispatch       │
     ▲                   │  retry timers · placement (VM pinning) · token tally      │
     │ linear_graphql    │  operator chat/actions · the pool (ambient roles)         │
     │ (host answers)    └───┬──────────────────────────────────────────────┬───────┘
     │                       │ startAgent (per ticket)                       │ startDashboard
     │                  ┌────▼─────────────────────────┐               ┌─────▼─────┐
     └───────────────── │ AppServerSession (JSON-RPC)  │               │ :PORT     │
                        │  codex app-server  (local or │               │ /state.json
                        │  over ssh on a worker VM)    │               │ /transcript
                        └──────────────────────────────┘               │ /action /chat
                                                                       └───────────┘
```

The host never edits Linear state or git for the normal flow — the **agent** does, by calling the host's
`linear_graphql` tool, which the host executes with the configured auth. The host's own Linear writes are
limited to operator actions and deadlock auto-moves.

## The poll loop

[`orchestrator.ts`](../src/orchestrator.ts) `start()` runs forever. Each tick:

1. **Reload config** from `WORKFLOW.md` (keep last-known-good on a bad edit — never skip a tick over a config
   error).
2. **`reconcile()`** — for every *running* session: enforce the stall timeout (`codex.stall_timeout_ms`); then
   re-fetch the issues by id and terminate any that went terminal (cleanup workspace), lost the required label,
   or left the active states; refresh the in-memory issue for the rest.
3. **Poll the board** — one labeled query returns the whole board (active + handed-off + recently merged);
   unlabeled configs fall back to the active-states query. Re-filter host-side to the opt-in label set.
4. **Surface stuck reasons + run the deadlock sweep** (below).
5. **Dispatch** eligible issues in `byDispatch` order (priority → oldest → identifier) while slots and worker
   VMs are free.

`eligible(i)` = active, non-terminal, carries the required labels, not blocked by an open Linear blocker, not
already claimed/running.

## Sessions, threads, and handoff

A **session** is one `startAgent` run ([`agent-runner.ts`](../src/agent-runner.ts)): prep the workspace (clone
via the `after_create` hook, install skills), open an `AppServerSession`, resume-or-start the ticket's thread,
then run turns on that one thread. It stops the worker when the ticket:

- **left the active states** (handed off downstream — e.g. to QA), or
- **crossed into a new phase** (`phaseOf` changed — a *fresh* agent runs the next phase), or
- hit **`max_turns`** (graceful cap; the orchestrator may dispatch a fresh worker to continue).

**One thread per ticket.** Thread ids are persisted (`~/.bunion/threads.json`, issue.id → `{ threadId, host }`)
so the next phase and operator chat resume the *same* codex conversation — its full reasoning + tool history
carries forward. A resume that fails (rollout gone, version skew) falls back to a fresh thread so a ticket is
never wedged. Threads bunion has no record of (pre-persistence tickets) are **backfilled** once on the first
board by reading each worker's codex SQLite DB, keyed by the ticket's workspace path.

## The app-server client

[`codex/app-server.ts`](../src/codex/app-server.ts) `AppServerSession` is a minimal JSON-RPC client over the
codex `app-server` stdio stream (newline-delimited JSON, not `Content-Length`). One subprocess per session;
turns run on the same thread. Notable:

- **Unattended by design.** Server→client requests (tool calls, command/file approvals, user-input) are
  answered inline — approvals auto-accepted (`approval_policy: never`), tool calls dispatched to the registered
  `DynamicTool`s, anything else answered benignly — so a turn never stalls waiting on a human.
- **`dangerFullAccess`** is the default turn sandbox: codex's `workspace-write` write-protects `.git`
  regardless of `writableRoots`, which breaks the agent driving its own git. The real containment is running
  each agent in a disposable VM, not the sandbox.
- **The turn waiter is armed before `turn/start`** is sent: a fast turn can stream `turn/completed` in the same
  stdout chunk as the `turn/start` response, so the terminal event needs somewhere to land or the turn hangs.
- **Token usage** arrives as `thread/tokenUsage/updated` with the thread-cumulative `total`; the client emits
  it and the orchestrator folds the delta (below).

## Token accounting

codex reports *thread-cumulative* usage each turn. The orchestrator keeps a `tokenBase` per running session and
folds only the delta into a tally keyed `identifier → phase → TokenCounts`, persisted to `~/.bunion/tokens.json`
(debounced ~3s). Attributing per phase is why `tokenBase` resets at handoff. The dashboard sums these for the
all-time total and the per-ticket per-phase breakdown.

## Retry, backoff, continuation

When a session resolves:

- **ok** → schedule a **continuation** retry (`CONTINUATION_MS`, 1s): re-check the ticket and, if still active
  in the same phase, run another turn — this is how a ticket keeps moving across `max_turns` boundaries.
- **not ok** → schedule a **failure** retry with exponential backoff (`FAILURE_BASE_MS` × 2ⁿ, capped at
  `agent.max_retry_backoff_ms`).

`onRetry` re-fetches candidates, drops the ticket if it's terminal/ineligible, waits for a free slot + worker,
then re-dispatches — a continuation reuses the pinned VM; a fresh retry takes any free worker. Retry timers
carry a `token` (sequence number) so a superseded timer is ignored.

## Deadlock detection

A **forward-progress clock** per ticket: reaching a pipeline state it hasn't been in *this lifecycle* resets the
clock and records the token count; sitting in already-seen states burns it down (catches oscillation like
In Progress ↔ QA Requested, or a fix that never lands). `deadlockReason` (pure, unit-tested in
[`orchestrator.test.ts`](../src/orchestrator.test.ts)) trips when:

- no forward progress for `deadlock.hard_stall_ms` (regardless of spend), **or**
- `deadlock.tokens` burned **and** stalled at least `deadlock.stall_ms`.

A tripped ticket is auto-moved to `QA blocked` (the unblocker phase triages it) with an explanatory comment, or
straight to `Needs Engineer` if it already deadlocked once this lifecycle.

## Worker placement (the VM pool)

With `worker.ssh_hosts` set, each ticket's workspace + clone + codex run **on** a VM, driven over the ssh stdio
pipe; the orchestrator stays central and answers `linear_graphql` itself, so VMs need neither bunion nor any
secret. Placement rules ([`orchestrator.ts`](../src/orchestrator.ts) `placeFor`):

- a ticket is **pinned** to one host for its whole life (continuation turns reuse the same checkout + workpad);
- a resume prefers the host holding the ticket's rollout (so it lands where the thread lives after a restart);
- otherwise spread to the least-loaded host with a free slot (`max_concurrent_agents_per_host`);
- if every worker is full, wait for the next poll.

Stale workspaces (~5–6 GB each) are swept every 20 min: prune any workspace on a VM that isn't currently pinned
there and hasn't been touched in 20 min.

## The pool (ambient roles)

Beside the per-ticket pipeline, each configured **role** ([`role-runner.ts`](../src/role-runner.ts)) runs on its
own cadence with a persistent thread (resumed each run so it remembers what it filed) and its own model. Roles
**file** tickets through `linear_graphql` — they never fix code, never open PRs. They pin to a worker, don't
count against the per-ticket cap, and skip a tick if their previous run is still going. `mechanic` (repo/factory
health) and `dreamer` (new work) ship as defaults; adding a role is a config row, no code change.

## Operator chat & actions

The dashboard can drive an **idle** ticket:

- **chat** (`/chat`) — reopen the ticket's thread on its worker and run one **read-only** turn with the
  operator's message, appending both sides to the transcript. Runs in the worker's *home*, not the (possibly
  pruned) ticket workspace — `thread/resume` loads full context regardless of cwd. Refused while an agent is
  live on the ticket (it owns the thread).
- **actions** (`/action`) — pure pipeline transitions (`to-qa`, `to-build`, `move:<state>`, `restart`). The
  thread carries the context, so an action just advances the ticket and the next dispatch resumes the same
  thread on the same worker. `restart` is the hard reset: wipe the workspace and drop the thread.
