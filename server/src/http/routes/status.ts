import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppDeps, Env } from "../app";
import { budgetState } from "../../summarise/budget";

/** The summariser's state with its backlog (summary jobs) and budget window, or null when not configured. */
async function summariserStatus(sql: SQL, s: AppDeps["summariser"]) {
  if (!s) return null;
  const [jobs] = await sql`
    select count(*) filter (where not dead and priority = 0)::int as live,
           count(*) filter (where not dead and priority <> 0)::int as imported,
           count(*) filter (where dead)::int as dead
    from summary_jobs`;
  const b = await budgetState(sql, s.budget);
  const { enabled, paused, lastRunAt, lastError, credentialExpiresAt } = s.state;
  return {
    enabled, paused, lastRunAt, lastError, credentialExpiresAt,
    backlog: { live: jobs.live, imported: jobs.imported, dead: jobs.dead },
    budget: { used: b.used, limit: b.limit, resumesAt: b.resumesAt?.toISOString() ?? null },
  };
}

/** Where embeddings are made (EMBED_PRIMARY_URL / EMBED_URL); URLs only, credentials already stripped. */
function routingStatus(embedder: AppDeps["embedder"]) {
  return embedder.routing?.() ?? {
    primary: { url: null, state: "unset", lastError: null, downUntil: null }, fallback: null, lastUsed: null,
  };
}

export function statusRoutes({ sql, embedder, workerState, summariser }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/status", async (c) => {
    const [q] = await sql`
      select count(*) filter (where not dead)::int as pending,
             count(*) filter (where dead)::int as dead,
             coalesce(extract(epoch from now() - min(c.ts_to) filter (where not q.dead)), 0)::float8 as oldest
      from embed_queue q join chunks c on c.id = q.chunk_id`;
    const [{ bytes }] = await sql`select pg_database_size(current_database())::float8 as bytes`;
    return c.json({
      machine: c.get("machine").name,
      queue: { pending: q.pending, dead: q.dead, oldestPendingSeconds: Math.round(q.oldest) },
      embedder: {
        lastSuccessAt: workerState?.lastSuccessAt ?? null,
        lastError: workerState?.lastError ?? null,
        pausedUntil: workerState && workerState.pausedUntil > Date.now() ? new Date(workerState.pausedUntil).toISOString() : null,
        ...routingStatus(embedder),
      },
      summariser: await summariserStatus(sql, summariser),
      dbBytes: bytes,
    });
  });
  return r;
}
