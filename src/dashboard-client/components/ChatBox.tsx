import { useRef, useState } from 'preact/hooks'

// Item 45: auto-growing textarea (min-height ~38px, max-height ~160px), Send disabled while empty/whitespace,
// Enter sends (Shift+Enter inserts newline). On send: clear + disable both, POST /chat, re-enable + refocus.
export function ChatBox({
  placeholder,
  onSend,
  pending,
}: {
  placeholder: string
  onSend: (text: string) => Promise<void>
  pending: boolean
}) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const autoGrow = (): void => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  const doSend = async (): Promise<void> => {
    const text = value.trim()
    if (!text) return
    setValue('')
    if (taRef.current) taRef.current.style.height = 'auto'
    await onSend(text)
    taRef.current?.focus()
  }

  const disabled = pending
  const sendDisabled = disabled || !value.trim()

  return (
    <div id="mchat">
      <textarea
        id="mmsg"
        ref={taRef}
        rows={1}
        aria-label="Message the agent"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onInput={(e) => {
          setValue((e.target as HTMLTextAreaElement).value)
          autoGrow()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void doSend()
          }
        }}
      />
      <button id="msend" disabled={sendDisabled} onClick={() => void doSend()}>
        {pending ? '…' : 'Send'}
      </button>
    </div>
  )
}
