import { AppServerSession } from './codex/app-server'
import { linearGraphqlTool } from './codex/dynamic-tool'
import { log } from './log'
import { ensureWorkspace, installSkills, removeWorkspace, runHook } from './workspace'
import type { AgentEvent, Config, Role, RoleQuota } from './types'

export interface RoleHandle {
  done: Promise<{ ok: boolean; error?: string }>
  stop(): void
}

// One run of a pool role: prep a workspace on the worker, then run a SINGLE standing-mission turn on a persistent
// thread — resuming the role's prior thread so it remembers what it filed last time. The role drives Linear (file/tag
// tickets) through the same dynamic tool the pipeline uses; the resume falls back to a fresh thread if it fails so a
// role is never wedged. The orchestrator schedules the next run on the role's cadence.
export function startRole(cfg: Config, role: Role, host: string | null, onEvent: (e: AgentEvent) => void, existingThreadId: string | null, quota: RoleQuota): RoleHandle {
  let session: AppServerSession | null = null
  let stopped = false
  const wsKey = `role-${role.name}`

  const done = (async (): Promise<{ ok: boolean; error?: string }> => {
    let dir = ''
    try {
      const ws = ensureWorkspace(cfg, wsKey, host)
      dir = ws.dir
      if (ws.created && cfg.hooks.afterCreate) {
        const h = runHook(cfg, dir, 'after_create', cfg.hooks.afterCreate, host)
        if (!h.ok) {
          removeWorkspace(cfg, wsKey, host)
          return { ok: false, error: h.error }
        }
      }
      if (ws.created) installSkills(dir, host)
      if (cfg.hooks.beforeRun) {
        const h = runHook(cfg, dir, 'before_run', cfg.hooks.beforeRun, host)
        if (!h.ok) return { ok: false, error: h.error }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    session = new AppServerSession(cfg, [linearGraphqlTool(cfg, role.name, quota)], onEvent)
    try {
      await session.start(dir, host)
      let threadId: string
      try {
        threadId = existingThreadId ? await session.resumeThread(existingThreadId) : await session.startThread(dir)
      } catch (e) {
        if (!existingThreadId) throw e
        log(`role ${role.name}: thread resume failed (${e instanceof Error ? e.message : String(e)}); starting fresh`)
        threadId = await session.startThread(dir)
      }
      onEvent({ threadId })
      if (stopped) return { ok: false, error: 'terminated' }
      onEvent({ log: '\n── run ──' })
      await session.runTurn(threadId, dir, budgetNote(role, quota) + role.prompt, `role:${role.name}`, undefined, role.model)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      session.stop()
      if (cfg.hooks.afterRun) {
        const h = runHook(cfg, dir, 'after_run', cfg.hooks.afterRun, host)
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

// A per-run preface telling the role its remaining daily ticket budget, so it self-limits gracefully (the tool also
// enforces it hard). Empty when the role has no cap.
function budgetNote(role: Role, quota: RoleQuota): string {
  if (quota.limit == null) return ''
  const rem = quota.remaining()
  return rem <= 0
    ? `Daily ticket budget: you have hit today's limit of ${quota.limit} new tickets — file NOTHING this run. Briefly report what you found, then stop.\n\n`
    : `Daily ticket budget: you may file at most ${rem} new ticket${rem === 1 ? '' : 's'} today (cap ${quota.limit}/day). Spend it on the highest-value items only; if nothing clears that bar, file fewer or none. The host enforces this cap.\n\n`
}
