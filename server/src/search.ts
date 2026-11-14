import type { SQL } from "bun";
import type { SearchHit, SearchRequest, SearchScope } from "@cerebro/shared";
import { resolveBinding } from "./bindings";
import { EmbedderError, type Embedder } from "./embed/embedder";
import { toVector } from "./embed/embedder";

const CANDIDATES = 50;
const RRF_K = 60;

/** A project-bound folder is locked to its project; anything else may search openly. */
export async function scopeFor(sql: SQL, req: SearchRequest): Promise<SearchScope> {
  if (req.repo) {
    const b = await resolveBinding(sql, req.repo, req.subpath ?? "");
    if (b && b.status === "active" && b.projectId) return { kind: "project", projectId: b.projectId };
  }
  return { kind: "open", clientId: req.clientId, projectId: req.projectId };
}

/**
 * Hybrid search (full-text + vector, merged by reciprocal-rank fusion). If the embedder is
 * unavailable, falls back to full-text only and reports `degraded: true`.
 */
export async function search(
  sql: SQL, embedder: Embedder, req: SearchRequest, opts: { embedTimeoutMs?: number } = {},
): Promise<{ scope: SearchScope; hits: SearchHit[]; degraded: boolean }> {
  const scope = await scopeFor(sql, req);
  const query = req.query.trim();
  if (!query) return { scope, hits: [], degraded: false };
  const limit = Math.min(req.limit ?? 10, 50);
  let qvec: number[] | null = null;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new EmbedderError("query embedding timed out")), opts.embedTimeoutMs ?? 3000);
    });
    try {
      [qvec] = await Promise.race([embedder.embed([query]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (!(e instanceof EmbedderError)) throw e;
    console.error(`search: embedder unavailable, full-text only: ${e.message}`);
  }

  const where: string[] = [];
  const params: unknown[] = [query];
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
  if (scope.kind === "project") add("b.project_id = ?", scope.projectId);
  else {
    if (scope.clientId) add("b.client_id = ?", scope.clientId);
    if (scope.projectId) add("b.project_id = ?", scope.projectId);
  }
  if (req.from) add("c.ts_to >= ?::timestamptz", req.from);
  if (req.to) add("c.ts_from <= ?::timestamptz", req.to);
  const scoped = `from chunks c join sessions s on s.id = c.session_id join bindings b on b.id = s.binding_id
                  where true${where.map((w) => ` and ${w}`).join("")}`;

  return sql.begin(async (tx) => {
    await tx`set local hnsw.iterative_scan = 'relaxed_order'`;
    const fts = await tx.unsafe(
      `select c.id ${scoped} and c.tsv @@ websearch_to_tsquery('simple', $1)
       order by ts_rank(c.tsv, websearch_to_tsquery('simple', $1)) desc limit ${CANDIDATES}`, params);
    let vec: any[] = [];
    if (qvec) {
      params.push(toVector(qvec));
      vec = await tx.unsafe(
      // $1 (the query text) is unused here but shares the parameter list; reference it so Postgres can type it.
      `select c.id ${scoped} and $1::text is not null
       order by c.embedding <=> $${params.length}::text::vector limit ${CANDIDATES}`, params);
    }

    const score = new Map<number, number>();
    for (const list of [fts, vec]) {
      list.forEach((r: any, i: number) => score.set(Number(r.id), (score.get(Number(r.id)) ?? 0) + 1 / (RRF_K + i + 1)));
    }
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (!top.length) return { scope, hits: [], degraded: !qvec };

    const rows = await tx.unsafe(
      `select c.id, c.session_id, c.first_seq, c.last_seq, c.ts_from, c.ts_to,
              case when c.tsv @@ websearch_to_tsquery('simple', $1)
                   then ts_headline('simple', c.text, websearch_to_tsquery('simple', $1))
                   else left(c.text, 300) end as snippet,
              cl.name as client_name, p.name as project_name
       from chunks c join sessions s on s.id = c.session_id join bindings b on b.id = s.binding_id
       left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
       where c.id = any($2::bigint[])`, [query, top.map(([id]) => id)]);
    const byId = new Map(rows.map((r: any) => [Number(r.id), r]));
    const hits: SearchHit[] = top.map(([id, s]) => {
      const r: any = byId.get(id);
      return {
        chunkId: id, sessionId: r.session_id, firstSeq: r.first_seq, lastSeq: r.last_seq,
        tsFrom: r.ts_from.toISOString(), tsTo: r.ts_to.toISOString(), snippet: r.snippet, score: s,
        clientName: r.client_name, projectName: r.project_name,
      };
    });
    return { scope, hits, degraded: !qvec };
  });
}
