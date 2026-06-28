import { graphql } from '../linear'
import type { Config, DynamicTool, RoleQuota } from '../types'

const DESCRIPTION =
  'Execute a single raw GraphQL query or mutation against Linear, reusing the configured tracker auth. ' +
  'Input: { query, variables? }. One operation per call. A top-level GraphQL `errors` array means the operation failed.'

const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', description: 'GraphQL query or mutation document to execute against Linear.' },
    variables: { type: ['object', 'null'], description: 'Optional GraphQL variables object.', additionalProperties: true },
  },
}

// The `linear_graphql` host tool. The agent calls it over the app-server; bunion runs the GraphQL op and returns the
// body. This is how the agent drives Linear (state, the workpad, links). When an OAuth app token is configured, the
// agent acts AS the app ("Bevyl Factory") and each phase's comments are stamped with its own name via createAsUser
// ("bunion-<phase> (via Bevyl Factory)"). `phase` is the worker's current pipeline phase.
export function linearGraphqlTool(cfg: Config, phase?: string | null, quota?: RoleQuota): DynamicTool {
  const appToken = cfg.tracker.appToken
  const actorName = phase ? `bunion-${phase}` : null
  return {
    spec: { name: 'linear_graphql', description: DESCRIPTION, inputSchema: INPUT_SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const norm = normalize(args)
      if ('error' in norm) return fail(norm.error)
      const token = appToken ?? cfg.tracker.apiKey
      if (!token) return fail('missing_linear_api_token')
      let { query, variables } = norm
      // Daily ticket-filing cap (pool roles): refuse an issueCreate over the role's budget. The orchestrator persists
      // the count, so the cap holds live within a run, across runs, and across daemon restarts.
      const isCreate = quota?.limit != null && /\bissueCreate\b/.test(query)
      if (isCreate && quota && quota.remaining() <= 0) {
        return fail(`daily_ticket_quota_reached: today's limit of ${quota.limit} new tickets for this role is reached — do not create more issues today; stop filing.`)
      }
      // Stamp the phase name onto new comments (only when acting as the app, and only if the agent didn't set one).
      if (appToken && actorName && /\bcommentCreate\b/.test(query) && !hasCreateAsUser(query, variables)) {
        ;({ query, variables } = injectCreateAsUser(query, variables, actorName))
      }
      try {
        const r = await graphql(cfg, query, variables, token)
        const errs = (r.body as { errors?: unknown }).errors
        const success = r.httpOk && !(Array.isArray(errs) && errs.length > 0)
        if (isCreate && quota && success) {
          const ic = (r.body as { data?: { issueCreate?: { success?: boolean } } }).data?.issueCreate
          if (!ic || ic.success !== false) quota.record() // count the filed ticket toward today's total
        }
        return { success, output: JSON.stringify(r.body, null, 2) }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }
}

function inputObj(variables: Record<string, unknown>): Record<string, unknown> {
  const i = variables.input
  return i && typeof i === 'object' && !Array.isArray(i) ? (i as Record<string, unknown>) : {}
}

function hasCreateAsUser(query: string, variables: Record<string, unknown>): boolean {
  return /createAsUser/.test(query) || 'createAsUser' in inputObj(variables)
}

function injectCreateAsUser(query: string, variables: Record<string, unknown>, name: string): { query: string; variables: Record<string, unknown> } {
  const input = variables.input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { query, variables: { ...variables, input: { ...(input as Record<string, unknown>), createAsUser: name } } }
  }
  // Inline `commentCreate(input: { … }` — insert createAsUser right after the opening brace.
  return { query: query.replace(/(commentCreate\s*\(\s*input\s*:\s*\{)/, `$1 createAsUser: ${JSON.stringify(name)}, `), variables }
}

// §10.5: count how many top-level operation definitions a GraphQL document contains. We detect named operations
// (query/mutation/subscription followed by optional name) and anonymous shorthand queries (a bare `{`). A single
// anonymous `{` is one definition; everything else increments the counter via the keyword scan.
function countGraphqlOperations(query: string): number {
  // Strip block comments (""" … """) and line comments (# …) to avoid false positives inside strings.
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, '') // block strings
    .replace(/#[^\n]*/g, '') // line comments
  // Exclude the keyword when it's a variable ($query) or an argument/field NAME (query:) — only operation definitions count.
  const keywords = (stripped.match(/(?<!\$)\b(query|mutation|subscription)\b(?!\s*:)/g) ?? []).length
  // A lone `{` at the start (after whitespace) is a valid shorthand query definition.
  const hasShorthand = /^\s*\{/.test(stripped) ? 1 : 0
  return keywords + hasShorthand
}

function normalize(args: unknown): { query: string; variables: Record<string, unknown> } | { error: string } {
  if (typeof args === 'string') {
    const q = args.trim()
    if (!q) return { error: 'missing_query' }
    if (countGraphqlOperations(q) > 1) return { error: 'invalid input: multiple operations' }
    return { query: q, variables: {} }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    const q = typeof a.query === 'string' ? a.query.trim() : ''
    if (!q) return { error: 'missing_query' }
    // §10.5: reject documents containing more than one operation definition (Symphony §10.5).
    if (countGraphqlOperations(q) > 1) return { error: 'invalid input: multiple operations' }
    const v = a.variables
    if (v != null && (typeof v !== 'object' || Array.isArray(v))) return { error: 'invalid_variables' }
    return { query: q, variables: (v as Record<string, unknown>) ?? {} }
  }
  return { error: 'invalid_arguments' }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}
