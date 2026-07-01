import { useRef, useState } from 'preact/hooks'

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
  const taRef = useRef<HTMLTextAreaElement | null>(null)

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

  const sendDisabled = pending || !value.trim()

  return (
    <div id="mchat" class="flex items-end gap-2 mt-2.5 mx-4 mb-0">
      <textarea
        id="mmsg"
        ref={taRef}
        rows={1}
        aria-label="Message the agent"
        placeholder={placeholder}
        value={value}
        disabled={pending}
        class="flex-1 bg-surf2 border border-line2 rounded-lg text-fg text-[13px]/[1.5] font-['-apple-system',BlinkMacSystemFont,'Segoe_UI',Roboto,sans-serif] px-[11px] py-[9px] resize-y min-h-[38px] max-h-[160px] outline-none box-border focus:border-accent placeholder:text-mut2"
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
      <button
        id="msend"
        disabled={sendDisabled}
        onClick={() => void doSend()}
        class="bg-accent text-white border-none rounded-lg px-4 h-[38px] font-semibold text-[13px]/[1] font-['-apple-system',BlinkMacSystemFont,sans-serif] cursor-pointer whitespace-nowrap flex-none disabled:opacity-50 disabled:cursor-default"
      >
        {pending ? '…' : 'Send'}
      </button>
    </div>
  )
}
