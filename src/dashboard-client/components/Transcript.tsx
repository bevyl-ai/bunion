import { useLayoutEffect, useRef } from 'preact/hooks'
import { LiveLine, LogLine, SkeletonLines, TypingDots } from './LogLine'

export function Transcript({
  logRef,
  lines,
  live,
  loaded,
  chatPending,
}: {
  logRef: { current: HTMLDivElement | null }
  lines: string[]
  live: string
  loaded: boolean
  chatPending: boolean
}) {
  const wasAtBottomRef = useRef(true)
  const prevLen = useRef(-1)

  // Item 43: only auto-scroll to bottom if the user was already near the bottom before this update landed.
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el) return
    const changed = lines.length !== prevLen.current
    prevLen.current = lines.length
    if (changed || live || chatPending) {
      if (wasAtBottomRef.current || chatPending || live) el.scrollTop = el.scrollHeight
    }
  }, [lines, live, chatPending, logRef])

  const onScroll = (): void => {
    const el = logRef.current
    if (!el) return
    wasAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60
  }

  if (!loaded) {
    return (
      <div id="logbody" ref={logRef} onScroll={onScroll}>
        <SkeletonLines />
      </div>
    )
  }

  return (
    <div id="logbody" ref={logRef} onScroll={onScroll}>
      {lines.length === 0 && !chatPending && !live && <div class="lg" style={{ color: 'var(--mut)' }}>(no log yet)</div>}
      {lines.map((l, i) => (
        <LogLine key={i} line={l} />
      ))}
      {live && <LiveLine text={live} />}
      {chatPending && <TypingDots label="agent is responding…" />}
    </div>
  )
}
