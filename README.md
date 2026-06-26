# bunion

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony): a thin harness that drives Codex (via its app-server) to take a Linear ticket all the way to a merged PR. Point it at a repo and a Linear project; it polls, spawns a Codex agent per ticket, and the agent does the work.

Codex runs through the [exe.dev](https://exe.dev) gateway, so it uses your ChatGPT/Codex plan rather than metered API tokens.

## How it works

The orchestrator is thin and the agent is fat.

The **host** does three things:

- polls Linear for issues in the configured `active_states`,
- spawns one `codex app-server` session per issue in an isolated workspace, running turns on a single thread until the ticket leaves the active states or hits `max_turns` (bounded concurrency, continuation/backoff retries, reconcile),
- answers the agent's `linear_graphql` tool-calls and auto-approves its actions so an unattended run never stalls.

The **agent**, driven by `WORKFLOW.md` and the bundled skills, does everything else: it moves the ticket through the Linear workflow (`Todo → In Progress → Human Review → Merging → Done`), maintains one `## Codex Workpad` comment, opens the PR, runs the CI/review feedback sweep, and — once a human moves the ticket to `Merging` — runs the `land` skill to squash-merge. The state machine lives in the prompt, not in host code.

```
poll active_states ─▶ spawn codex app-server (per ticket) ─▶ agent drives Linear + git + gh ─▶ merge
   (host)                (1 thread/issue, turns                (Todo→In Progress→Human Review
                          until done or max_turns)              →Merging→Done; workpad; PR; land)
```

## Configuration

Everything is in the front matter of `WORKFLOW.md`; the rest of the file is the agent's prompt. `$VAR` values resolve from the environment.

```yaml
tracker:
  kind: linear
  project_slug: $LINEAR_PROJECT_SLUG    # the project's slugId
  api_key: $LINEAR_API_KEY
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
- Create a personal API key (`Settings → Account → Security & Access → New API key`, `lin_api_…`) → `LINEAR_API_KEY`.
- Find the project's `slugId` (from its URL) → `LINEAR_PROJECT_SLUG`.

**Run:**

```bash
export LINEAR_API_KEY=lin_api_xxx
export LINEAR_PROJECT_SLUG=your-project-slugid
export REPO=owner/name           # used by the after_create clone hook

bun install
bunion doctor                    # tools + env + WORKFLOW.md load
bunion run BEV-1234              # one worker session, for testing
bunion start                     # the daemon
bunion status                    # issues per active state
```

Run one daemon per board.

## Merging

When a ticket reaches `Merging`, the agent runs the `land` loop: `land_watch.py` watches CI and Codex/human reviews and exits with a status code (`0` clear → squash-merge, `2` review feedback, `3` CI failed, `4` head moved, `5` conflicts); the agent remediates and re-runs until it can `gh pr merge --squash`. Nothing merges until a human moves the ticket to `Merging` — the merge gate is that state transition, not a code predicate. For a hard wall around sensitive paths, use GitHub branch protection / CODEOWNERS.

The agent has network access plus `gh` and `linear_graphql`, and Codex runs with `approval_policy: never` (the host auto-approves its command/file/tool requests). Suitable for trusted repos with team-authored tickets.

## Layout

```
WORKFLOW.md              front matter (config) + the agent prompt
skills/                  copied into each workspace's .codex/skills/
  linear commit push pull land   (land includes land_watch.py)
src/
  cli.ts                 start | run | status | doctor
  config.ts              parse WORKFLOW.md front matter → typed config (+ $VAR)
  workflow.ts            split front matter/body; render the prompt (strict Liquid)
  linear.ts              tracker reads + the raw graphql() the tool uses
  codex/app-server.ts    the JSON-RPC app-server client (spawn, turns, tools, approvals)
  codex/dynamic-tool.ts  the linear_graphql host tool
  agent-runner.ts        one worker session: turns until done or max_turns
  workspace.ts           per-issue workspace, hooks, skill install
  orchestrator.ts        poll → dispatch → reconcile; state machine; retry/backoff
```

## Not ported

The SSH worker pool, the `Blocked`/operator-input-hold state (the host auto-approves instead), the observability dashboard, and per-state concurrency (`max_concurrent_agents_by_state` — only the global cap applies) are omitted. A single daemon is assumed (no distributed claim). The app-server protocol is pinned to the Codex build the host spawns.

## License

MIT.
