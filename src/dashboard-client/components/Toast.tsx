import type { ToastState } from '../lib/useToast'

export function Toast({ toast }: { toast: ToastState | null }) {
  const cls = toast ? `${toast.isErr ? 'err' : 'ok'}${toast.show ? ' show' : ''}` : ''
  return (
    <div id="toast" class={cls} role="status" aria-live="polite">
      {toast ? `${toast.isErr ? '✗' : '✓'} ${toast.msg}` : ''}
    </div>
  )
}
