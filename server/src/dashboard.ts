// Read-only queries behind the web dashboard (/v1/dashboard/*) and the chat agent's tools. Every one is unscoped:
// the dashboard sees all clients. Only the web-ui token reaches them (see app.ts).
import type { SQL } from "bun";
import type { SearchResponse } from "@cerebro/shared";
import { search } from "./search";
import { embedderFor, type Embedder } from "./embed/embedder";
import type { EmbedGate } from "./worker";
import type { Metrics } from "./metrics";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** pg_database_size and exact row counts of the main tables. */
export async function dbStats(sql: SQL) {
  const [r] = await sql`
    select pg_database_size(current_database())::float8 as bytes,
           (select count(*) from sessions)::float8 as sessions,
           (select count(*) from events)::float8 as events,
           (select count(*) from chunks)::float8 as chunks,
           (select count(*) from summaries)::float8 as summaries,
           (select count(*) from clients)::float8 as clients,
           (select count(*) from projects)::float8 as projects`;
  const { bytes, ...counts } = r;
  return { bytes: bytes as number, counts: counts as Record<"sessions" | "events" | "chunks" | "summaries" | "clients" | "projects", number> };
}

export interface MachineSessions { machine: string; sessions: number; lastActivityAt: string | null }
export interface ProjectOverview { id: string | null; name: string; sessions: number; lastActivityAt: string | null; machines: MachineSessions[] }
export interface ClientOverview { id: string; name: string; sessions: number; lastActivityAt: string | null; projects: ProjectOverview[] }

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Every client with its projects; for each, sessions per machine and the last activity (newest event, else
 * start). Counts sessions of active bindings, as search sees them. Sessions recorded for the client alone (a
 * folder bound with no project) appear under a project with `id: null`.
 */
export async function clientsOverview(sql: SQL): Promise<{ clients: ClientOverview[] }> {
  const [clients, projects, rows] = await Promise.all([
    sql`select id, name from clients order by lower(name), id`,
    sql`select id, client_id, name from projects order by lower(name), id`,
    sql`select b.client_id, b.project_id, m.name as machine, count(*)::int as sessions,
               max(coalesce(s.last_event_at, s.started_at)) as last_at
        from sessions s join bindings b on b.id = s.binding_id join machines m on m.id = s.machine_id
        where b.status = 'active' and b.client_id is not null
        group by b.client_id, b.project_id, m.name
        order by m.name`,
  ]);
  const byClient = new Map<string, ClientOverview>();
  for (const c of clients) byClient.set(c.id, { id: c.id, name: c.name, sessions: 0, lastActivityAt: null, projects: [] });
  const byProject = new Map<string, ProjectOverview>();
  for (const p of projects) {
    const po: ProjectOverview = { id: p.id, name: p.name, sessions: 0, lastActivityAt: null, machines: [] };
    byProject.set(p.id, po);
    byClient.get(p.client_id)?.projects.push(po);
  }
  for (const r of rows) {
    const client = byClient.get(r.client_id);
    if (!client) continue;
    let project = r.project_id ? byProject.get(r.project_id) : client.projects.find((p) => p.id === null);
    if (!project) {
      project = { id: null, name: "(no project)", sessions: 0, lastActivityAt: null, machines: [] };
      client.projects.push(project);
    }
    const last = iso(r.last_at);
    project.machines.push({ machine: r.machine, sessions: r.sessions, lastActivityAt: last });
    project.sessions += r.sessions;
    project.lastActivityAt = later(project.lastActivityAt, last);
    client.sessions += r.sessions;
    client.lastActivityAt = later(client.lastActivityAt, last);
  }
  return { clients: [...byClient.values()] };
}

const ACTIVITY_PREVIEW = 200;

/** What this database is running now (other backends, not idle), query text cut short. */
export async function databaseActivity(sql: SQL) {
  const rows = await sql`
    select pid, state, left(regexp_replace(query, '\\s+', ' ', 'g'), ${ACTIVITY_PREVIEW}) as query, query_start,
           extract(epoch from now() - query_start)::float8 as elapsed, wait_event_type, wait_event, application_name
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and state is not null and state <> 'idle'
    order by query_start nulls last`;
  return rows.map((r: any) => ({
    pid: r.pid, state: r.state, query: r.query, startedAt: iso(r.query_start),
    elapsedMs: r.elapsed === null ? null : Math.round(r.elapsed * 1000),
    wait: r.wait_event_type ? `${r.wait_event_type}:${r.wait_event}` : null,
  }));
}

