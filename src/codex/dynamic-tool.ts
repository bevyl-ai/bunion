import type { LinearDocument } from '@linear/sdk'
import { fetchIssueComments, graphql } from '../linear'
import type { TrackerMirror } from '../tracker-mirror'
import type { Config, DynamicTool, RoleQuota } from '../types'

// THE read path for tickets, served from the brain's TrackerMirror (tracker-mirror.ts): issues arrive via the
// delta sync at zero marginal API cost; a comment thread is fetched from Linear once, then kept current by comment
// deltas + mutation write-back. This replaces agents re-reading their ticket from Linear every turn — the demand
// that blew the 2,500 req/h quota. linear_graphql stays for writes + queries the mirror can't answer.
export function linearReadTool(cfg: Config, mirror: TrackerMirror): DynamicTool {
  return {
    spec: {
      name: 'linear_read',
      description:
        "Read a ticket from the brain's live tracker store — state, title, description, labels, priority, blockers, PR url, and (with comments:true) the full comment thread. Fresh to within one sync pass (~30s); your OWN writes appear immediately. Costs ~zero API. Input: { identifier, comments? }. ALWAYS read tickets with this; use linear_graphql ONLY for writes and for queries this cannot answer.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier'],
        properties: {
          identifier: { type: 'string', description: 'Ticket identifier, e.g. BEV-123.' },
          comments: { type: 'boolean', description: 'Include the comment thread (default false).' },
        },
      },
    },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const id = (typeof a.identifier === 'string' ? a.identifier : typeof args === 'string' ? args : '').trim()
      if (!id) return fail('missing_identifier')
      const issue = mirror.getIssue(id)
      if (!issue) return fail(`not_in_mirror: ${id} is unknown to the tracker mirror (wrong identifier, or older than its 60-day window) — use linear_graphql for a fresh read.`)
      const out: Record<string, unknown> = { identifier: issue.identifier, state: issue.state, title: issue.title, description: issue.description, labels: issue.labels, priority: issue.priority, blockers: issue.blockers, prUrl: issue.prUrl, url: issue.url }
      if (a.comments === true) {
        let thread = mirror.getComments(issue.id)
        if (thread == null) {
          try {
            thread = await fetchIssueComments(cfg, issue.id)
            mirror.setComments(issue.id, thread)
          } catch (e) {
            return fail(`comments_unavailable: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        out.comments = thread
      }
      return { success: true, output: JSON.stringify(out, null, 2) }
    },
  }
}

const DESCRIPTION =
  'Execute a single raw GraphQL query or mutation against Linear, reusing the configured tracker auth. ' +
  'Input: { query, variables? }. One operation per call. A top-level GraphQL `errors` array means the operation failed. ' +
  'For READING a ticket (state/description/comments), use linear_read instead — it is served from the brain and costs no API budget.'

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
export function linearGraphqlTool(cfg: Config, phase?: string | null, quota?: RoleQuota, mirror?: TrackerMirror): DynamicTool {
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
      // BEV-3973: idempotent role filing — a code-level backstop (the prompt's "dedupe first" is best-effort) so a
      // role re-run, or a second role, can't file an exact-title duplicate. Fail-safe: any check error falls through
      // to the create, so a flaky dedup read never blocks a legitimate file.
      if (quota != null && /\bissueCreate\b/.test(query)) {
        const title = createTitle(query, variables)
        if (title) {
          const dup = await findOpenDuplicate(cfg, token, title)
          if (dup) return fail(`duplicate_issue_skipped: an open issue with this exact title already exists (${dup}). Don't file a duplicate — add to ${dup} if you have more, or pick a genuinely different item.`)
        }
      }
      // Stamp the phase name onto new comments (only when acting as the app, and only if the agent didn't set one).
      if (appToken && actorName && /\bcommentCreate\b/.test(query) && !hasCreateAsUser(query, variables)) {
        ;({ query, variables } = injectCreateAsUser(query, variables, actorName))
      }
      try {
        const r = await graphql(cfg, query, variables, token)
        if (r.status === 401) return fail('linear_auth_failed: the configured Linear token is invalid/expired (HTTP 401). STOP — do NOT retry this tool, it will keep failing. Report this as a blocker; an operator must restore Linear auth.')
        const errs = (r.body as { errors?: unknown }).errors
        const success = r.httpOk && !(Array.isArray(errs) && errs.length > 0)
        if (isCreate && quota && success) {
          const ic = (r.body as { data?: { issueCreate?: { success?: boolean } } }).data?.issueCreate
          if (!ic || ic.success !== false) quota.record() // count the filed ticket toward today's total
        }
        // Feed successful mutations back into the store (Apollo-style) so linear_read stays current without refetching.
        if (success && mirror && /\bmutation\b/i.test(query)) mirror.applyMutation(query, variables, r.body)
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

// BEV-3973: find an OPEN (non-canceled) issue with this EXACT title in the configured team/project — so a role's
// issueCreate can be skipped as a duplicate. Best-effort: any error returns null so a real file is never blocked.
async function findOpenDuplicate(cfg: Config, token: string, title: string): Promise<string | null> {
  const filter: LinearDocument.IssueFilter = { title: { eq: title }, state: { type: { neq: 'canceled' } } }
  if (cfg.tracker.team) filter.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) filter.project = { slugId: { eq: cfg.tracker.projectSlug } }
  try {
    const r = await graphql(cfg, `query Dup($filter: IssueFilter) { issues(first: 1, filter: $filter) { nodes { identifier } } }`, { filter }, token)
    if (!r.httpOk) return null
    const id = (r.body as { data?: { issues?: { nodes?: { identifier?: string }[] } } }).data?.issues?.nodes?.[0]?.identifier
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

// Pull the title out of an issueCreate — from variables.input.title, else an inlined `title: "…"` in the query text.
function createTitle(query: string, variables: Record<string, unknown>): string {
  const t = inputObj(variables).title
  if (typeof t === 'string') return t.trim()
  const m = query.match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/)
  return m ? m[1]!.replace(/\\(.)/g, '$1').trim() : ''
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
export function countGraphqlOperations(query: string): number {
  // Strip block strings (""" … """), regular string VALUES ("…", escape-aware), and line comments (# …) before
  // scanning for keywords — otherwise a comment/workpad body inlined as a string argument that happens to contain
  // the English word "query"/"mutation"/"subscription" (e.g. "fixed the slow query") false-positives this as a
  // multi-operation document and rejects an otherwise-valid single-operation call.
  const stripped = query
    .replace(/"""(?:\\"""|[\s\S])*?"""/g, '') // block strings — GraphQL escapes a literal """ inside one as \"""; without
    // honoring that escape, an embedded \""" closes the match early, leaving the REST of the block string (and any
    // keyword inside it) unstripped and exposed to the scan below (BEV re-audit)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // regular string values (escape-aware) — collapse, don't fully delete, so a string like "query" alone doesn't merge two real keywords together
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
