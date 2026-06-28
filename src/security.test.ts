import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { approvalDecision, parseTrustedCodexCommand } from './codex/app-server'
import { loadConfig, validateConfig } from './config'
import { authorizeDashboardMutation } from './dashboard'
import { privateJsonWrite } from './orchestrator'
import { sshOptions } from './ssh'
import type { Config } from './types'

function workflow(frontmatter: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunion-security-'))
  const path = join(dir, 'WORKFLOW.md')
  writeFileSync(
    path,
    `---\n${frontmatter.trim()}\n---\nship it\n`,
    { mode: 0o600 },
  )
  return path
}

function baseFrontmatter(extra = ''): string {
  return `
tracker:
  kind: linear
  team: BEV
  api_key: test-token
${extra}
`
}

function cfgForApproval(approvedCommands: string[] = []): Config {
  const cfg = loadConfig(workflow(baseFrontmatter()))
  return { ...cfg, codex: { ...cfg.codex, approvedCommands } }
}

test('dashboard mutation requests require same-origin json and the csrf token', () => {
  const token = 'csrf-secret'
  const req = (headers: Record<string, string>) =>
    new Request('http://127.0.0.1:4319/action', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'BEV-1', action: 'to-qa' }),
    })

  expect(authorizeDashboardMutation(req({ 'content-type': 'application/json', host: '127.0.0.1:4319' }), token).ok).toBe(false)
  expect(authorizeDashboardMutation(req({ 'content-type': 'application/json', host: '127.0.0.1:4319', 'x-bunion-csrf': 'bad' }), token).ok).toBe(false)
  expect(authorizeDashboardMutation(req({ 'content-type': 'application/json', host: 'evil.test', origin: 'https://evil.test', 'x-bunion-csrf': token }), token).ok).toBe(false)
  expect(authorizeDashboardMutation(req({ 'content-type': 'application/json', host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319', 'x-bunion-csrf': token }), token)).toEqual({ ok: true })
})

test('tracker endpoint must stay on Linear https graphql', () => {
  validateConfig(loadConfig(workflow(baseFrontmatter())))

  expect(() => validateConfig(loadConfig(workflow(baseFrontmatter('  endpoint: http://api.linear.app/graphql'))))).toThrow(/tracker.endpoint/)
  expect(() => validateConfig(loadConfig(workflow(baseFrontmatter('  endpoint: https://attacker.test/graphql'))))).toThrow(/tracker.endpoint/)
  expect(() => validateConfig(loadConfig(workflow(baseFrontmatter('  endpoint: https://api.linear.app/elsewhere'))))).toThrow(/tracker.endpoint/)
})

test('codex bootstrap command is a hardcoded safe argv form, not shell text', () => {
  expect(parseTrustedCodexCommand('codex --config shell_environment_policy.inherit=all app-server')).toEqual([
    'codex',
    '--config',
    'shell_environment_policy.inherit=all',
    'app-server',
  ])
  expect(() => parseTrustedCodexCommand('codex app-server; touch /tmp/pwned')).toThrow(/not trusted/)
  expect(() => parseTrustedCodexCommand('bash -lc "codex app-server"')).toThrow(/not trusted/)
})

test('workflow shell hooks require operator env trust outside mutable workflow config', () => {
  const old = process.env.BUNION_TRUST_WORKFLOW_SHELL
  delete process.env.BUNION_TRUST_WORKFLOW_SHELL
  try {
    const cfg = loadConfig(workflow(baseFrontmatter('hooks:\n  after_create: echo pwned')))
    expect(() => validateConfig(cfg)).toThrow(/hooks.*BUNION_TRUST_WORKFLOW_SHELL/)
  } finally {
    if (old === undefined) delete process.env.BUNION_TRUST_WORKFLOW_SHELL
    else process.env.BUNION_TRUST_WORKFLOW_SHELL = old
  }
})

test('danger-full Codex sandbox requires operator env trust outside mutable workflow config', () => {
  const old = process.env.BUNION_CODEX_DANGER_FULL_ACCESS
  delete process.env.BUNION_CODEX_DANGER_FULL_ACCESS
  try {
    const cfg = loadConfig(workflow(baseFrontmatter('codex:\n  thread_sandbox: danger-full-access')))
    expect(() => validateConfig(cfg)).toThrow(/danger-full-access.*BUNION_CODEX_DANGER_FULL_ACCESS/)
  } finally {
    if (old === undefined) delete process.env.BUNION_CODEX_DANGER_FULL_ACCESS
    else process.env.BUNION_CODEX_DANGER_FULL_ACCESS = old
  }
})

test('app-server approval helper denies high-risk requests unless an operator env allowlist matches exactly', () => {
  expect(approvalDecision('item/fileChange/requestApproval', {}, cfgForApproval())).toBeNull()
  expect(approvalDecision('applyPatchApproval', {}, cfgForApproval())).toBeNull()
  expect(approvalDecision('item/commandExecution/requestApproval', { command: 'git status --short' }, cfgForApproval())).toBeNull()
  expect(approvalDecision('item/commandExecution/requestApproval', { command: 'git status --short' }, cfgForApproval(['git status --short']))).toBe('acceptForSession')
  expect(approvalDecision('item/commandExecution/requestApproval', { command: 'git status --short; rm -rf /' }, cfgForApproval(['git status --short']))).toBeNull()
})

test('ssh options use strict host key checking by default with an explicit env escape hatch', () => {
  const old = process.env.BUNION_SSH_TRUST_ON_FIRST_USE
  delete process.env.BUNION_SSH_TRUST_ON_FIRST_USE
  try {
    expect(sshOptions()).toContain('StrictHostKeyChecking=yes')
  } finally {
    if (old === undefined) delete process.env.BUNION_SSH_TRUST_ON_FIRST_USE
    else process.env.BUNION_SSH_TRUST_ON_FIRST_USE = old
  }

  process.env.BUNION_SSH_TRUST_ON_FIRST_USE = '1'
  try {
    expect(sshOptions()).toContain('StrictHostKeyChecking=accept-new')
  } finally {
    if (old === undefined) delete process.env.BUNION_SSH_TRUST_ON_FIRST_USE
    else process.env.BUNION_SSH_TRUST_ON_FIRST_USE = old
  }
})

test('private json writes create owner-only state files and tighten existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bunion-state-'))
  chmodSync(dir, 0o777)
  const file = join(dir, 'tokens.json')
  writeFileSync(file, '{}', { mode: 0o666 })

  privateJsonWrite(file, { BEV: { build: { total: 1 } } })

  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ BEV: { build: { total: 1 } } })
})
