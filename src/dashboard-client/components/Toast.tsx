import type { ToastState } from '../lib/useToast'

export function Toast({ toast }: { toast: ToastState | null }) {
  const variant = toast
    ? toast.isErr
      ? 'border border-[#6f2f2f] bg-[#2a1414] text-danger-text'
      : 'border border-[#2f6f4f] bg-[#13241b] text-[#7fd6a8]'
    : ''
  const visible = toast?.show ?? false
  return (
    <div
      id="toast"
      class={`${variant} ${visible ? 'show' : ''} fixed bottom-[26px] left-1/2 z-[80] rounded-[10px] px-[18px] py-[11px] text-[13px] font-semibold transition-[opacity,transform] duration-[180ms] ${
        visible ? 'translate-x-[-50%] translate-y-0 opacity-100' : 'pointer-events-none translate-x-[-50%] translate-y-[8px] opacity-0'
      }`}
      role="status"
      aria-live="polite"
    >
      {toast ? `${toast.isErr ? '✗' : '✓'} ${toast.msg}` : ''}
    </div>
  )
}
