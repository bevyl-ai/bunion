import type { ActionDef, BoardColumn, BoardItem } from './types'

const A_REWORK: ActionDef = { a: 'to-build', l: 'Back to coding', c: '', t: 'Move to In Progress so the agent resumes the thread, revises the code, and updates the PR' }
// The escape hatch: pull any live ticket off the board. Moves it to Canceled in Linear (which fetchBoard excludes),
// stops any running agent, and wipes the workspace. Offered on every non-terminal ticket.
const A_CANCEL: ActionDef = { a: 'cancel', l: 'Cancel ticket', c: 'danger', t: 'Move the ticket to Canceled in Linear, stop any running agent, wipe its workspace, and drop it off the board' }

export function actionList(it: BoardItem | null | undefined): ActionDef[] {
  if (!it || it.state === 'Done') return []
  if (it.status === 'running')
    return [{ a: 'restart', l: 'Restart this agent', c: 'danger', t: 'Stop the current agent, wipe its workspace, and restart the ticket from scratch on a fresh thread' }, A_REWORK, A_CANCEL]
  if (it.state === 'Needs Engineer')
    return [
      { a: 'bump', l: 'Bump budget & reopen', c: 'go', t: 'Grant another token budget on top of the cap and re-open to In Progress (use for a ticket parked by the token cap)' },
      { a: 'to-qa', l: 'Back to QA', c: 'go', t: 'Send back to QA Testing so the agent re-verifies' },
      A_REWORK,
      A_CANCEL,
    ]
  if (it.state === 'STG - Ready to merge') return [{ a: 'to-qa', l: 'Re-verify', c: 'go', t: 'Send back to QA Testing for the agent to re-verify before shipping' }, A_REWORK, A_CANCEL]
  return [{ a: 'to-qa', l: 'Send to QA', c: 'go', t: 'Move to QA Testing so the agent verifies the work' }, A_REWORK, A_CANCEL]
}

export function colIdx(cols: BoardColumn[], st: string | null | undefined): number {
  const l = (st || '').trim().toLowerCase()
  return cols.findIndex((col) => col.states.some((s) => s.toLowerCase() === l))
}

// One "-> ColumnName" move per board column except the ticket's current column and the human-owned "QA Requested"
// lane (Anya/Julia's manual QA tracking — WORKFLOW.md bans the agent from writing there).
export function moveItems(cols: BoardColumn[], it: BoardItem | null | undefined): ActionDef[] {
  if (!it) return []
  const cur = colIdx(cols, it.state)
  const out: ActionDef[] = []
  cols.forEach((col, i) => {
    if (i === cur) return
    if (col.name === 'QA Requested') return
    out.push({ a: 'move:' + col.states[0], l: '→ ' + col.name, c: '', t: 'Move this ticket to ' + col.name })
  })
  return out
}

export const DANGER_CONFIRM: Record<string, string> = {
  restart: "Permanently wipe this ticket's workspace and thread history — ALL context is lost and cannot be recovered. Continue?",
  cancel:
    'Cancel this ticket? It moves to Canceled in Linear, stops any running agent, wipes its workspace, and drops off the board. The Linear ticket itself stays — you can reopen it there. Continue?',
  'move:Done':
    'Mark this ticket Done directly? This does NOT merge or deploy anything — it only changes the label, and dashboards/stats will count it as shipped even though nothing actually happened. Only do this if you verified it shipped some other way.',
  'move:STG - Merged':
    'Mark this ticket merged/in-staging directly? This does NOT actually merge the PR — it only changes the label, and stats will count it as shipped even though nothing happened on GitHub. Continue only if you already merged it yourself.',
  'move:Verifying in Prod': 'Mark this ticket live in production directly? This does NOT deploy anything — it only changes the label. Continue only if you know it is genuinely live.',
}
