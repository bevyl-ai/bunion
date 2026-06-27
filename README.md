# bunion

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony): a thin harness that drives Codex (via its app-server) to take a Linear ticket through a staged pipeline — plan, build, QA — to a reviewed PR ready for a human to merge. Point it at a repo and a Linear project; it polls, spawns a Codex agent per ticket, and the agent does the work.

Codex runs through the [exe.dev](https://exe.dev) gateway, so it uses your ChatGPT/Codex plan rather than metered API tokens.

## How it works

The orchestrator is thin and the agent is fat.

The **host** does three things:

- polls Linear for issues in the configured `active_states`,
- spawns one `codex app-server` session per issue in an isolated workspace, running turns on a single thread until the ticket leaves the active states, **crosses into a new phase**, or hits `max_turns` (bounded concurrency, continuation/backoff retries, reconcile),
- answers the agent's `linear_graphql` tool-calls and auto-approves its actions so an unattended run never stalls.

The **agent**, driven by `WORKFLOW.md` and the bundled skills, does everything else. The pipeline is **staged**: the ticket's status decides which phase the agent runs, and when it crosses a phase boundary the worker hands off to a *fresh* agent — so each stage is independent (QA isn't graded by the author). The single state-aware prompt is the state machine; the host just re-dispatches at the boundaries.

```
PLAN (Todo)         ─▶ BUILD (In Progress / QA blocked)        ─▶ QA (QA Requested)            ─▶ 🧍 human merge
scope + acceptance     implement + PR + stupify review loop        independent verification         (Ready to ship —
criteria, no code      ↺ rework on QA blocked                      PASS→Ready to ship                 NO automerge)
   → In Progress          → QA Requested                           FAIL→QA blocked / can't→hold
```

Each phase keeps one `## Codex Workpad` comment as the running source of truth. There is **no automerge** — the agent takes a ticket to `Ready to ship`; a human performs the merge.

## Configuration

Everything is in the front matter of `WORKFLOW.md`; the rest of the file is the agent's prompt. `$VAR` values resolve from the environment.

```yaml
tracker:
  kind: linear
  team: $LINEAR_TEAM                    # team key (e.g. BEV); or project_slug to scope to one project
  api_key: $LINEAR_API_KEY
  required_labels: [dark-factory]       # opt-in: only labelled tickets enter the factory
  active_states: [Todo, In Progress, Merging, Rework]
  terminal_states: [Done, Canceled, Closed, Duplicate]
hooks:
  after_create: gh repo clone "$REPO" .  # clones the target repo into each workspace
agent: { max_concurrent_agents: 4, max_turns: 20 }
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
```

The host reads Linear (to poll) and spawns codex; the agent performs all writes.

## Setup

**Prerequisites** (on the host or in the runner image): `bun` ≥ 1.3, `git`, `gh` (authenticated), `python3` (for the `land` watcher), and `codex` configured for the exe.dev gateway. `bunion doctor` checks them.

**Linear:**

- Add the workflow states named in `active_states` (`Todo`, `In Progress`, `Merging`, `Rework`) plus `Human Review`, under `Settings → Teams → <team> → Issue statuses`. The agent moves tickets through them.
- Create a personal API key (`Settings → Account → Security & Access → New API key`, `lin_api_…`) → `LINEAR_API_KEY`. (The host daemon needs a real key; an interactive Linear MCP connection does not carry over to it.)
- Scope the work: set `LINEAR_TEAM` to the team key (e.g. `BEV`) and add a `dark-factory` label to the tickets you want it to pick up. (Or set `LINEAR_PROJECT_SLUG` to scope to a single project instead.)

**Run:**

```bash
export LINEAR_API_KEY=lin_api_xxx
export LINEAR_TEAM=BEV            # team key; or LINEAR_PROJECT_SLUG to scope to one project
export REPO=owner/name           # used by the after_create clone hook

bun install
bunion doctor                    # tools + env + WORKFLOW.md load
bunion run BEV-1234              # one worker session, for testing
bunion start                     # the daemon
bunion status                    # issues per active state
```

