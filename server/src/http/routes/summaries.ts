import { Hono } from "hono";
import { z } from "zod";
import type { SQL } from "bun";
import {
  HISTORY_LIMITS, pathIdentityMachine, redactSecrets, storable,
  type Binding, type SearchScope, type StateResponse, type SummaryView,
} from "@cerebro/shared";
import type { AppDeps, Env } from "../app";
import { BindingError, resolveBinding } from "../../bindings";
import { SUMMARY_FROM, summaryScopeClause } from "../../search";
import { embedSummary, summaryEmbedText, type SummaryBody } from "../../summarise/summarise";
import { invalidateStates, markScopesDirty, scopeKey } from "../../summarise/state";
import { parseBody } from "../validate";
import { cursorTs, parseCursor } from "../../read";
import { int, iso, scopeParams, withScope } from "./read";

const beforeCursor = z.string().max(100).refine((s) => /^\d{1,18}$/.test(parseCursor(s)?.id ?? ""), {
  message: "before must be a cursor from a previous page's next",
});
const notInverted = (q: { from?: string; to?: string }) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to);
const listQuery = z.object({
  ...scopeParams,
  from: iso.optional(),
  to: iso.optional(),
  limit: int(1, 100).optional(),
  before: beforeCursor.optional(),
}).refine(notInverted, { message: "from must not be after to" });
const historyBody = z.object({
  repo: z.string().min(1).max(1000),
  subpath: z.string().max(1000).default(""),
  title: z.string().trim().min(1).max(HISTORY_LIMITS.maxTitle),
  text: z.string().trim().min(1).max(HISTORY_LIMITS.maxText),
  tsFrom: iso,
  tsTo: iso,
}).refine((b) => Date.parse(b.tsFrom) <= Date.parse(b.tsTo), { message: "tsFrom must not be after tsTo" });

const VIEW_COLS = `sm.id, sm.kind, sm.session_id, sm.first_seq, sm.last_seq, sm.ts_from, sm.ts_to, sm.title,
  coalesce(sm.body->>'overview', '') as overview,
  case when jsonb_typeof(sm.body->'facts') = 'array' then sm.body->'facts' else '[]'::jsonb end as facts,
  cl.name as client_name, p.name as project_name`;
const NAMES = "left join clients cl on cl.id = sm.client_id left join projects p on p.id = sm.project_id";

const toView = (r: any): SummaryView => ({
  id: Number(r.id), kind: r.kind, sessionId: r.session_id, firstSeq: r.first_seq, lastSeq: r.last_seq,
  tsFrom: r.ts_from.toISOString(), tsTo: r.ts_to.toISOString(), title: r.title, overview: r.overview, facts: r.facts,
  clientName: r.client_name, projectName: r.project_name,
});

