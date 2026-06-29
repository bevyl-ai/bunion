import { AppServerSession } from './codex/app-server'
import { phaseOf, repoFor } from './config'
import { linearGraphqlTool, linearReadTool } from './codex/dynamic-tool'
import { fetchById, fetchWorkpad } from './linear'
import { log } from './log'
import { ensureWorkspace, installSkills, removeWorkspace, runHook } from './workspace'
import { renderPrompt } from './workflow'
import { CategorizedError } from './types'
import type { AgentEvent, Config, Issue } from './types'

export interface AgentOutcome {
  ok: boolean
  error?: string
  // §10.6 stable error code (CategorizedError.code) for orchestrator routing (setup failures vs transient)
  code?: string
}

export interface AgentHandle {
  done: Promise<AgentOutcome>
  stop(): void
}

function isActive(cfg: Config, state: string): boolean {
  const n = state.trim().toLowerCase()
  return cfg.tracker.activeStates.some((s) => s.trim().toLowerCase() === n)
}

function continuationPrompt(turn: number, maxTurns: number): string {
  return `Continuation guidance: the previous turn ended but the ticket is still in an active state, so work remains. This is continuation turn #${turn} of ${maxTurns}. Resume from the current workspace and workpad state; the thread already holds your prior instructions, so do not restate them. Keep advancing the workflow for this ticket and only stop when the ticket reaches a handoff state or you are truly blocked.`
}

// One worker session for an issue: prep workspace → run turns on a single app-server thread up to max_turns,
// refreshing the issue between turns and continuing while it stays active. The AGENT drives Linear/git/gh/merge.
// `host` null = run locally; else the workspace, clone, and codex all live on that ssh worker (an exe.dev VM).
export function startAgent(cfg: Config, issue: Issue, attempt: number | null, host: string | null, onEvent: (e: AgentEvent) => void, existingThreadId: string | null, getCachedIssue: (id: string) => Issue | null): AgentHandle {
  let session: AppServerSession | null = null
  let stopped = false

  const done = (async (): Promise<AgentOutcome> => {
    let dir = ''
    const repo = repoFor(cfg, issue.labels) // this ticket's repo (repo:<slug> label, else default) — drives the clone + .bunion-repo
    try {
      const ws = ensureWorkspace(cfg, issue.identifier, host)
      dir = ws.dir
      if (ws.created && cfg.hooks.afterCreate) {
        const h = runHook(cfg, dir, 'after_create', cfg.hooks.afterCreate, host, repo)
        if (!h.ok) {
          removeWorkspace(cfg, issue.identifier, host) // don't leave a half-made dir — the retry must re-create + re-clone
          return { ok: false, error: h.error }
        }
      }
      if (ws.created) installSkills(dir, host)
      if (cfg.hooks.beforeRun) {
        const h = runHook(cfg, dir, 'before_run', cfg.hooks.beforeRun, host, repo)
        if (!h.ok) return { ok: false, error: h.error }
      }
    } catch (e) {
      // A transient host failure during setup (unreachable VM, ssh hiccup) must fail this session cleanly so the
      // orchestrator retries it — never escape as an unhandled rejection that takes the whole daemon down.
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof CategorizedError ? e.code : undefined }
    }

    session = new AppServerSession(cfg, [linearGraphqlTool(cfg, phaseOf(cfg, issue.state)), linearReadTool(getCachedIssue)], onEvent)
    let current = issue
    try {
      await session.start(dir, host)
      // One thread per ticket: resume the prior phase's / operator-chat's thread so its full context carries into
      // this phase. Fall back to a fresh thread if resume fails (rollout gone, version skew) so a ticket is never
      // wedged by a bad resume.
      let threadId: string
      try {
        threadId = existingThreadId ? await session.resumeThread(existingThreadId) : await session.startThread(dir)
      } catch (e) {
        if (!existingThreadId) throw e
        log(`${issue.identifier}: thread resume failed (${e instanceof Error ? e.message : String(e)}); starting fresh`)
        threadId = await session.startThread(dir)
      }
      onEvent({ threadId }) // report the resolved id so the orchestrator persists it for the next phase + chat
      const startPhase = phaseOf(cfg, current.state)
      // Fetch the prior workpad ONCE and fold it into the dispatch prompt, so the agent starts with its notes instead
      // of spending turns + Linear reads pulling them back.
      const workpad = await fetchWorkpad(cfg, issue.id).catch(() => null)
      for (let turn = 1; ; turn++) {
        if (stopped) return { ok: false, error: 'terminated' }
        onEvent({ turn, log: `\n── turn ${turn} ──` })
        const prompt = turn === 1 ? renderPrompt(cfg.promptTemplate, { attempt, issue: current, workpad }) : continuationPrompt(turn, cfg.agent.maxTurns)
        await session.runTurn(threadId, dir, prompt, `${current.identifier}: ${current.title}`)
        current = await fetchById(cfg, issue.id)
        if (!isActive(cfg, current.state)) break // handed off to a downstream state — this worker is done
        if (phaseOf(cfg, current.state) !== startPhase) break // crossed into a new phase — a FRESH agent runs it
        if (turn >= cfg.agent.maxTurns) break // graceful cap; the orchestrator may dispatch a fresh worker
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof CategorizedError ? e.code : undefined }
    } finally {
      session.stop()
      if (cfg.hooks.afterRun) {
        const h = runHook(cfg, dir, 'after_run', cfg.hooks.afterRun, host, repo)
        if (!h.ok) log(`warn: ${h.error}`)
      }
    }
  })()

  return {
    done,
    stop() {
      stopped = true
      session?.stop()
    },
  }
}
