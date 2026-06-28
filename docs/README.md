# bunion docs

Internal/operator documentation. The [top-level README](../README.md) is the user-facing overview;
[`WORKFLOW.md`](../WORKFLOW.md) is the agent's prompt + config; [`AGENTS.md`](../AGENTS.md) orients an agent
editing the codebase.

- **[architecture.md](architecture.md)** — how the host works: the poll loop, sessions/threads/handoff, the
  app-server client, token accounting, retry/backoff, deadlock detection, the VM pool, the role pool, and
  operator chat/actions.
- **[configuration.md](configuration.md)** — the complete `WORKFLOW.md` front-matter reference: every key, its
  default, and its env override.
- **[operations.md](operations.md)** — running the daemon, local vs the VM pool, provisioning workers, the
  dashboard, persisted state, and troubleshooting.
