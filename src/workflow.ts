import { readFileSync } from 'node:fs'
import { Liquid } from 'liquidjs'
import { parse as parseYaml } from 'yaml'
import type { Issue } from './types'

export interface ParsedWorkflow {
  frontmatter: Record<string, unknown>
  prompt: string
}

// Split WORKFLOW.md into YAML front matter + the prompt body, faithful to Symphony's parser: a leading `---` opens
// front matter, the next `---` closes it; everything after is the prompt. No front matter → empty config, all body.
export function parseWorkflow(path: string): ParsedWorkflow {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`missing workflow file ${path}: ${e instanceof Error ? e.message : e}`)
  }
  const lines = content.split(/\r\n|\r|\n/)
  if (lines[0]?.trim() !== '---') return { frontmatter: {}, prompt: content.trim() }

  const rest = lines.slice(1)
  const close = rest.findIndex((l) => l.trim() === '---')
  const fmLines = close >= 0 ? rest.slice(0, close) : rest
  const bodyLines = close >= 0 ? rest.slice(close + 1) : []
  const fmText = fmLines.join('\n').trim()

  let frontmatter: Record<string, unknown> = {}
  if (fmText) {
    const parsed: unknown = parseYaml(fmText)
    if (parsed != null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('workflow front matter is not a map')
      frontmatter = parsed as Record<string, unknown>
    }
  }
  return { frontmatter, prompt: bodyLines.join('\n').trim() }
}

const liquid = new Liquid({ strictVariables: true, strictFilters: true })

// Render the prompt template with the strict Liquid engine Symphony uses. `attempt` is null on the first run of a
// fresh worker and an integer on retry/continuation; the template branches on it via `{% if attempt %}`.
export function renderPrompt(template: string, vars: { attempt: number | null; issue: Issue }): string {
  return liquid.parseAndRenderSync(template, {
    attempt: vars.attempt,
    issue: {
      id: vars.issue.id,
      identifier: vars.issue.identifier,
      title: vars.issue.title,
      description: vars.issue.description || null,
      url: vars.issue.url,
      state: vars.issue.state,
      priority: vars.issue.priority,
      createdAt: vars.issue.createdAt,
      labels: vars.issue.labels,
    },
  })
}
