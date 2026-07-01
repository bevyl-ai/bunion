// Prefix characters below come from the orchestrator's own log-formatting convention (src/orchestrator.ts) and
// must stay in sync with it.
export type LogLineKind = 'turn' | 'op' | 'msg' | 'cmd' | 'tool' | 'edit' | 'plain'

export interface ParsedLogLine {
  kind: LogLineKind
  text: string // the line body (prefix stripped), NOT html-escaped — caller escapes at render time
}

export function parseLogLine(line: string): ParsedLogLine {
  const t = (line || '').replace(/^\n+/, '')
  if (t.startsWith('──')) return { kind: 'turn', text: t.replace(/─/g, '').trim() }
  if (t.startsWith('○ ')) return { kind: 'op', text: t.slice(2) }
  if (t.startsWith('● ')) return { kind: 'msg', text: t.slice(2) }
  if (t.startsWith('$ ')) return { kind: 'cmd', text: t.slice(2) }
  if (t.startsWith('⚙')) return { kind: 'tool', text: t }
  if (t.startsWith('✎')) return { kind: 'edit', text: t }
  return { kind: 'plain', text: t }
}
