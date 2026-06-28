import { readFileSync } from 'node:fs'
import { Liquid } from 'liquidjs'
import { parse as parseYaml } from 'yaml'
import { CategorizedError } from './types'
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
    // §5.5 missing_workflow_file
    throw new CategorizedError('missing_workflow_file', `missing workflow file ${path}: ${e instanceof Error ? e.message : e}`)
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
    let parsed: unknown
    try {
      parsed = parseYaml(fmText)
    } catch (e) {
      // §5.5 workflow_parse_error
      throw new CategorizedError('workflow_parse_error', `workflow YAML parse error in ${path}: ${e instanceof Error ? e.message : e}`)
    }
    if (parsed != null) {
      // §5.5 workflow_front_matter_not_a_map
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new CategorizedError('workflow_front_matter_not_a_map', 'workflow front matter is not a map')
      frontmatter = parsed as Record<string, unknown>
    }
  }
  return { frontmatter, prompt: bodyLines.join('\n').trim() }
}

const liquid = new Liquid({ strictVariables: true, strictFilters: true })

// §5.4 fallback used when the workflow prompt body is empty/whitespace
const EMPTY_PROMPT_FALLBACK = 'You are working on an issue from Linear.'

// Render the prompt template with the strict Liquid engine Symphony uses. `attempt` is null on the first run of a
// fresh worker and an integer on retry/continuation; the template branches on it via `{% if attempt %}`.
// §12.2: passes the full normalized issue (blockers, branchName, updatedAt, labels) so templates can iterate/branch.
export function renderPrompt(template: string, vars: { attempt: number | null; issue: Issue; workpad?: string | null }): string {
  // §5.4 empty-prompt fallback — render the minimal default instead of an empty prompt
  const effectiveTemplate = template.trim() === '' ? EMPTY_PROMPT_FALLBACK : template

  const { issue } = vars
  let parsed: ReturnType<typeof liquid.parse>
  try {
    parsed = liquid.parse(effectiveTemplate)
  } catch (e) {
    // §5.5 template_parse_error
    throw new CategorizedError('template_parse_error', `template parse error: ${e instanceof Error ? e.message : e}`)
  }

  try {
    return liquid.renderSync(parsed, {
      attempt: vars.attempt,
      workpad: vars.workpad ?? null,
      // §12.2: expose the FULL normalized issue (incl. prUrl/startedAt/completedAt/branchName/updatedAt/blockers) so
      // any spec-conformant template can reference any field under the strict Liquid engine.
      issue: { ...issue, description: issue.description || null },
    })
  } catch (e) {
    // §5.5 template_render_error (unknown variable/filter, invalid interpolation)
    throw new CategorizedError('template_render_error', `template render error: ${e instanceof Error ? e.message : e}`)
  }
}
