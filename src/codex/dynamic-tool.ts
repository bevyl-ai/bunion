import { graphql } from '../linear'
import type { Config, DynamicTool } from '../types'

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
export function linearGraphqlTool(cfg: Config, phase?: string | null): DynamicTool {
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
      // Stamp the phase name onto new comments (only when acting as the app, and only if the agent didn't set one).
      if (appToken && actorName && /\bcommentCreate\b/.test(query) && !hasCreateAsUser(query, variables)) {
        ;({ query, variables } = injectCreateAsUser(query, variables, actorName))
      }
      try {
        const r = await graphql(cfg, query, variables, token)
        const errs = (r.body as { errors?: unknown }).errors
        const success = r.httpOk && !(Array.isArray(errs) && errs.length > 0)
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

function normalize(args: unknown): { query: string; variables: Record<string, unknown> } | { error: string } {
  if (typeof args === 'string') {
    const q = args.trim()
    return q ? { query: q, variables: {} } : { error: 'missing_query' }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const a = args as Record<string, unknown>
    const q = typeof a.query === 'string' ? a.query.trim() : ''
    if (!q) return { error: 'missing_query' }
    const v = a.variables
    if (v != null && (typeof v !== 'object' || Array.isArray(v))) return { error: 'invalid_variables' }
    return { query: q, variables: (v as Record<string, unknown>) ?? {} }
  }
  return { error: 'invalid_arguments' }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}
