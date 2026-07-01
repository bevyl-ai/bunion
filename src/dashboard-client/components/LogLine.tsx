import { parseLogLine } from '../lib/logline'

export function LogLine({ line }: { line: string }) {
  const { kind, text } = parseLogLine(line)
  switch (kind) {
    case 'turn':
      return <div class="lg lg-turn">{text}</div>
    case 'op':
      return (
        <div class="lg lg-op">
          <b>you</b>
          {text}
        </div>
      )
    case 'msg':
      return <div class="lg lg-msg">{text}</div>
    case 'cmd':
      return (
        <div class="lg lg-cmd" title={text}>
          <b>$</b>
          {text}
        </div>
      )
    case 'tool':
      return <div class="lg lg-tool">{text}</div>
    case 'edit':
      return <div class="lg lg-edit">{text}</div>
    default:
      return <div class="lg lg-cmd">{text}</div>
  }
}

export function LiveLine({ text }: { text: string }) {
  return (
    <div class="lg lg-live">
      {text}
      <span class="lg-cur" />
    </div>
  )
}

export function TypingDots({ label }: { label: string }) {
  return (
    <div class="lg lg-typing">
      <span class="tdots">
        <i class="tdot" />
        <i class="tdot" />
        <i class="tdot" />
      </span>
      {label}
    </div>
  )
}

export function SkeletonLines() {
  return (
    <>
      <div class="lg lg-skel" />
      <div class="lg lg-skel s2" />
      <div class="lg lg-skel s3" />
      <div class="lg lg-skel s4" />
      <div class="lg lg-skel s5" />
    </>
  )
}
