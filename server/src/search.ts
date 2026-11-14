import type { SQL } from "bun";
import type { Binding, SearchHit, SearchRequest, SearchResponse, SearchScope } from "@cerebro/shared";
import { resolveBinding } from "./bindings";
import { EmbedderError, toVector, type Embedder } from "./embed/embedder";
import type { EmbedGate } from "./worker";
import { pgState } from "./db";

const CANDIDATES = 50;
const RRF_K = 60;
/** Scopes with at most this many embedded rows get an exact scan (HNSW post-filtering loses recall). */
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
 * folder the caller must ask for the open scope explicitly. `binding` is the folder's most specific
 * binding (any status); `active` is the binding that set the scope.
 */
export async function scopeFor(sql: SQL, req: { repo?: string; subpath?: string; scope?: "open"; clientId?: string; projectId?: string }):
  Promise<{ scope: SearchScope; binding: Binding | null; active: Binding | null }> {
  if (!req.repo && req.scope !== "open") throw new ScopeError("send the folder's repo (and subpath), or scope: \"open\"");
  if (req.repo) {
    const binding = await resolveBinding(sql, req.repo, req.subpath ?? "");
    const active = binding?.status === "active" ? binding : await resolveBinding(sql, req.repo, req.subpath ?? "", { activeOnly: true });
    if (active?.projectId) return { scope: { kind: "project", projectId: active.projectId }, binding, active };
    return { scope: { kind: "open", clientId: req.clientId, projectId: req.projectId }, binding, active };
  }
  return { scope: { kind: "open", clientId: req.clientId, projectId: req.projectId }, binding: null, active: null };
}

type DateWindow = { from?: string; to?: string };

/** Appends a condition whose `?` placeholders all take the next positional parameter. */
const condAdder = (params: unknown[], where: string[]) => (cond: string, v: unknown) => {
  params.push(v);
  where.push(cond.replaceAll("?", `$${params.length}`));
};

