import { readFileSync } from 'node:fs'
import type { Issue } from './types'

// Loads the operator-owned workflow.md and fills in the ticket + any prior feedback (comments from an earlier run
// that a human bounced back). The ticket text is untrusted input — data for the agent, never instructions to the
// runner; the agent itself runs with no network and no credentials.
export function renderWorkflow(path: string, issue: Issue): string {
  const tpl = readFileSync(path, 'utf8')
  const feedback = issue.comments.length > 0 ? issue.comments.map((c) => `- ${c}`).join('\n') : '(none)'
  return tpl
    .replaceAll('{{identifier}}', issue.identifier)
    .replaceAll('{{title}}', issue.title)
    .replaceAll('{{url}}', issue.url)
    .replaceAll('{{description}}', issue.description || '(no description provided)')
    .replaceAll('{{comments}}', feedback)
}
