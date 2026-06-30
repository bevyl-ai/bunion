# Operations

Running, scaling, observing, and troubleshooting the daemon. For the README's quickstart see
[Setup](../README.md#setup); this is the operator's reference.

## Running

```bash
bun src/cli.ts doctor      # preflight: tools (bun/git/gh/codex/python3) + env + WORKFLOW.md loads
bun src/cli.ts status      # issues per active state — the board, no side effects
bun src/cli.ts run BEV-123 # one worker session for a ticket, foreground (testing a single ticket)
bun run start              # the daemon — run one per board
```

Required env: `LINEAR_API_KEY`, scope (`LINEAR_TEAM` or `LINEAR_PROJECT_SLUG`), and `REPO` (used by the
`after_create` clone hook). Optional: `LINEAR_APP_TOKEN` (agent posts as the app), `BUNION_SSH_HOSTS`,
`BUNION_PORT`.

## Local vs the VM pool

- **Local** (no `worker.ssh_hosts`): the workspace, clone, and codex all run on the daemon host. A handful of
  concurrent tickets is the practical ceiling — they compete for one box's CPU/RAM/disk.
- **VM pool**: set `worker.ssh_hosts` (or `BUNION_SSH_HOSTS=a,b,c`). Each ticket's workspace + clone + codex run
  **on** a VM over the ssh stdio pipe; the orchestrator stays central and answers `linear_graphql` itself, so
  the VMs need neither bunion nor any secret. A ticket is pinned to one VM for its life. `danger-full-access` is
  contained per disposable box rather than trusting the daemon host. See
  [architecture › worker placement](architecture.md#worker-placement-the-vm-pool).

## Provisioning workers (exe.dev)

The [`provisioning/`](../provisioning) scripts turn a fresh exe.dev VM into a ready worker — bring the pool;
per-ticket auto-provisioning is not built.

- **[`vm-setup.sh`](../provisioning/vm-setup.sh)** — first-boot setup. Keyless codex via the exe-llm gateway
  (high reasoning effort), github clones routed through the integration proxy (no `gh` token), `gh` pointed at
  the proxy, the bun toolchain, headless chromium for QA, and the agents' shell env. Run as the VM's setup
  script:
  ```bash
  ssh exe.dev new --name bunion-bevyl-N --integration bevyl-web --json --setup-script /dev/stdin < provisioning/vm-setup.sh
  ssh exe.dev integrations attach llm vm:bunion-bevyl-N
  ```
- **[`setup-template.sh`](../provisioning/setup-template.sh)** — build/refresh the per-VM template
  (`$HOME/.bunion/repo`: a full clone + installed deps) that per-ticket workspaces are cheap git **worktrees**
  off of. Slow on first run; re-run to refresh `main` + deps. The `after_create` hook degrades to a plain clone
  when no template is present.
  ```bash
  REPO=owner/name ssh bunion-bevyl-N.exe.xyz 'bash -lc bash' < provisioning/setup-template.sh
  ```
- **[`linear-oauth-setup.ts`](../provisioning/linear-oauth-setup.ts)** — one-time Linear OAuth `actor=app`
  authorization so the agent posts under its own app identity (per-phase names via `createAsUser`). Needs
  `LINEAR_OAUTH_CLIENT_ID`/`LINEAR_OAUTH_CLIENT_SECRET`; prints an authorize URL, catches the callback on
  `localhost:4321`, and appends `LINEAR_APP_TOKEN` to `~/.bevyl/.env`.

## The dashboard

Set `server.port` (or `BUNION_PORT`) to serve a live status page. Routes ([`dashboard.ts`](../src/dashboard.ts)):

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | the self-contained page: kanban by pipeline stage, per-run log modal, the pool dock |
| `/state.json` | GET | the live orchestrator snapshot (`Snapshot`) — the page polls it |
| `/transcript/<id>` | GET | one ticket/role's recent log lines |
| `/action` | POST | `{ id, action }` — `to-qa` · `to-build` · `move:<state>` · `restart` (idle tickets) |
| `/chat` | POST | `{ id, text }` — one read-only operator turn on the ticket's thread (idle tickets) |

Operator chat and actions only apply to an **idle** ticket — a running agent owns the thread. See
[architecture › operator chat & actions](architecture.md#operator-chat--actions).

## Persisted state

Under `~/.bunion/` on the daemon host (best-effort writes, debounced ~3s):

| File | Contents |
|---|---|
| `threads.json` | issue.id / `role:<name>` → `{ threadId, host }` — the persistent codex thread per ticket/role |
| `tokens.json` | identifier → phase → `TokenCounts` — per-ticket/phase token tally |
| `logs.json` | identifier → recent log lines — so handed-off tickets keep their log across restarts |
| `workspaces/` | local per-ticket checkouts (when running locally) |

On the VMs, workspaces live at `~/.bunion/workspaces/<key>` and are swept every 20 min when unpinned + stale.
codex rollouts live in each worker's `~/.codex` — which is why a thread resumes on the worker that holds it.

## Reviewing agent activity

[`scripts/logs.mjs`](../scripts/logs.mjs) reads the running dashboard (`BUNION_URL`, default
`http://localhost:4319`) to surface where agents hit **friction** — the failure/retry/workaround signals that
compound into slowdowns — across live tickets, or to dump/tail one ticket's log.

## Troubleshooting

- **A ticket loops without progressing** → the deadlock sweep auto-moves it to `QA blocked` (then `Needs Engineer`
  on a repeat) with an explanatory comment. Tune the `deadlock.*` knobs if it trips too eagerly/late.
- **`thread resume failed … starting fresh` in the logs** → the rollout was gone or codex skewed; the session
  recovered with a fresh thread (it loses prior in-thread context, not the workpad). Expected after a codex
  upgrade or a wiped VM.
- **Workers filling up / out of disk** → workspaces are ~5–6 GB each; confirm the 20-min prune is running
  (`workspace prune swept N VM(s)` in the logs) and that tickets are being released (terminal/ineligible).
- **`cannot resolve $HOME on <host>`** → the VM is unreachable over ssh, or an ssh diagnostic corrupted the
  capture. `remoteHome` reads stdout only; check `ssh <host> printf %s "$HOME"` by hand.
- **`read_timeout` / handshake failures on a busy VM** → raise `codex.read_timeout_ms` (the 5 s default is tight
  under shared-CPU load; `WORKFLOW.md` uses 15 s).
- **Agent can't push / git write errors** → the turn sandbox must be full-access (codex `workspace-write`
  write-protects `.git`); check `codex.thread_sandbox` / `turn_sandbox_policy`.
