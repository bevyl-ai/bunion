# src/AGENTS.md

The host. ~2.6k lines, no framework. Start with [`orchestrator.ts`](orchestrator.ts) — it wires everything
else together. See the root [`AGENTS.md`](../AGENTS.md) for invariants and style; this file is the module map
and the common recipes.

## Modules

| File | Owns |
|---|---|
| [`cli.ts`](cli.ts) | the four subcommands; `start` is the daemon, the rest are one-shot |
| [`config.ts`](config.ts) | `loadConfig()` (front matter → `Config`), `phaseOf()`, `validateConfig()` |
| [`workflow.ts`](workflow.ts) | `parseWorkflow()` (split front matter / body), `renderPrompt()` (strict Liquid) |
| [`orchestrator.ts`](orchestrator.ts) | the poll loop, dispatch/retry/reconcile, deadlock, placement, snapshot, chat/actions, the pool |
| [`agent-runner.ts`](agent-runner.ts) | `startAgent()` — one worker session: workspace prep → turns on one thread → handoff |
| [`role-runner.ts`](role-runner.ts) | `startRole()` — one run of a pool role on a persistent thread |
| [`codex/app-server.ts`](codex/app-server.ts) | `AppServerSession` — the JSON-RPC client; the only class |
| [`codex/dynamic-tool.ts`](codex/dynamic-tool.ts) | `linearGraphqlTool()` — the host tool the agent calls |
| [`linear.ts`](linear.ts) | `graphql()` + typed reads (`fetchBoard`, `fetchCandidates`, `fetchById`, …) + operator mutations (`moveIssue`, `postComment`) |
| [`workspace.ts`](workspace.ts) | `ensureWorkspace`/`removeWorkspace`/`runHook`/`installSkills`, local or over ssh |
| [`ssh.ts`](ssh.ts) | `sshExec`/`scpInto`/`remoteHome`/`shq` |
| [`persist.ts`](persist.ts) | `readJson`/`writeJson`/`throttledWriter` for the `~/.bunion` state files |
| [`tokens.ts`](tokens.ts) | pure token-tally helpers: `foldDelta`, `phaseBreakdown`, `grandTotal`, `totals` |
| [`thread-backfill.ts`](thread-backfill.ts) | recover codex threads from worker rollouts when bunion has no record |
| [`dashboard.ts`](dashboard.ts) | the status server + the self-contained HTML page; `BoardItem`/`Snapshot`/`RoleItem` |
| [`types.ts`](types.ts) | shared interfaces (`Config`, `Issue`, `Role`, `TokenCounts`, `AgentEvent`, `DynamicTool`) |
| [`proc.ts`](proc.ts) / [`log.ts`](log.ts) | local `exec`/`have`; `log`/`warn` |

## The dispatch flow (one ticket)

```
poll → board (linear.ts)
  └─ eligible(issue)? ── placeFor(id) ── dispatch(issue, attempt, host)
        └─ startAgent (agent-runner.ts)
             ├─ ensureWorkspace + after_create hook + installSkills (workspace.ts / ssh.ts)
             ├─ AppServerSession.start → resumeThread | startThread (codex/app-server.ts)
             └─ loop runTurn until: not active | crossed phase | max_turns
        └─ on done: ok → continuation retry (re-check & continue); !ok → backoff retry
reconcile (each tick): stall-timeout, terminal → cleanup, left-active → stop
```

Events flow back up via the `onEvent(AgentEvent)` callback: the orchestrator folds token deltas into the
per-ticket/phase tally, appends to the ticket's log, persists the resolved `threadId`, and feeds the snapshot.

## Recipes

**Add an operator action (dashboard button).** Extend `onAction()` in [`orchestrator.ts`](orchestrator.ts) —
follow `to-qa`/`move:`/`restart`. The rule: `stopRun()` to end the current turn but **keep** the pin +
workspace + thread, do the Linear move via `moveIssue()`, then `scheduleRetry(..., continuation=true)` so the
next dispatch resumes the same thread on the same worker. `restart` is the only one that drops the thread.

**Add a pool role.** No code — add a row under `roles:` in [`WORKFLOW.md`](../WORKFLOW.md) (name, cadence,
prompt, model) and restart. The engine (`dispatchRole`/`startRole`) is generic. Roles file tickets through the
same `linear_graphql` tool; they run on a cadence, don't count against the per-ticket cap, and resume their own
persistent thread each run.

**Add a tracker read.** Add the GraphQL const + a typed `fetch*` in [`linear.ts`](linear.ts) reusing
`query<T>()` (it throws on http error / GraphQL `errors` / empty data). Reuse `ISSUE_FIELDS` + `toIssue` so the
normalized `Issue` shape stays consistent.

**Handle a new app-server message.** Add a case in `AppServerSession.handleNotification` /
`handleServerRequest` ([`codex/app-server.ts`](codex/app-server.ts)). Server→client requests that need a reply
must be answered (auto-approve or a benign `{}`) or the turn stalls. New approval method? Extend `autoApprove`.

## Persisted state (`~/.bunion/`)

`threads.json` (issue.id / `role:<name>` → `{ threadId, host }`), `tokens.json` (identifier → phase →
`TokenCounts`), `logs.json` (identifier → recent log lines). All best-effort writes, debounced ~3s. Workspaces
live at `workspace.root` locally, or `~/.bunion/workspaces/<key>` on each worker VM.
