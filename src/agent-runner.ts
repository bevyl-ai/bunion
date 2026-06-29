import { AppServerSession } from './codex/app-server'
import { phaseOf, repoFor } from './config'
import { linearGraphqlTool, linearReadTool } from './codex/dynamic-tool'
import { waitTool } from './codex/wait-tool'
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

function continuationPrompt(turn: number, maxTurns: number, state: string): string {
  return `Continuation — turn #${turn} of ${maxTurns}, same thread, same ticket. The ticket is now in \`${state}\`, so work the stage that matches that status from your original instructions. Resume from the workspace + workpad and what you've already done — don't restate or redo finished work. Keep carrying the ticket forward through its stages; stop only when it reaches a handoff state (STG - Ready to merge / Needs Engineer) or you're truly blocked.`
}

// One worker session for an issue: prep workspace → run turns on a single app-server thread up to max_turns,
// refreshing the issue between turns and continuing while it stays active. The AGENT drives Linear/git/gh/merge.
// `host` null = run locally; else the workspace, clone, and codex all live on that ssh worker (an exe.dev VM).
export function startAgent(cfg: Config, issue: Issue, attempt: number | null, host: string | null, onEvent: (e: AgentEvent) => void, existingThreadId: string | null, getCachedIssue: (id: string) => Issue | null, drainOperatorMsgs: () => string[]): AgentHandle {
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

    session = new AppServerSession(cfg, [linearGraphqlTool(cfg, phaseOf(cfg, issue.state)), linearReadTool(getCachedIssue), waitTool(host, dir, onEvent)], onEvent)
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
      onEvent({ threadId }) // report the resolved id so the orchestrator persists it for the next session + chat
      // Fetch the prior workpad ONCE and fold it into the dispatch prompt, so the agent starts with its notes instead
      // of spending turns + Linear reads pulling them back.
      const workpad = await fetchWorkpad(cfg, issue.id).catch(() => null)
      for (let turn = 1; ; turn++) {
        if (stopped) return { ok: false, error: 'terminated' }
        onEvent({ turn, log: `\n── turn ${turn} ──` })
        const base = turn === 1 ? renderPrompt(cfg.promptTemplate, { attempt, issue: current, workpad }) : continuationPrompt(turn, cfg.agent.maxTurns, current.state)
        const pending = drainOperatorMsgs() // operator messages queued via chat while this agent was mid-turn
        const prompt = pending.length ? `${base}\n\n## Operator messages — sent live while you were working; address these now\n${pending.map((m) => `- ${m}`).join('\n')}` : base
        await session.runTurn(threadId, dir, prompt, `${current.identifier}: ${current.title}`)
        current = await fetchById(cfg, issue.id)
        if (!isActive(cfg, current.state)) break // reached a handoff state (STG - Ready to merge / Needs Engineer / Done) — this ticket is done
        if (turn >= cfg.agent.maxTurns) break // graceful per-session cap; the orchestrator resumes this same thread next poll if the ticket is still active
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
