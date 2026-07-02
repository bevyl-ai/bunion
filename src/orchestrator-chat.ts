import { homedir } from 'node:os'
import { chatPrompt } from './agent-runner'
import { AppServerSession } from './codex/app-server'
import { linearGraphqlTool, linearReadTool } from './codex/dynamic-tool'
import { phaseOf } from './config'
import { log } from './log'
import { remoteHome } from './ssh'
import type { Placement } from './orchestrator-placement'
import type { PersistedState } from './orchestrator-state'
import type { TrackerMirror } from './tracker-mirror'
import type { Config, DynamicTool, Issue, Role } from './types'

export type Chat = ReturnType<typeof createChat>

// An operator chat turn for a pool role — same read-only contract, framed as steering the role's standing focus.
function rolePrompt(role: Role, msg: string): string {
  return `The operator is messaging you, the "${role.name}" pool role — READ-ONLY: do not edit files, push, or change Linear; just answer using your thread's full context. If they are steering you (changing what you should focus on), acknowledge it; you will act on it on your next scheduled run. Operator:\n\n${msg}`
}

// Operator chat: idle-ticket + pool-role turns (a running ticket instead gets its dedicated turn from within its
// own live session — see drainOperatorMsgs() in agent-runner.ts's turn loop, fed by `drainPending` below).
export function createChat(
  getCfg: () => Config,
  state: PersistedState,
  placement: Placement,
  mirror: TrackerMirror,
  livePartial: Map<string, string>,
  isRoleRunning: (name: string) => boolean,
  isTicketRunning: (id: string) => boolean,
  getLastBoard: () => Issue[],
  roles: Role[],
) {
  const pendingChat = new Map<string, string[]>() // issueId → operator msgs queued while the agent was mid-turn; drained into its next dedicated chat turn
  const drainPending = (issueId: string): (() => string[]) => () => {
    const q = pendingChat.get(issueId) ?? []
    pendingChat.delete(issueId)
    return q
  }

  // One chat turn against a persisted thread (a ticket OR a pool role), used for the IDLE case — a running ticket's
  // chat turn instead reuses the agent's own live session since a second session on the same thread would collide.
  // Either way: resume the thread on its worker, run the operator's message as a real turn, append both sides to
  // the `logKey` transcript. `tools` decides how first-class the turn is: ticket chat gets the Linear tools so it
  // can ACT on steering (move the ticket's status + update the workpad) and narrate it; role chat gets none
  // (advisory — it acts on its next scheduled run). The file sandbox stays read-only either way, so chat never
  // edits code/pushes — the code work happens at the next dispatch (which resumes THIS thread). cwd is the worker
  // HOME, not the ticket workspace (handed-off workspaces get pruned; codex thread/resume loads context regardless of cwd).
  const chatTurn = async (logKey: string, threadId: string, host: string | null, displayMsg: string, prompt: string, label: string, tools: DynamicTool[]): Promise<{ ok: boolean; reply?: string; msg?: string }> => {
    const cwd = host ? remoteHome(host) : homedir()
    if (host && !cwd) return { ok: false, msg: 'cannot resolve the worker home' }
    let lg = state.logs.get(logKey)
    if (!lg) {
      lg = []
      state.logs.set(logKey, lg)
    }
    state.touchLog(logKey) // bump to MRU so the LRU cap doesn't evict this transcript mid-conversation on a busy board
    lg.push(`○ ${displayMsg}`) // operator turn — shows in the transcript immediately
    state.saveLogs()
    const replies: string[] = []
    const chat = new AppServerSession(getCfg(), tools, (e) => {
      if (e.stream != null) livePartial.set(logKey, e.stream)
      if (e.log && e.log.startsWith('● ')) { replies.push(e.log.slice(2)); livePartial.delete(logKey) }
    })
    try {
      await chat.start(cwd, host)
      await chat.resumeThread(threadId)
      await chat.runTurn(threadId, cwd, prompt, label, { type: 'readOnly' })
    } catch (e) {
      chat.stop()
      livePartial.delete(logKey)
      const m = e instanceof Error ? e.message : String(e)
      lg.push(`● (couldn't reach the agent: ${m})`)
      state.saveLogs()
      return { ok: false, msg: m }
    }
    chat.stop()
    livePartial.delete(logKey) // safety: clear any residual streaming partial (normally cleared on the committed ● event)
    const reply = replies.join('\n\n').trim() || '(no reply)'
    lg.push(`● ${reply}`)
    if (lg.length > 600) lg.splice(0, lg.length - 600)
    state.saveLogs()
    log(`chat: ${logKey} ←→ operator`)
    return { ok: true, reply }
  }

  // Operator chat. A pool-role name steers that role (it acts on its next scheduled run); otherwise it's a ticket —
  // idle tickets only, since a running agent owns the thread.
  const onChat = async (identifier: string, text: string): Promise<{ ok: boolean; reply?: string; msg?: string }> => {
    const msg = text.trim()
    if (!msg) return { ok: false, msg: 'empty message' }
    const role = roles.find((r) => r.name === identifier)
    if (role) {
      if (isRoleRunning(role.name)) return { ok: false, msg: 'the role is mid-run — message it once it is idle' }
      const rec = state.threadRecs.get(`role:${role.name}`)
      if (!rec?.threadId) return { ok: false, msg: 'no thread yet — this role has not run' }
      return chatTurn(role.name, rec.threadId, rec.host, msg, rolePrompt(role, msg), `${role.name}: operator chat`, []) // role chat stays advisory — no tools
    }
    const issue = getLastBoard().find((i) => i.identifier === identifier)
    if (!issue) return { ok: false, msg: 'ticket not on the board' }
    if (isTicketRunning(issue.id)) {
      // The agent owns the codex thread mid-turn — a concurrent chat turn would collide. Queue the message; the
      // SAME session gives it its own dedicated turn (chatPrompt, Linear tools, a real reply) the moment the
      // in-flight turn finishes and before the next work turn starts — see the drainOperatorMsgs() call in
      // agent-runner.ts's turn loop. Echo it to the transcript now so the operator sees it landed.
      const q = pendingChat.get(issue.id) ?? []
      q.push(msg)
      pendingChat.set(issue.id, q)
      const lg = state.logs.get(identifier) ?? (state.logs.set(identifier, []).get(identifier)!)
      lg.push(`○ ${msg}  ⟨the agent will reply once its current turn wraps up⟩`)
      state.saveLogs()
      return { ok: true, msg: 'queued — the agent will reply once its current turn wraps up' }
    }
    const rec = state.threadRecs.get(issue.id)
    if (!rec?.threadId) return { ok: false, msg: 'no thread yet — this ticket has not run' }
    // First-class ticket chat: give it the Linear tools so it can move state + update the workpad on the operator's steering.
    return chatTurn(identifier, rec.threadId, placement.placement.get(issue.id) ?? rec.host, msg, chatPrompt(msg), `${identifier}: operator chat`, [linearGraphqlTool(getCfg(), phaseOf(getCfg(), issue.state), undefined, mirror), linearReadTool(getCfg(), mirror)])
  }

  return { onChat, drainPending }
}