/** Events, chunks (in-process counters) and summaries (database) per period, and the queue depths. */
export async function throughput(sql: SQL, metrics: Metrics, backlog: { live: number; imported: number; dead: number }) {
  const [r] = await sql`
    select (select count(*) from summaries where created_at > now() - interval '1 hour')::int as summaries,
           (select count(*) filter (where not dead) from embed_queue)::int as pending,
           (select count(*) filter (where dead) from embed_queue)::int as dead`;
  return {
    eventsPerMinute: metrics.events.sum(60_000),
    chunksEmbeddedPerMinute: metrics.chunks.sum(60_000),
    summariesLastHour: r.summaries as number,
    queues: { embed: { pending: r.pending as number, dead: r.dead as number }, summary: backlog },
  };
}

export type GlobalHit = SearchResponse["hits"][number] & { machine: string | null; cwd: string | null; repo: string | null };

/**
 * Hybrid search over every client and project (the open scope, explicitly), optionally narrowed to one client or
 * project by id. The query embeds as `machine`'s would (web-ui is never mapped, so on the Zima). Hits gain the
 * session's machine, cwd and repo.
 */
export async function globalSearch(
  deps: { sql: SQL; embedder: Embedder; gate?: EmbedGate; metrics: Metrics },
  machine: string,
  req: { query: string; limit?: number; include?: "all" | "summaries" | "raw"; from?: string; to?: string; clientId?: string; projectId?: string },
): Promise<{ scope: "open"; hits: GlobalHit[]; degraded: boolean; degradedReasons: SearchResponse["degradedReasons"] }> {
  const done = deps.metrics.trackSearch(req.query, machine);
  try {
    const r = await search(deps.sql, embedderFor(deps.embedder, machine), { ...req, scope: "open" }, { gate: deps.gate });
    const ids = [...new Set(r.hits.map((h) => h.sessionId).filter((s): s is string => !!s))];
    const sessions = new Map<string, any>(ids.length
      ? (await deps.sql`select s.id, s.cwd, s.repo, m.name as machine from sessions s join machines m on m.id = s.machine_id
                        where s.id = any(${deps.sql.array(ids, "text")})`).map((s: any) => [s.id, s])
      : []);
    const hits = r.hits.map((h) => {
      const s = h.sessionId ? sessions.get(h.sessionId) : undefined;
      return { ...h, machine: s?.machine ?? null, cwd: s?.cwd ?? null, repo: s?.repo ?? null };
    });
    return { scope: "open", hits, degraded: r.degraded, degradedReasons: r.degradedReasons };
  } finally {
    done();
  }
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A session (client, project, machine, folder, times) and its summaries, oldest range first. Null if unknown. */
export async function sessionSummaries(sql: SQL, sessionId: string) {
  const [s] = await sql`
    select s.id, s.cwd, s.repo, s.started_at, s.last_event_at, s.ended_at, m.name as machine, cl.name as client_name, p.name as project_name
    from sessions s join machines m on m.id = s.machine_id join bindings b on b.id = s.binding_id
    left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
    where s.id = ${sessionId}`;
  if (!s) return null;
  const rows = await sql`
    select id, first_seq, last_seq, ts_from, ts_to, title, body from summaries
    where session_id = ${sessionId} and kind = 'session' order by first_seq, id`;
  return {
    session: {
      id: s.id, cwd: s.cwd, repo: s.repo, machine: s.machine, clientName: s.client_name, projectName: s.project_name,
      startedAt: iso(s.started_at), lastEventAt: iso(s.last_event_at), endedAt: iso(s.ended_at),
    },
    summaries: rows.map((r: any) => ({
      id: Number(r.id), firstSeq: r.first_seq, lastSeq: r.last_seq, tsFrom: iso(r.ts_from), tsTo: iso(r.ts_to), title: r.title,
      overview: typeof r.body?.overview === "string" ? r.body.overview : "",
      decisions: listOf(r.body?.decisions), changes: listOf(r.body?.changes), facts: listOf(r.body?.facts),
      openThreads: listOf(r.body?.open_threads),
    })),
  };
}
