import { Hono } from "hono";
import type { SQL } from "bun";
import type { AppDeps, Env } from "../app";
import { budgetState } from "../../summarise/budget";

/** The summariser's state with its backlog (summary jobs) and budget window, or null when not configured. */
/** Summary jobs waiting: live (priority 0), imported, and dead-lettered. */
export async function summaryBacklog(sql: SQL): Promise<{ live: number; imported: number; dead: number }> {
  const [jobs] = await sql`
    select count(*) filter (where not dead and priority = 0)::int as live,
           count(*) filter (where not dead and priority <> 0)::int as imported,
           count(*) filter (where dead)::int as dead
    from summary_jobs`;
  return { live: jobs.live, imported: jobs.imported, dead: jobs.dead };
}

async function summariserStatus(sql: SQL, s: AppDeps["summariser"]) {
  if (!s) return null;
  const jobs = await summaryBacklog(sql);
  const b = await budgetState(sql, s.budget);
  const { enabled, paused, lastRunAt, lastError, credentialExpiresAt } = s.state;
  return {
    enabled, paused, lastRunAt, lastError, credentialExpiresAt,
    backlog: { live: jobs.live, imported: jobs.imported, dead: jobs.dead },
    budget: { used: b.used, limit: b.limit, resumesAt: b.resumesAt?.toISOString() ?? null },
  };
}

/**
 * Where embeddings are made: each machine's endpoint (EMBED_MACHINE_URLS) and the fallback (EMBED_URL). URLs only.
 * `known`: the mapped name is a machine with a live token (a typo would leave that Mac's work on the Zima).
 */
async function routingStatus(sql: SQL, embedder: AppDeps["embedder"]) {
  const s = embedder.status?.();
  if (!s) return { endpoints: [], fallback: null };
  const names = s.endpoints.map((e) => e.machine).filter((m): m is string => m !== null);
  const known = new Set(names.length
    ? (await sql`select name from machines where revoked_at is null and name = any(${sql.array(names, "text")})`).map((r: any) => r.name)
    : []);
  return { ...s, endpoints: s.endpoints.map(({ machine, ...rest }) => ({ machine, known: machine !== null && known.has(machine), ...rest })) };
}

/** Everything /v1/status reports except the calling machine; the dashboard shows the same object. */
export async function computeStatus({ sql, embedder, workerState, summariser }: AppDeps) {
  const [q] = await sql`
    select count(*) filter (where not dead)::int as pending,
           count(*) filter (where dead)::int as dead,
           coalesce(extract(epoch from now() - min(c.ts_to) filter (where not q.dead)), 0)::float8 as oldest,
           coalesce(extract(epoch from now() - min(q.enqueued_at) filter (where not q.dead and q.priority = 0)), 0)::float8 as wait_live,
           coalesce(extract(epoch from now() - min(q.enqueued_at) filter (where not q.dead and q.priority <> 0)), 0)::float8 as wait_imported
    from embed_queue q join chunks c on c.id = q.chunk_id`;
  const [{ bytes }] = await sql`select pg_database_size(current_database())::float8 as bytes`;
  return {
    queue: {
      pending: q.pending, dead: q.dead, oldestPendingSeconds: Math.round(q.oldest),
      // How long the oldest live / imported chunk has waited in the queue (0: none waiting).
      oldestWaitSeconds: { live: Math.round(q.wait_live), imported: Math.round(q.wait_imported) },
    },
    embedder: {
      lastSuccessAt: workerState?.lastSuccessAt ?? null,
      lastError: workerState?.lastError ?? null,
      pausedUntil: workerState && workerState.pausedUntil > Date.now() ? new Date(workerState.pausedUntil).toISOString() : null,
      lanes: workerState?.lanes ?? {},
      ...(await routingStatus(sql, embedder)),
    },
    summariser: await summariserStatus(sql, summariser),
    dbBytes: bytes as number,
  };
}

export function statusRoutes(deps: AppDeps) {
  const r = new Hono<Env>();
  r.get("/status", async (c) => c.json({ machine: c.get("machine").name, ...(await computeStatus(deps)) }));
  return r;
}
