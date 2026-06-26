import { readFileSync } from 'node:fs'
import type { Issue } from './types'

// Loads the operator-owned workflow.md and fills in the ticket. The ticket text is untrusted input — it is data
// for the agent, never instructions to the runner; the agent itself runs with no network and no credentials.
export function renderWorkflow(path: string, issue: Issue): string {
  const tpl = readFileSync(path, 'utf8')
  return tpl
    .replaceAll('{{identifier}}', issue.identifier)
    .replaceAll('{{title}}', issue.title)
    .replaceAll('{{component}}', issue.component ?? '')
    .replaceAll('{{url}}', issue.url)
    .replaceAll('{{description}}', issue.description || '(no description provided)')
}
