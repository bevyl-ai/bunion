import { parseLogLine } from '../lib/logline'

export function LogLine({ line }: { line: string }) {
  const { kind, text } = parseLogLine(line)
  switch (kind) {
    case 'turn':
      return (
        <div class="px-0 pb-0 pt-[13px] mt-[18px] mb-0.5 text-accent font-bold text-[10.5px]/[1] font-mono border-t border-line tracking-[1.5px] uppercase">
          {text}
        </div>
      )
    case 'op':
      return (
        <div class="p-0 text-fg text-[13px] leading-[1.62] my-2.5 px-[13px] py-[9px] border-l-2 border-accent bg-[#5b8def14] rounded-lg">
          <b class="text-accent2 font-bold mr-[7px] uppercase text-[9.5px] tracking-[.7px]">you</b>
          {text}
        </div>
      )
    case 'msg':
      return <div class="p-0 text-fg text-[13px] leading-[1.62] my-2.5 px-[13px] py-[9px] border-l-2 border-good2 bg-surf2 rounded-lg">{text}</div>
    case 'cmd':
      return (
        <div class="p-0 text-mut2 font-mono text-[11.5px]/[1.45] whitespace-nowrap overflow-hidden text-ellipsis py-[2.5px] pr-0 pl-[13px]" title={text}>
          <b class="text-accent font-bold mr-[3px]">$</b>
          {text}
        </div>
      )
    case 'tool':
      return <div class="p-0 text-warn font-mono text-[11.5px]/[1.45] py-0.5 pr-0 pl-[13px] opacity-90">{text}</div>
    case 'edit':
      return <div class="p-0 text-pink font-mono text-[11.5px]/[1.45] py-0.5 pr-0 pl-[13px]">{text}</div>
    default:
      return <div class="p-0 text-mut2 font-mono text-[11.5px]/[1.45] whitespace-nowrap overflow-hidden text-ellipsis py-[2.5px] pr-0 pl-[13px]">{text}</div>
  }
}

export function LiveLine({ text }: { text: string }) {
  return (
    <div class="p-0 text-fg text-[13px] leading-[1.62] my-2.5 px-[13px] py-[9px] border-l-2 border-good2 bg-surf2 rounded-lg whitespace-pre-wrap">
      {text}
      <span class="lg-cur" />
    </div>
  )
}

export function TypingDots({ label }: { label: string }) {
  return (
    <div class="p-0 flex items-center gap-[9px] text-mut text-[12.5px] my-2.5 px-[13px] py-2.5 border-l-2 border-good2 bg-surf2 rounded-lg">
      <span class="inline-flex gap-1">
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
      <div class="lg-skel" />
      <div class="lg-skel s2" />
      <div class="lg-skel s3" />
      <div class="lg-skel s4" />
      <div class="lg-skel s5" />
    </>
  )
}
