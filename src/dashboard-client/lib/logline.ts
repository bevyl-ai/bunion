// Transcript-line classification, ported byte-faithfully from the old dashboard's `logHtml`. Exact prefix
// character codes come from the orchestrator's own log-formatting convention (src/orchestrator.ts) and must not
// change on this side.
export type LogLineKind = 'turn' | 'op' | 'msg' | 'cmd' | 'tool' | 'edit' | 'plain'

export interface ParsedLogLine {
  kind: LogLineKind
  text: string // the line body (prefix stripped), NOT html-escaped — caller escapes at render time
}

export function parseLogLine(line: string): ParsedLogLine {
  const t = (line || '').replace(/^\n+/, '')
  if (t.indexOf('──') === 0) return { kind: 'turn', text: t.replace(/─/g, '').trim() }
  if (t.indexOf('○ ') === 0) return { kind: 'op', text: t.slice(2) }
  if (t.indexOf('● ') === 0) return { kind: 'msg', text: t.slice(2) }
  if (t.indexOf('$ ') === 0) return { kind: 'cmd', text: t.slice(2) }
  if (t.indexOf('⚙') === 0) return { kind: 'tool', text: t }
  if (t.indexOf('✎') === 0) return { kind: 'edit', text: t }
  return { kind: 'plain', text: t }
}
