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

// The `linear_graphql` host tool. The agent calls it over the app-server; bunion runs the GraphQL op with the
// configured Linear auth and returns the body. This is how the agent drives Linear (state, the workpad, links).
export function linearGraphqlTool(cfg: Config): DynamicTool {
  return {
    spec: { name: 'linear_graphql', description: DESCRIPTION, inputSchema: INPUT_SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const norm = normalize(args)
      if ('error' in norm) return fail(norm.error)
      if (!cfg.tracker.apiKey) return fail('missing_linear_api_token')
      try {
        const r = await graphql(cfg, norm.query, norm.variables)
        const errs = (r.body as { errors?: unknown }).errors
        const success = r.httpOk && !(Array.isArray(errs) && errs.length > 0)
        return { success, output: JSON.stringify(r.body, null, 2) }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }
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
