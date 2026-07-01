import { useRef, useState } from 'preact/hooks'

export interface ToastState {
  msg: string
  isErr: boolean
  show: boolean
}

// bottom-center toast, auto-dismisses after ~3.4s (item 35).
export function useToast(): { toast: ToastState | null; showToast: (msg: string, isErr: boolean) => void } {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = (msg: string, isErr: boolean): void => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ msg, isErr, show: true })
    timer.current = setTimeout(() => setToast((t) => (t ? { ...t, show: false } : t)), 3400)
  }

  return { toast, showToast }
}
