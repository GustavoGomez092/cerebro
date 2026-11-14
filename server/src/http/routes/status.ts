import { Hono } from "hono";
import type { AppDeps, Env } from "../app";

export function statusRoutes({ sql, workerState }: AppDeps) {
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
      },
      dbBytes: bytes,
    });
  });
  return r;
}
