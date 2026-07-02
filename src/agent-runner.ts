import { AppServerSession } from './codex/app-server'
import { phaseOf, repoFor } from './config'
import { linearGraphqlTool, linearReadTool } from './codex/dynamic-tool'
import type { GithubMirror } from './github-mirror'
import type { TrackerMirror } from './tracker-mirror'
import { opsReadTool } from './codex/ops-tool'
import { waitTool } from './codex/wait-tool'
import { fetchById, fetchWorkpad, workpadFromComments } from './linear'
import { log } from './log'
import { configureGitBot, ensureWorkspace, installSkills, removeWorkspace, runHook } from './workspace'
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

// Symphony §6.2/§7.1: a continuation turn sends only continuation guidance to the existing thread — NOT the
// original task prompt, which is already present in thread history. (An earlier version of this re-rendered the
// full prompt every turn, theorizing stale turn-1 memory explained agents drifting to a renamed Linear state; the
// real Linear issue history refuted that — e.g. BEV-4017 used the correct state name twice in the SAME thread,
// then drifted 4 minutes later, which isn't consistent with "stuck on turn-1 memory." Reverted to match spec.)
function continuationPrompt(turn: number, maxTurns: number, state: string): string {
  return `Continuation — turn #${turn} of ${maxTurns}, same thread, same ticket. The ticket is now in \`${state}\`, so work the stage that matches that status from your original instructions. Resume from the workspace + workpad and what you've already done — don't restate or redo finished work. Keep carrying the ticket forward through its stages; stop only when it reaches a handoff state (STG - Ready to merge / Needs Engineer) or you're truly blocked.`
}

// An operator chat turn: read-only, answer from the thread's own context. Terse so it doesn't crowd the history.
// Shared by the idle-ticket chat path (orchestrator.ts's chatTurn, a fresh session) and the mid-run path below
// (same session, same thread, run as its own turn between continuation turns) — one prompt, one contract either way.
export function chatPrompt(msg: string): string {
  return `The operator is messaging you directly about this ticket, with this thread's full context. You can ACT on their steering through Linear via \`linear_graphql\`: update the \`## Codex Workpad\` and move the ticket's status. Narrate what you do plainly (e.g. "ok — recording the simpler plan in the workpad and moving this to In Progress so the build picks it up"). When their steering means the code should change, capture the concrete change in the workpad and move the ticket to \`In Progress\` — do this even if it is parked in STG - Ready to merge / QA - blocked, because that re-enters it into the pipeline and the build agent resumes THIS thread to make the edits. Do NOT edit files, run commands, or push in this turn — only Linear. If the operator is just asking a question, answer it and change nothing. Operator:\n\n${msg}`
}

// One worker session for an issue: prep workspace → run turns on a single app-server thread up to max_turns,
// refreshing the issue between turns and continuing while it stays active. The AGENT drives Linear/git/gh/merge.
// `host` null = run locally; else the workspace, clone, and codex all live on that ssh worker (an exe.dev VM).
// The brain's two local mirrors — tracker (Linear) and GitHub — threaded to the agent's host tools together.
export interface Mirrors {
  tracker: TrackerMirror
  github: GithubMirror
}

export function startAgent(cfg: Config, issue: Issue, attempt: number | null, host: string | null, onEvent: (e: AgentEvent) => void, existingThreadId: string | null, mirrors: Mirrors, drainOperatorMsgs: () => string[]): AgentHandle {
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
      if (ws.created) configureGitBot(cfg, dir, host) // author commits + auth pushes as the factory bot (local mode; no-op unless a github app is configured)
      if (cfg.hooks.beforeRun) {
        const h = runHook(cfg, dir, 'before_run', cfg.hooks.beforeRun, host, repo)
        if (!h.ok) return { ok: false, error: h.error }
      }
    } catch (e) {
      // A transient host failure during setup (unreachable VM, ssh hiccup) must fail this session cleanly so the
      // orchestrator retries it — never escape as an unhandled rejection that takes the whole daemon down.
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: e instanceof CategorizedError ? e.code : undefined }
    }

    session = new AppServerSession(cfg, [linearGraphqlTool(cfg, phaseOf(cfg, issue.state), undefined, mirrors.tracker), linearReadTool(cfg, mirrors.tracker), waitTool(cfg, host, dir, repo, mirrors.github, onEvent), opsReadTool()], onEvent)
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
      // Mirror-first; the hydrated thread is capped at 100 recent comments, and the workpad is an OLD comment
      // (edited in place, early createdAt) — so a full-length thread may have pushed it out of the window. Only
      // trust a mirror miss when the thread is short enough to be complete.
      const thread = mirrors.tracker.getComments(issue.id)
      const cachedWorkpad = thread ? workpadFromComments(thread.map((c) => c.body)) : null
      const workpad = cachedWorkpad ?? (thread && thread.length < 100 ? null : await fetchWorkpad(cfg, issue.id).catch(() => null))
      for (let turn = 1; ; turn++) {
        if (stopped) return { ok: false, error: 'terminated' }
        // Operator messages sent live while this agent was mid-turn get their OWN dedicated turn here — same
        // session/thread (no collision, since this loop only ever has one turn in flight), same Linear tools, a
        // real reply — not smushed into the next continuation prompt as an addendum. Doesn't count against maxTurns.
        const pending = drainOperatorMsgs()
        if (pending.length) {
          onEvent({ log: '\n── operator chat ──' })
          await session.runTurn(threadId, dir, chatPrompt(pending.join('\n\n')), `${current.identifier}: operator chat`, { type: 'readOnly' })
          current = await fetchById(cfg, issue.id) // the chat turn may have moved state via linear_graphql
          if (!isActive(cfg, current.state)) break // operator steering handed it off directly
        }
        onEvent({ turn, log: `\n── turn ${turn} ──` })
        const base = turn === 1 ? renderPrompt(cfg.promptTemplate, { attempt, issue: current, workpad }) : continuationPrompt(turn, cfg.agent.maxTurns, current.state)
        await session.runTurn(threadId, dir, base, `${current.identifier}: ${current.title}`)
        // Deliberately a LIVE fetch, not mirrors.tracker.getIssue(): the mirror's issue cache only refreshes on the
        // ~30s poll delta and mutation write-back never touches it (applyMutation only updates comments), so it
        // could easily miss the state change THIS turn's own linear_graphql call just made — and the loop-exit
        // check right below depends on seeing that change immediately, not up to 30s late.
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
