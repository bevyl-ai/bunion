export const TRUSTED_CODEX_COMMANDS = new Set([
  'codex app-server',
  'codex --config shell_environment_policy.inherit=all app-server',
])

const SHELL_CONTROL = /[;&|`$<>(){}[\]\n\r]/

export function parseTrustedCodexCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  const normalized = parts.join(' ')
  if (!TRUSTED_CODEX_COMMANDS.has(normalized)) throw new Error(`codex.command is not trusted: ${command}`)
  return parts
}

export function hasShellControl(command: string): boolean {
  return SHELL_CONTROL.test(command)
}

export function commandString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) return v.map(String).join(' ').trim()
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    return commandString(obj.command ?? obj.cmd)
  }
  return ''
}
