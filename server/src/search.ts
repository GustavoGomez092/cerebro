import type { SQL } from "bun";
import type { Binding, SearchHit, SearchRequest, SearchResponse, SearchScope } from "@cerebro/shared";
import { resolveBinding } from "./bindings";
import { EmbedderError, toVector, type Embedder } from "./embed/embedder";
import type { EmbedGate } from "./worker";
import { pgState } from "./db";

const CANDIDATES = 50;
const RRF_K = 60;
/** Scopes with at most this many embedded chunks get an exact scan (HNSW post-filtering loses recall). */
const EXACT_SCAN_MAX = 50_000;
/** Full-text ranking only looks at this many newest matches, so common words stay cheap. */
const FTS_RANK_WINDOW = 5_000;
const LEG_TIMEOUT = "5s";

const STOP = new Set(("a an and are as at be but by for from had has have how i if in into is it its of on or so that the their " +
  "then there these this to was we were what when where which who why will with you your did do does done can could should would " +
  "el la los las un una unos unas y o de del al en con por para que como es son fue se lo le su sus pero mas muy ya").split(" "));

export class ScopeError extends Error {}

/**
 * Scope for a request. A folder resolves to its nearest *active* binding (a declined subfolder
 * inherits its parent's lock); a project binding locks the request to that project. Without a
 * folder the caller must ask for the open scope explicitly.
 */
export async function scopeFor(sql: SQL, req: { repo?: string; subpath?: string; scope?: "open"; clientId?: string; projectId?: string }):
  Promise<{ scope: SearchScope; binding: Binding | null }> {
  if (!req.repo && req.scope !== "open") throw new ScopeError("send the folder's repo (and subpath), or scope: \"open\"");
  if (req.repo) {
    const binding = await resolveBinding(sql, req.repo, req.subpath ?? "");
    const active = binding?.status === "active" ? binding : await resolveBinding(sql, req.repo, req.subpath ?? "", { activeOnly: true });
    if (active?.projectId) return { scope: { kind: "project", projectId: active.projectId }, binding };
    return { scope: { kind: "open", clientId: req.clientId, projectId: req.projectId }, binding };
  }
  return { scope: { kind: "open", clientId: req.clientId, projectId: req.projectId }, binding: null };
}

/** Builds the shared WHERE clause: active bindings only, scope, and date window. */
function scopeClause(scope: SearchScope, req: SearchRequest, params: unknown[]): string {
  const where = ["b.status = 'active'"];
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replaceAll("?", `$${params.length}`)); };
  if (scope.kind === "project") add("b.project_id = ?", scope.projectId);
  else {
    if (scope.clientId) add("b.client_id = ?", scope.clientId);
    if (scope.projectId) add("b.project_id = ?", scope.projectId);
  }
  if (req.from) { add("c.ts_to >= ?::timestamptz", req.from); add("coalesce(s.last_event_at, s.started_at) >= ?::timestamptz", req.from); }
  if (req.to) { add("c.ts_from <= ?::timestamptz", req.to); add("s.started_at <= ?::timestamptz", req.to); }
  return where.join(" and ");
}
const FROM = "from chunks c join sessions s on s.id = c.session_id join bindings b on b.id = s.binding_id";

/** Query words for full-text: letters/digits only (safe in to_tsquery), stop words dropped. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : words)].slice(0, 16);
}

const isTimeout = (e: unknown) => pgState(e) === "57014";

async function ftsLeg(sql: SQL, scope: SearchScope, req: SearchRequest, terms: string[]) {
  if (!terms.length) return [];
  const run = (tsquery: string) => sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${LEG_TIMEOUT}'`);
    const params: unknown[] = [tsquery];
    const where = scopeClause(scope, req, params);
    return tx.unsafe(
      `with m as materialized (
         select c.id, c.tsv ${FROM} where ${where} and c.tsv @@ to_tsquery('cerebro', $1)
         order by c.id desc limit ${FTS_RANK_WINDOW})
       select id from m order by ts_rank_cd(tsv, to_tsquery('cerebro', $1)) desc, id desc limit ${CANDIDATES}`, params);
  });
  const all = await run(terms.join(" & "));
  return all.length ? all : run(terms.map((t) => `${t}:*`).join(" | "));
}

async function vectorLeg(sql: SQL, scope: SearchScope, req: SearchRequest, qvec: number[]) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${LEG_TIMEOUT}'`);
    const params: unknown[] = [];
    const where = scopeClause(scope, req, params);
    const [{ n }] = await tx.unsafe(
      `select count(*)::int as n from (select 1 ${FROM} join chunk_embeddings e on e.chunk_id = c.id where ${where} limit ${EXACT_SCAN_MAX + 1}) x`, params);
    params.push(toVector(qvec));
    const q = `$${params.length}::text::halfvec`;
    let rows;
    if (n <= EXACT_SCAN_MAX) {
      // Exact: the materialised CTE keeps the planner from post-filtering an HNSW scan.
      rows = await tx.unsafe(
        `with cand as materialized (select c.id, e.embedding ${FROM} join chunk_embeddings e on e.chunk_id = c.id where ${where})
         select id, embedding <=> ${q} as distance from cand order by distance, id limit ${CANDIDATES}`, params);
    } else {
      await tx.unsafe("set local hnsw.ef_search = 100");
      await tx.unsafe("set local hnsw.iterative_scan = 'relaxed_order'");
      rows = await tx.unsafe(
        `select c.id, e.embedding <=> ${q} as distance ${FROM} join chunk_embeddings e on e.chunk_id = c.id
         where ${where} order by e.embedding <=> ${q} limit ${CANDIDATES}`, params);
    }
    return [...rows].sort((a: any, b: any) => a.distance - b.distance || Number(a.id) - Number(b.id));
  });
}

/** Embeds the query with a hard timeout that also cancels the request, ahead of the worker. */
async function embedQuery(embedder: Embedder, query: string, timeoutMs: number, gate?: EmbedGate): Promise<number[]> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  gate?.enter();
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => { ctrl.abort(); rej(new EmbedderError("query embedding timed out")); }, timeoutMs);
    });
    const [v] = await Promise.race([embedder.embed([query], ctrl.signal), timeout]);
    return v;
  } finally {
    clearTimeout(timer);
    gate?.leave();
  }
}

