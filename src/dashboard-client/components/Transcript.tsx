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

  // Only auto-scroll if the user was already near the bottom before this update landed — a line count change
  // that doesn't move the scroll position (e.g. content-only edits to the last line) must not force a scroll.
  useLayoutEffect(() => {
    const el = logRef.current
    if (!el) return
    const lineCountChanged = lines.length !== prevLen.current
    prevLen.current = lines.length
    const shouldScroll = live || chatPending || (lineCountChanged && wasAtBottomRef.current)
    if (shouldScroll) el.scrollTop = el.scrollHeight
  }, [lines, live, chatPending, logRef])

  const onScroll = (): void => {
    const el = logRef.current
    if (!el) return
    wasAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60
  }

  if (!loaded) {
    return (
      <div id="logbody" class="m-0 px-[18px] pt-1 pb-5 overflow-auto flex-1 text-[13px]/[1.5] font-['-apple-system',BlinkMacSystemFont,'Segoe_UI',Roboto,Helvetica,Arial,sans-serif]" ref={logRef} onScroll={onScroll}>
        <SkeletonLines />
      </div>
    )
  }

  return (
    <div id="logbody" class="m-0 px-[18px] pt-1 pb-5 overflow-auto flex-1 text-[13px]/[1.5] font-['-apple-system',BlinkMacSystemFont,'Segoe_UI',Roboto,Helvetica,Arial,sans-serif]" ref={logRef} onScroll={onScroll}>
      {lines.length === 0 && !chatPending && !live && <div class="p-0 text-mut">(no log yet)</div>}
      {lines.map((l, i) => (
        <LogLine key={i} line={l} />
      ))}
      {live && <LiveLine text={live} />}
      {chatPending && <TypingDots label="agent is responding…" />}
    </div>
  )
}