Run one daemon per board.

## Phases and merging

Phases are config (`phases:` in `WORKFLOW.md`) mapping each phase to its Linear states; `active_states` decides which phases the factory works. The agent runs the phase its ticket is in and hands off at the boundary:

- **plan** (`Todo`) — scope the ticket, find the real owner, write acceptance criteria + a validation plan into the workpad. No product code. → `In Progress`.
- **build** (`In Progress`, `QA blocked`) — implement, open the PR, then the **code-review loop**: stupify auto-reviews every PR and the agent treats each actionable comment as blocking until fixed or pushed back on. → `QA Requested`.
- **qa** (`QA Requested`) — a fresh, independent agent reproduces the original bug, confirms the fix on the PR branch, checks each acceptance criterion, and runs the validation plan. `PASS` → `Ready to ship`; `FAIL` → `QA blocked`; can't actually verify (visual/UX) → leave it for a human with its findings.

There is **no automerge**. `Ready to ship` is deliberately not an active state — the agent stops there and a human performs the merge. The `land` skill is still shipped for repos that want agent-driven merging, but this pipeline does not invoke it. For a hard wall around sensitive paths, use GitHub branch protection / CODEOWNERS.

The agent has network access plus `gh` and `linear_graphql`, and Codex runs with `approval_policy: never` (the host auto-approves its command/file/tool requests). Suitable for trusted repos with team-authored tickets.

## Scaling across VMs

By default every agent runs on the machine hosting the daemon — the clone, the build, and Codex all compete for one box's CPU/RAM/disk, so a handful of concurrent tickets is the practical ceiling. To scale past that, point `worker.ssh_hosts` at a pool of VMs (the daemon also reads `BUNION_SSH_HOSTS=a,b,c`):

```yaml
worker:
  ssh_hosts: [vm-a, vm-b, vm-c]      # anything ssh accepts
  max_concurrent_agents_per_host: 1  # one disposable VM per ticket
```

Each ticket's workspace, clone, and `codex app-server` then run **on** the VM — the orchestrator stays central, drives Codex over the ssh stdio pipe, and answers `linear_graphql` itself, so the VMs need neither bunion nor any secret. A ticket is pinned to one VM for its whole life, so continuation turns reuse the same checkout and workpad. Because each agent is in its own disposable box, `danger-full-access` is contained rather than trusting the daemon host.

On [exe.dev](https://exe.dev) this composes cleanly: a VM's **github integration** clones the repo (no `gh` token) and its **exe-llm gateway** runs Codex against your ChatGPT/Codex plan (no API key), so a freshly provisioned VM is a ready worker with nothing to configure. Auto-provisioning VMs per-ticket is not built — you bring the pool.

## Layout

```
WORKFLOW.md              front matter (config) + the agent prompt
skills/                  copied into each workspace's .codex/skills/
  plan linear pull commit push qa land   (land includes land_watch.py)
src/
  cli.ts                 start | run | status | doctor
  config.ts              parse WORKFLOW.md front matter → typed config (+ $VAR)
  workflow.ts            split front matter/body; render the prompt (strict Liquid)
  linear.ts              tracker reads + the raw graphql() the tool uses
  codex/app-server.ts    the JSON-RPC app-server client (spawn, turns, tools, approvals)
  codex/dynamic-tool.ts  the linear_graphql host tool
  agent-runner.ts        one worker session: turns until done or max_turns
  workspace.ts           per-issue workspace, hooks, skill install (local or over ssh)
  ssh.ts                 run workspace ops + spawn codex on a worker VM
  orchestrator.ts        poll → dispatch → reconcile; state machine; retry/backoff; VM pool
```

## Not ported

The `Blocked`/operator-input-hold state (the host auto-approves instead) and per-state concurrency (`max_concurrent_agents_by_state` — only the global cap applies) are omitted, and VMs are a pool you provide rather than auto-provisioned per ticket. A single daemon is assumed (no distributed claim). The app-server protocol is pinned to the Codex build the host spawns.

## License

MIT.
