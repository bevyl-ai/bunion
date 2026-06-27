import { AppServerSession } from './codex/app-server'
import { linearGraphqlTool } from './codex/dynamic-tool'
import { fetchById } from './linear'
import { log } from './log'
import { ensureWorkspace, installSkills, removeWorkspace, runHook } from './workspace'
import { renderPrompt } from './workflow'
import type { Config, Issue } from './types'

export interface AgentOutcome {
  ok: boolean
  error?: string
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
export function startAgent(cfg: Config, issue: Issue, attempt: number | null, onEvent: (e: { turn?: number; label?: string }) => void): AgentHandle {
  let session: AppServerSession | null = null
  let stopped = false

  const done = (async (): Promise<AgentOutcome> => {
    const { dir, created } = ensureWorkspace(cfg, issue.identifier)
    if (created && cfg.hooks.afterCreate) {
      const h = runHook(cfg, dir, 'after_create', cfg.hooks.afterCreate)
      if (!h.ok) {
        removeWorkspace(cfg, issue.identifier) // don't leave a half-made dir — the retry must re-create + re-clone
        return { ok: false, error: h.error }
      }
    }
    if (created) installSkills(dir)
    if (cfg.hooks.beforeRun) {
      const h = runHook(cfg, dir, 'before_run', cfg.hooks.beforeRun)
      if (!h.ok) return { ok: false, error: h.error }
    }

    session = new AppServerSession(cfg, [linearGraphqlTool(cfg)], onEvent)
    let current = issue
    try {
      await session.start(dir)
      const threadId = await session.startThread(dir)
      for (let turn = 1; ; turn++) {
        if (stopped) return { ok: false, error: 'terminated' }
        onEvent({ turn })
        const prompt = turn === 1 ? renderPrompt(cfg.promptTemplate, { attempt, issue: current }) : continuationPrompt(turn, cfg.agent.maxTurns)
        await session.runTurn(threadId, dir, prompt, `${current.identifier}: ${current.title}`)
        current = await fetchById(cfg, issue.id)
        if (!isActive(cfg, current.state)) break // handed off to a downstream state — this worker is done
        if (turn >= cfg.agent.maxTurns) break // graceful cap; the orchestrator may dispatch a fresh worker
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      session.stop()
      if (cfg.hooks.afterRun) {
        const h = runHook(cfg, dir, 'after_run', cfg.hooks.afterRun)
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