/**
 * Hybrid search: full-text (stop words dropped, AND then OR-prefix fallback, bounded ranking)
 * and vector (exact for small scopes, HNSW otherwise), merged by reciprocal-rank fusion.
 * Each leg degrades on its own: the response says which part was missing.
 */
export async function search(
  sql: SQL, embedder: Embedder, req: SearchRequest, opts: { embedTimeoutMs?: number; gate?: EmbedGate } = {},
): Promise<SearchResponse> {
  const { scope, binding } = await scopeFor(sql, req);
  const query = req.query.replaceAll("\u0000", " ").trim();
  const base = { scope: scope.kind, binding } as const;
  if (!query) return { ...base, hits: [], degraded: false, degradedReasons: [] };
  const limit = Math.min(req.limit ?? 10, 50);
  const reasons: SearchResponse["degradedReasons"] = [];

  const vecPromise = embedQuery(embedder, query, opts.embedTimeoutMs ?? 3000, opts.gate)
    .then((qvec) => vectorLeg(sql, scope, req, qvec))
    .catch((e) => {
      if (e instanceof EmbedderError) reasons.push("embedder");
      else if (isTimeout(e)) reasons.push("vector_timeout");
      else throw e;
      return [] as any[];
    });
  const ftsPromise = ftsLeg(sql, scope, req, queryTerms(query)).catch((e) => {
    if (isTimeout(e)) { reasons.push("fts_timeout"); return [] as any[]; }
    throw e;
  });
  const [fts, vec] = await Promise.all([ftsPromise, vecPromise]);

  const fused = new Map<number, { score: number; matched: Set<"fts" | "vec">; distance: number | null }>();
  const add = (id: number, rank: number, leg: "fts" | "vec", distance: number | null) => {
    const f = fused.get(id) ?? { score: 0, matched: new Set(), distance: null };
    f.score += 1 / (RRF_K + rank + 1);
    f.matched.add(leg);
    if (distance !== null) f.distance = distance;
    fused.set(id, f);
  };
  fts.forEach((r: any, i: number) => add(Number(r.id), i, "fts", null));
  vec.forEach((r: any, i: number) => add(Number(r.id), i, "vec", Number(r.distance)));
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || b[0] - a[0]);
  if (!ranked.length) return { ...base, hits: [], degraded: reasons.length > 0, degradedReasons: reasons };

  const terms = queryTerms(query);
  const rows = await sql.unsafe(
    `select c.id, c.session_id, c.first_seq, c.last_seq, c.ts_from, c.ts_to,
            case when $1 <> '' and c.tsv @@ to_tsquery('cerebro', $1)
                 then ts_headline('cerebro', left(c.text, 4000), to_tsquery('cerebro', $1))
                 else left(c.text, 300) end as snippet,
            cl.name as client_name, p.name as project_name
     from chunks c join sessions s on s.id = c.session_id join bindings b on b.id = s.binding_id
     left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
     where c.id = any($2::bigint[])`,
    [terms.map((t) => `${t}:*`).join(" | "), ranked.slice(0, limit * 4).map(([id]) => id)]);
  const byId = new Map(rows.map((r: any) => [Number(r.id), r]));

  // Windows of one long message share (session, seq range); keep the best-ranked one.
  const seen = new Set<string>();
  const hits: SearchResponse["hits"] = [];
  for (const [id, f] of ranked) {
    const r: any = byId.get(id);
    if (!r) continue;
    const k = `${r.session_id}:${r.first_seq}:${r.last_seq}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const hit: SearchHit = {
      chunkId: id, sessionId: r.session_id, firstSeq: r.first_seq, lastSeq: r.last_seq,
      tsFrom: r.ts_from.toISOString(), tsTo: r.ts_to.toISOString(), snippet: r.snippet, score: f.score,
      clientName: r.client_name, projectName: r.project_name,
    };
    hits.push({ ...hit, matched: [...f.matched], distance: f.distance });
    if (hits.length >= limit) break;
  }
  return { ...base, hits, degraded: reasons.length > 0, degradedReasons: reasons };
}
