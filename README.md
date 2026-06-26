# bunion

A Bun/TS port of [OpenAI's Symphony](https://github.com/openai/symphony). A **thin harness** that drives Codex (via its app-server) to take a Linear ticket all the way to a merged PR. Point it at a repo + a Linear project; it polls, spawns a Codex agent per ticket, and the agent does the rest.

Runs Codex through the [exe.dev](https://exe.dev) gateway (your ChatGPT/Codex plan, no API keys).

## The shape: thin harness, fat agent

Symphony's insight — and the thing bunion gets right now — is that **the orchestrator is thin and the agent is fat.** bunion (the host) only:

- polls Linear for issues in the configured `active_states`,
- spawns one `codex app-server` session per issue in an isolated workspace, re-invoking while the ticket stays active (bounded concurrency, retry/backoff, reconcile),
- answers the agent's `linear_graphql` tool-calls and auto-approves its actions so an unattended run never stalls.

**The agent does everything else**, driven by `WORKFLOW.md` + the shipped skills: it moves the Linear state (`Todo → In Progress → Human Review → Merging → Done`), keeps one `## Codex Workpad` comment, opens the PR, runs the CI/review feedback sweep, and — on your approval (`Merging`) — runs the `land` skill to **squash-merge**. The state machine lives in the *prompt*, not in host code.

```
poll active_states ─▶ spawn codex app-server (per ticket) ─▶ agent drives Linear + git + gh ─▶ merge
   (host)                (host: 1 thread/issue,                  (Todo→In Progress→Human Review
                          turns until done/max_turns)             →Merging→Done; workpad; PR; land)
```

## Config is `WORKFLOW.md`

Everything is in the front matter of `WORKFLOW.md` (the rest of the file is the agent's prompt) — the same format as Symphony:

```yaml
tracker:
  kind: linear
  project_slug: $LINEAR_PROJECT_SLUG   # the project's slugId
  api_key: $LINEAR_API_KEY
  active_states: [Todo, In Progress, Merging, Rework]
  terminal_states: [Done, Canceled, Closed, Duplicate]
hooks:
  after_create: gh repo clone "$REPO" .   # clones the target repo into each workspace
agent: { max_concurrent_agents: 4, max_turns: 20 }
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
```

`$VAR` values resolve from the environment. The host reads Linear (to poll) and spawns codex; the agent does all writes.

## Setup

### 1. Prerequisites

On the host (or in your runner image): `bun` ≥ 1.3, `git`, `gh` (authenticated), `python3` (for the `land` watcher), and `codex` configured for the exe.dev gateway. `bunion doctor` checks them.

### 2. Linear

- **Workflow states** — `Settings → Teams → <team> → Issue statuses`. Add the states named in `active_states` (`Todo`, `In Progress`, `Merging`, `Rework`) plus `Human Review`; the agent moves tickets through them. Your board can have any others.
- **API key** — `Settings → Account → Security & Access → New API key` (`lin_api_…`). Set `LINEAR_API_KEY`.
- **Project slug** — the `slugId` from the project's URL. Set `LINEAR_PROJECT_SLUG`.

### 3. Env + run

```bash
export LINEAR_API_KEY=lin_api_xxx
export LINEAR_PROJECT_SLUG=your-project-slugid
export REPO=owner/name            # used by the after_create clone hook

bun install
bunion doctor                     # tools + env + WORKFLOW.md load
bunion run BEV-1234               # one worker session, for testing
bunion start                      # the daemon
bunion status                     # issues per active state
```

Run **one** daemon per board.

## How the agent merges

When you approve a ticket and move it to `Merging`, the agent opens `.codex/skills/land/SKILL.md` and runs the `land` loop: `land_watch.py` watches CI + Codex/human reviews and exits with a status code (0 = clear → squash-merge; 2 = review feedback; 3 = CI failed; 4 = head moved; 5 = conflicts), and the agent remediates and re-runs until it can `gh pr merge --squash`. The merge gate is downstream of *your* approval — nothing auto-merges without you moving the ticket to `Merging`.

## Security

Faithful Symphony: the agent has network + `gh` + `linear_graphql` and drives everything (this is the model you chose — your tickets are team-authored on your own repo). Codex runs `approval_policy: never` and bunion auto-approves its command/file/tool requests. If you want a hard wall around sensitive paths, use GitHub branch protection / CODEOWNERS — `Merging` is gated on your review, not on a code predicate.

## Layout

```
WORKFLOW.md           front matter (config) + the agent prompt
skills/               shipped into each workspace's .codex/skills/
  linear commit push pull land   (land has land_watch.py)
src/
  cli.ts              start | run | status | doctor
  config.ts           parse WORKFLOW.md front matter → typed config (+ $VAR)
  workflow.ts         split front matter/body; render the prompt (strict Liquid)
  linear.ts           tracker reads + the raw graphql() the tool uses
  codex/app-server.ts the JSON-RPC app-server client (spawn, turns, tools, approvals)
  codex/dynamic-tool.ts  the linear_graphql host tool
  agent-runner.ts     one worker session: turns until done/max_turns
  workspace.ts        per-issue workspace, hooks, skill install
  orchestrator.ts     poll → dispatch → reconcile, state machine, retry/backoff
```

### Faithful to Symphony, with these omissions (documented, not hidden)

The SSH worker pool, the `Blocked`/operator-input-hold state (bunion auto-approves instead), the observability dashboard, and per-state concurrency (`max_concurrent_agents_by_state` — only the global cap is honored) are not ported. Single-daemon assumed (no distributed claim). The app-server protocol is pinned to the Codex build it spawns.

MIT.