/** Builds the chunks' WHERE clause: active bindings only, scope, and date window. */
function scopeClause(scope: SearchScope, req: DateWindow, params: unknown[]): string {
  const where = ["b.status = 'active'"];
  const add = condAdder(params, where);
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

/** Summaries (`sm`) with their folder's binding (`b`) and, for session summaries, the session (`ss`). */
export const SUMMARY_FROM = "from summaries sm join bindings b on b.id = sm.binding_id left join sessions ss on ss.id = sm.session_id";

/**
 * WHERE clause for summaries visible in a scope (use with SUMMARY_FROM), filtered on the summary's own
 * client and project. Its binding must be active and agree with those columns, and a session summary's
 * session must still belong to that binding. Re-binds and moves keep the columns current; if a summary
 * ever lags behind (it describes work now in another scope) it is hidden rather than shown in the old one.
 */
export function summaryScopeClause(scope: SearchScope, req: DateWindow, params: unknown[]): string {
  const where = [
    "b.status = 'active'",
    "b.client_id = sm.client_id",
    "b.project_id is not distinct from sm.project_id",
    "(sm.session_id is null or ss.binding_id = sm.binding_id)",
  ];
  const add = condAdder(params, where);
  if (scope.kind === "project") add("sm.project_id = ?", scope.projectId);
  else {
    if (scope.clientId) add("sm.client_id = ?", scope.clientId);
    if (scope.projectId) add("sm.project_id = ?", scope.projectId);
  }
  if (req.from) add("sm.ts_to >= ?::timestamptz", req.from);
  if (req.to) add("sm.ts_from <= ?::timestamptz", req.to);
  return where.join(" and ");
}

/** What a search leg reads: raw chunks or summaries, each with its own indexes and scope rules. */
interface Source {
  from: string;
  id: string;
  tsv: string;
  embeddings: string;
  where: (scope: SearchScope, req: DateWindow, params: unknown[]) => string;
}
const CHUNKS: Source = { from: FROM, id: "c.id", tsv: "c.tsv", embeddings: "join chunk_embeddings e on e.chunk_id = c.id", where: scopeClause };
const SUMMARIES: Source = {
  from: SUMMARY_FROM, id: "sm.id", tsv: "sm.tsv", embeddings: "join summary_embeddings e on e.summary_id = sm.id", where: summaryScopeClause,
};

/** Query words for full-text: letters/digits only (safe in to_tsquery), stop words dropped. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return [...new Set(kept.length ? kept : words)].slice(0, 16);
}

const isTimeout = (e: unknown) => pgState(e) === "57014";

async function ftsLeg(sql: SQL, src: Source, scope: SearchScope, req: SearchRequest, terms: string[]) {
  if (!terms.length) return [];
  const run = (tsquery: string) => sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${LEG_TIMEOUT}'`);
    const params: unknown[] = [tsquery];
    const where = src.where(scope, req, params);
    return tx.unsafe(
      `with m as materialized (
         select ${src.id} as id, ${src.tsv} as tsv ${src.from} where ${where} and ${src.tsv} @@ to_tsquery('cerebro', $1)
         order by ${src.id} desc limit ${FTS_RANK_WINDOW})
       select id from m order by ts_rank_cd(tsv, to_tsquery('cerebro', $1)) desc, id desc limit ${CANDIDATES}`, params);
  });
  const all = await run(terms.join(" & "));
  return all.length ? all : run(terms.map((t) => `${t}:*`).join(" | "));
}

async function vectorLeg(sql: SQL, src: Source, scope: SearchScope, req: SearchRequest, qvec: number[]) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${LEG_TIMEOUT}'`);
    const params: unknown[] = [];
    const where = src.where(scope, req, params);
    const [{ n }] = await tx.unsafe(
      `select count(*)::int as n from (select 1 ${src.from} ${src.embeddings} where ${where} limit ${EXACT_SCAN_MAX + 1}) x`, params);
    params.push(toVector(qvec));
    const q = `$${params.length}::text::halfvec`;
    let rows;
    if (n <= EXACT_SCAN_MAX) {
      // Exact: the materialised CTE keeps the planner from post-filtering an HNSW scan.
      rows = await tx.unsafe(
        `with cand as materialized (select ${src.id} as id, e.embedding ${src.from} ${src.embeddings} where ${where})
         select id, embedding <=> ${q} as distance from cand order by distance, id limit ${CANDIDATES}`, params);
    } else {
      await tx.unsafe("set local hnsw.ef_search = 100");
      await tx.unsafe("set local hnsw.iterative_scan = 'relaxed_order'");
      rows = await tx.unsafe(
        `select ${src.id} as id, e.embedding <=> ${q} as distance ${src.from} ${src.embeddings}
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

type HitKind = SearchHit["kind"];
type Reason = SearchResponse["degradedReasons"][number];

/**
 * Hybrid search over raw chunks and summaries. Each gets full-text (stop words dropped, AND then
 * OR-prefix fallback, bounded ranking) and vector (exact for small scopes, HNSW otherwise) legs; all
 * legs are merged by reciprocal-rank fusion, summaries first on ties. The query is embedded once.
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
  const include = req.include ?? "all";
  const terms = queryTerms(query);
  const reasons: Reason[] = [];

  const qvec = embedQuery(embedder, query, opts.embedTimeoutMs ?? 3000, opts.gate).catch((e) => {
    if (e instanceof EmbedderError) { reasons.push("embedder"); return null; }
    throw e;
  });
  const leg = (p: Promise<any[]>, timeout: Reason) => p.catch((e) => {
    if (isTimeout(e)) { reasons.push(timeout); return [] as any[]; }
    throw e;
  });
  const legs = (src: Source, ftsTimeout: Reason, vecTimeout: Reason) => [
    leg(ftsLeg(sql, src, scope, req, terms), ftsTimeout),
    leg(qvec.then((v) => (v ? vectorLeg(sql, src, scope, req, v) : [])), vecTimeout),
  ];
  const skipped = [Promise.resolve([] as any[]), Promise.resolve([] as any[])];
  const [chunkFts, chunkVec, summaryFts, summaryVec] = await Promise.all([
    ...(include === "summaries" ? skipped : legs(CHUNKS, "fts_timeout", "vector_timeout")),
    ...(include === "raw" ? skipped : legs(SUMMARIES, "summary_fts_timeout", "summary_vector_timeout")),
  ]);

  type Fused = { kind: HitKind; id: number; score: number; matched: Set<"fts" | "vec">; distance: number | null };
  const fused = new Map<string, Fused>();
  const add = (kind: HitKind, id: number, rank: number, leg: "fts" | "vec", distance: number | null) => {
    const key = `${kind}:${id}`;
    const f = fused.get(key) ?? { kind, id, score: 0, matched: new Set(), distance: null };
    f.score += 1 / (RRF_K + rank + 1);
    f.matched.add(leg);
    if (distance !== null) f.distance = distance;
    fused.set(key, f);
  };
  chunkFts.forEach((r: any, i: number) => add("chunk", Number(r.id), i, "fts", null));
  chunkVec.forEach((r: any, i: number) => add("chunk", Number(r.id), i, "vec", Number(r.distance)));
  summaryFts.forEach((r: any, i: number) => add("summary", Number(r.id), i, "fts", null));
  summaryVec.forEach((r: any, i: number) => add("summary", Number(r.id), i, "vec", Number(r.distance)));
  const kindOrder = (k: HitKind) => (k === "summary" ? 0 : 1);
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || kindOrder(a.kind) - kindOrder(b.kind) || b.id - a.id);
  // Legs finish in any order; a sorted list keeps the response stable.
  const degraded = { degraded: reasons.length > 0, degradedReasons: reasons.sort() };
  if (!ranked.length) return { ...base, hits: [], ...degraded };

  const top = ranked.slice(0, limit * 4);
  const idsOf = (kind: HitKind) => top.filter((f) => f.kind === kind).map((f) => f.id);
  const headlineQuery = terms.map((t) => `${t}:*`).join(" | ");
  const snippet = (alias: string) =>
    `case when $1 <> '' and ${alias}.tsv @@ to_tsquery('cerebro', $1)
          then ts_headline('cerebro', left(${alias}.text, 4000), to_tsquery('cerebro', $1))
          else left(${alias}.text, 300) end as snippet`;
  const chunkIds = idsOf("chunk"), summaryIds = idsOf("summary");
  const none = Promise.resolve([] as any[]);
  const [chunkRows, summaryRows] = await Promise.all([
    !chunkIds.length ? none : sql.unsafe(
      `select c.id, c.session_id, c.first_seq, c.last_seq, c.ts_from, c.ts_to, ${snippet("c")},
              cl.name as client_name, p.name as project_name
       from chunks c join sessions s on s.id = c.session_id join bindings b on b.id = s.binding_id
       left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
       where c.id = any($2::bigint[])`,
      [headlineQuery, chunkIds]),
    !summaryIds.length ? none : sql.unsafe(
      `select sm.id, sm.session_id, sm.first_seq, sm.last_seq, sm.ts_from, sm.ts_to, sm.title, ${snippet("sm")},
              cl.name as client_name, p.name as project_name
       from summaries sm left join clients cl on cl.id = sm.client_id left join projects p on p.id = sm.project_id
       where sm.id = any($2::bigint[])`,
      [headlineQuery, summaryIds]),
  ]);
  const rowsByKind: Record<HitKind, Map<number, any>> = {
    chunk: new Map(chunkRows.map((r: any) => [Number(r.id), r])),
    summary: new Map(summaryRows.map((r: any) => [Number(r.id), r])),
  };

  // Windows of one long message share (session, seq range); keep the best-ranked one.
  const seen = new Set<string>();
  const hits: SearchResponse["hits"] = [];
  for (const f of ranked) {
    const r = rowsByKind[f.kind].get(f.id);
    if (!r) continue;
    if (f.kind === "chunk") {
      const k = `${r.session_id}:${r.first_seq}:${r.last_seq}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const hit: SearchHit = {
      kind: f.kind, ...(f.kind === "chunk" ? { chunkId: f.id } : { summaryId: f.id }),
      sessionId: r.session_id, firstSeq: r.first_seq, lastSeq: r.last_seq,
      tsFrom: r.ts_from.toISOString(), tsTo: r.ts_to.toISOString(),
      snippet: f.kind === "summary" ? `${r.title} — ${r.snippet}` : r.snippet, score: f.score,
      clientName: r.client_name, projectName: r.project_name,
    };
    hits.push({ ...hit, matched: [...f.matched], distance: f.distance });
    if (hits.length >= limit) break;
  }
  return { ...base, hits, ...degraded };
}