/** Summaries visible in a scope, newest first. `before` is the previous page's `next` cursor. */
async function listSummaries(
  sql: SQL, scope: SearchScope, f: { from?: string; to?: string; limit?: number; before?: string },
): Promise<{ summaries: SummaryView[]; next: string | null }> {
  const params: unknown[] = [];
  let where = summaryScopeClause(scope, f, params);
  const cursor = f.before ? parseCursor(f.before) : null;
  if (cursor) {
    params.push(cursor.ts, cursor.id);
    where += ` and (sm.ts_to, sm.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  const limit = Math.min(f.limit ?? 20, 100);
  const rows = await sql.unsafe(
    `select ${VIEW_COLS}, ${cursorTs("sm.ts_to")} as cursor_ts ${SUMMARY_FROM} ${NAMES} where ${where} order by sm.ts_to desc, sm.id desc limit ${limit}`, params);
  const summaries = rows.map(toView);
  const last = rows[rows.length - 1];
  return { summaries, next: rows.length === limit && last ? `${last.cursor_ts}|${last.id}` : null };
}

/**
 * The state scope a request reads: the locked project, else the explicit project or client filter,
 * else the folder's own (client-only) binding. Null when nothing names a single project or client.
 */
function stateKey(scope: SearchScope, active: Binding | null): string | null {
  if (scope.kind === "project") return `project:${scope.projectId}`;
  if (scope.projectId) return `project:${scope.projectId}`;
  if (scope.clientId) return `client:${scope.clientId}`;
  return active?.clientId ? scopeKey(active.clientId, active.projectId) : null;
}

/** Model-free cleaning for client-written text: secrets redacted, made storable. */
const clean = (s: string) => storable(redactSecrets(s)).trim();

export function summaryRoutes({ sql, embedder, log = (l: string) => console.log(l) }: AppDeps) {
  const r = new Hono<Env>();

  r.get("/state", async (c) => {
    const q = z.object(scopeParams).safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", message: q.error.issues[0]?.message ?? "invalid query" }, 400);
    return withScope(sql, c, q.data, async (scope, active) => {
      const key = stateKey(scope, active);
      if (!key) return c.json({ scope: null, state: null } satisfies StateResponse);
      // Open scope naming both a client and a project: the project must be that client's.
      const client = scope.kind === "open" && scope.clientId && scope.projectId ? scope.clientId : null;
      const [row] = await sql`
        select doc, text, version, updated_at from project_states
        where scope = ${key} and text <> '' and (${client}::uuid is null or client_id = ${client}::uuid)`;
      const state = row ? { doc: row.doc, text: row.text, version: row.version, updatedAt: row.updated_at.toISOString() } : null;
      return c.json({ scope: key, state } satisfies StateResponse);
    });
  });

  r.get("/summaries", async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", message: q.error.issues[0]?.message ?? "invalid query" }, 400);
    return withScope(sql, c, q.data, async (scope) => c.json(await listSummaries(sql, scope, q.data)));
  });

  // An initial project history written by the client's own Claude: stored as a `history` summary of the
  // folder's binding (one per period; re-sending a period replaces it). Spends no server tokens.
  r.post("/summaries", async (c) => {
    const b = await parseBody(c, historyBody);
    if (b instanceof Response) return b;
    const owner = pathIdentityMachine(b.repo);
    if (owner !== null && owner !== c.get("machine").name)
      return c.json({ error: "foreign_path_identity", message: `path identities belong to the machine that created them (${owner})` }, 403);
    let binding: Binding | null;
    try { binding = await resolveBinding(sql, b.repo, b.subpath); } catch (e) {
      if (e instanceof BindingError) return c.json({ error: "invalid_subpath", message: e.message }, 400);
      throw e;
    }
    if (!binding) return c.json({ error: "unknown_binding", message: "this folder is not bound; bind it before saving its history" }, 404);
    const declined = () => c.json({ error: "binding_declined", message: "this folder is declined; nothing is stored for it" }, 409);
    if (binding.status !== "active") return declined();
    const bindingId = binding.id;

    const title = clean(b.title), text = clean(b.text);
    const day = (s: string) => new Date(s).toISOString().slice(0, 10);
    const body: SummaryBody = {
      title, period: `${day(b.tsFrom)} to ${day(b.tsTo)}`, overview: text,
      decisions: [], changes: [], facts: [], open_threads: [], resolved_threads: [],
    };
    const saved = await sql.begin(async (tx) => {
      const [cur] = await tx`select id, client_id, project_id from bindings where id = ${bindingId} and status = 'active' for share`;
      if (!cur) return null;
      const [old] = await tx`
        select id, client_id, project_id from summaries
        where kind = 'history' and binding_id = ${cur.id} and ts_from = ${b.tsFrom}::timestamptz and ts_to = ${b.tsTo}::timestamptz
        for update`;
      const [row] = await tx`
        insert into summaries (session_id, kind, binding_id, client_id, project_id, ts_from, ts_to, title, body, text, model)
        values (null, 'history', ${cur.id}, ${cur.client_id}, ${cur.project_id}, ${b.tsFrom}, ${b.tsTo}, ${title},
                ${JSON.stringify(body)}::text::jsonb, ${text}, 'client')
        on conflict (binding_id, ts_from, ts_to) where kind = 'history' do update set
          client_id = excluded.client_id, project_id = excluded.project_id, title = excluded.title,
          body = excluded.body, text = excluded.text, model = excluded.model, created_at = now()
        returning id`;
      // A replaced history's old vector describes the old text.
      if (old) await tx`delete from summary_embeddings where summary_id = ${row.id}`;
      const scopes = [scopeKey(cur.client_id, cur.project_id)];
      if (old?.client_id) scopes.push(scopeKey(old.client_id, old.project_id));
      // A replaced history keeps its id, which the state already counts as folded, and its old text
      // may be woven into the state: rebuild rather than fold. A new one is folded like any summary.
      const lost = old?.client_id && scopes[1] !== scopes[0] ? [scopes[1]] : [];
      if (old) await invalidateStates(tx, scopes, lost);
      else await markScopesDirty(tx, scopes);
      return { id: row.id, created: !old };
    });
    if (!saved) return declined();
    // In the background, so a slow embedder never makes a committed save look failed. Best effort:
    // un-embedded, the history is still found by full-text search. Logs carry no user content.
    embedSummary(sql, embedder, saved.id, summaryEmbedText({ title, body })).catch((e) =>
      log(JSON.stringify({ level: "error", t: new Date().toISOString(), what: "history_embed", error: (e as Error)?.name ?? "Error" })));
    const [row] = await sql.unsafe(`select ${VIEW_COLS} from summaries sm ${NAMES} where sm.id = $1`, [saved.id]);
    return c.json({ summary: toView(row) }, saved.created ? 201 : 200);
  });

  return r;
}
