# Configuration

All config is the **YAML front matter of [`WORKFLOW.md`](../WORKFLOW.md)** (everything above the second `---`);
the body below it is the agent prompt. [`config.ts`](../src/config.ts) parses the front matter into a typed
`Config` in one upfront pass, applying defaults and resolving `$VAR` references. Edit `WORKFLOW.md` and the
daemon hot-reloads on the next poll (it keeps the last-known-good config on a parse/validation error).

## Value resolution

- **`$VAR`** in a string resolves from the environment. Missing/empty falls back to the canonical env var for
  that field, then `null`. A bare literal (no `$`) is used as-is. (`secret()` in `config.ts`.)
- **Paths** (`workspace.root`) also expand `~` and a `$VAR`; a relative path resolves against `WORKFLOW.md`'s
  directory.
- **Durations** for role `cadence`: a bare number is milliseconds; `45s` / `30m` / `4h` / `1d` are parsed
  (default unit minutes). `0`/unparseable → the role is skipped.

## `tracker`

| Key | Default | Env fallback | Notes |
|---|---|---|---|
| `kind` | — (required) | | must be `linear` |
| `endpoint` | `https://api.linear.app/graphql` | | |
| `api_key` | — (required) | `LINEAR_API_KEY` | the operator key; the daemon's reads + operator actions |
| `app_token` | `null` | `LINEAR_APP_TOKEN` | OAuth `actor=app` token: the agent posts as the app, per-phase name via `createAsUser` |
| `project_slug` | `null` | `LINEAR_PROJECT_SLUG` | scope to one project, **or** |
| `team` | `null` | `LINEAR_TEAM` | scope to a whole team (key, e.g. `BEV`) — pair with `required_labels` |
| `required_labels` | `[]` | | opt-in: only labeled tickets enter the factory. Matched host-side, case-insensitive, AND |
| `active_states` | `[Todo, In Progress]` | | states the factory works (the phases run here) |
| `terminal_states` | `[Closed, Cancelled, Canceled, Duplicate, Done]` | | reaching one ends + cleans up the ticket |

Scope is required: set `team` or `project_slug`. `required_labels` are normalized (trim + lowercase + dedupe).

## `polling`

| Key | Default | Notes |
|---|---|---|
| `interval_ms` | `30000` | poll cadence |

## `phases`

A map of phase name → the states it covers. A worker hands off to a **fresh** agent when a ticket crosses a
phase boundary (`phaseOf` in `config.ts`). Unmapped states are their own phase, so moving into one (e.g.
`Ready to ship`) still reads as a handoff. Matching ignores case + surrounding whitespace. Only the states
listed in `active_states` are actually worked — a phase mapped to a non-active state is documentation.

## `roles` — the pool

A list of ambient agents that run beside the pipeline. Each row:

| Key | Notes |
|---|---|
| `name` | required; identifies the role + its persistent thread |
| `cadence` | required; how often it runs (see Durations) |
| `prompt` | required; the standing mission, sent as the turn each run |
| `model` | optional codex model for this role's turns; null = the worker default |

Rows missing a name/prompt or with an invalid cadence are dropped. Roles are read at startup — restart to apply
changes. See [architecture › the pool](architecture.md#the-pool-ambient-roles).

## `worker`

| Key | Default | Notes |
|---|---|---|
| `ssh_hosts` | `[]` (or `BUNION_SSH_HOSTS=a,b,c`) | empty → run agents locally; else each ticket runs on a VM over ssh |
| `max_concurrent_agents_per_host` | `1` | agents per VM; `danger-full-access` is contained per box |

The effective concurrency cap is `min(agent.max_concurrent_agents, hosts × max_per_host)`.

## `agent`

| Key | Default | Notes |
|---|---|---|
| `max_concurrent_agents` | `10` | global cap on concurrent sessions |
| `max_concurrent_agents_by_state` | `{}` | per-state concurrency caps (state name → max agents running in that state); absent states fall back to the global cap. Bounds an expensive stage's blast radius |
| `max_turns` | `20` | turns per session before a graceful handoff cap |
| `max_retry_backoff_ms` | `300000` | ceiling for failure backoff |

## `codex`

| Key | Default | Notes |
|---|---|---|
| `command` | `codex app-server` | the app-server the host spawns (the protocol is pinned to it) |
| `approval_policy` | `never` | `never` → the host auto-approves the agent's command/file/tool requests |
| `thread_sandbox` | `workspace-write` | `thread/start` sandbox (a string). `WORKFLOW.md` sets `danger-full-access` so the agent can drive its own git |
| `turn_sandbox_policy` | `null` | `turn/start` `sandboxPolicy` (an object); null → defaults to `{ type: dangerFullAccess }` |
| `turn_timeout_ms` | `3600000` | per-turn timeout |
| `read_timeout_ms` | `5000` | initialize/handshake timeout (raise on slow/shared-CPU VMs) |
| `stall_timeout_ms` | `300000` | no activity for this long → terminate + retry the session |

## `hooks`

Shell run in the workspace at lifecycle points (local, or over ssh on the worker). All default `null`.

| Key | When |
|---|---|
| `after_create` | once, when a workspace is first created (e.g. clone the repo / make a worktree) |
| `before_run` | before each session's turns |
| `after_run` | after each session (failure logged, not fatal) |
| `before_remove` | before a workspace is deleted |
| `timeout_ms` | hook timeout (default `60000`) |

## `workspace`

| Key | Default | Notes |
|---|---|---|
| `root` | `<tmpdir>/bunion_workspaces` | the **local** workspace root only; on a VM, workspaces live at `~/.bunion/workspaces/<key>` |

## `deadlock`

| Key | Default | Notes |
|---|---|---|
| `hard_token_cap` | `200000000` | absolute per-ticket total-spend ceiling before the factory parks the ticket in `Factory - Needs Engineer` |
| `max_effective_token_cap` | `hard_token_cap * 2` | maximum cap after audited budget grants; a grant that would still leave the ticket capped is refused instead of silently creating a multi-billion cap |
| `tokens` | `20000000` | tokens burned with no new pipeline state (once stalled ≥ `stall_ms`) → block |
| `stall_ms` | `1800000` (30 min) | min time with no forward progress before the token rule trips |
| `hard_stall_ms` | `5400000` (90 min) | no forward progress this long → block regardless of token spend |

See [architecture › deadlock detection](architecture.md#deadlock-detection).

## `server`

| Key | Default | Env override | Notes |
|---|---|---|---|
| `port` | `null` (off) | `BUNION_PORT` | the live status dashboard HTTP port |
