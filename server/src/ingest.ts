import type { SQL } from "bun";
import { z } from "zod";
import {
  INGEST_LIMITS, depth, mapStrings, normalizeIdentity, pathIdentityMachine, redactSecrets, storable,
  type IngestRejection, type IngestResult,
} from "@cerebro/shared";
import { normalizeSubpath, BindingError } from "./bindings";
import type { ChunkInput } from "./chunker";
import { storeChunks } from "./chunk-store";
import type { Machine } from "./auth";
import { enqueueSummary } from "./summarise/jobs";

const MIN_YEAR = 1970, MAX_YEAR = 2200;
const iso = z.string().datetime({ offset: true }).refine((s) => {
  const y = new Date(s).getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR;
}, "timestamp out of range");

const sessionSchema = z.object({
  id: z.string().min(1).max(200),
  bindingId: z.string().uuid(),
  cwd: z.string().max(4000),
  repo: z.string().min(1).max(1000),
  subpath: z.string().max(1000).optional(),
  startedAt: iso,
  imported: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const eventSchema = z.object({
  key: z.string().min(1).max(500),
  sessionId: z.string().min(1).max(200),
  seq: z.number().int().min(0).max(2_147_483_647),
  ts: iso,
  kind: z.enum(["user", "assistant", "tool_call", "tool_result"]),
  text: z.string(),
  toolName: z.string().max(200).optional(),
  toolInput: z.unknown().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SESSION_KEYS = new Set(Object.keys(sessionSchema.shape));
const EVENT_KEYS = new Set(Object.keys(eventSchema.shape));

/** Unknown top-level fields plus an explicit `meta` object, merged into one meta record. */
function metaOf(obj: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(obj).filter(([k]) => !known.has(k)));
  return { ...extra, ...((obj.meta as Record<string, unknown>) ?? {}) };
}

const clean = (v: unknown) => mapStrings(v, (s) => redactSecrets(storable(s)));
const strOrNull = (v: unknown) => (typeof v === "string" ? storable(v) : null);

/**
 * Validates and stores a batch item by item: bad sessions/events are reported in `rejected`
 * and everything else is committed. New events are chunked and queued for embedding in the
 * same transaction, so they are full-text searchable at once. Replays are harmless.
 */
export async function ingestBatch(
  sql: SQL, machine: Machine, batch: { sessions: unknown[]; events: unknown[] },
): Promise<IngestResult> {
  const rejected: IngestRejection[] = [];

  // --- sessions -----------------------------------------------------------------------------
  const sessions: any[] = [];
  for (const raw of batch.sessions) {
    const id = strOrNull((raw as any)?.id);
    // Depth first: everything below walks the value recursively.
    if (depth(raw, INGEST_LIMITS.maxDepth + 2) > INGEST_LIMITS.maxDepth + 1) { rejected.push({ sessionId: id ?? "", code: "invalid_session" }); continue; }
    const p = sessionSchema.safeParse(raw);
    if (!p.success) { rejected.push({ sessionId: id ?? "", code: "invalid_session" }); continue; }
    const s = p.data;
    const owner = pathIdentityMachine(s.repo);
    if (owner !== null && owner !== machine.name) { rejected.push({ sessionId: storable(s.id), code: "foreign_path_identity" }); continue; }
    let subpath: string;
    try { subpath = normalizeSubpath(storable(s.subpath ?? "")); } catch (e) {
      if (e instanceof BindingError) { rejected.push({ sessionId: storable(s.id), code: "invalid_session" }); continue; }
      throw e;
    }
    sessions.push({
      id: storable(s.id), binding_id: s.bindingId, cwd: storable(s.cwd), repo: normalizeIdentity(storable(s.repo)), subpath,
      started_at: s.startedAt, imported: s.imported ?? false, meta: clean(metaOf(s, SESSION_KEYS)),
    });
  }

  // --- events -------------------------------------------------------------------------------
  const events: any[] = [];
  for (const raw of batch.events) {
    const key = strOrNull((raw as any)?.key), sessionId = strOrNull((raw as any)?.sessionId);
    // Depth first (the event object itself is one level): everything below walks values recursively.
    if (depth(raw, INGEST_LIMITS.maxDepth + 2) > INGEST_LIMITS.maxDepth + 1) { rejected.push({ key, sessionId, code: "too_deep" }); continue; }
    const p = eventSchema.safeParse(raw);
    if (!p.success) { rejected.push({ key, sessionId, code: "invalid_event" }); continue; }
    const e = p.data;
    events.push({
      session_id: storable(e.sessionId), key: storable(e.key), seq: e.seq, ts: e.ts, kind: e.kind,
      text: clean(e.text) as string, tool_name: e.toolName === undefined ? null : storable(e.toolName),
      tool_input: e.toolInput === undefined ? null : clean(e.toolInput), meta: clean(metaOf(e, EVENT_KEYS)),
    });
  }
  events.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // The same session twice in one batch: keep the first, merge later metadata into it.
  const byId = new Map<string, any>();
  for (const s of sessions) {
    const prev = byId.get(s.id);
    if (prev) prev.meta = { ...prev.meta, ...s.meta };
    else byId.set(s.id, s);
  }
  sessions.length = 0;
  sessions.push(...byId.values());

  return sql.begin(async (tx) => {
    // Sessions whose binding is unknown are rejected; declined bindings are accepted (held).
    const bindingIds = [...new Set(sessions.map((s) => s.binding_id))];
    const known = new Set(bindingIds.length
      ? (await tx`select id from bindings where id = any(${tx.array(bindingIds, "uuid")})`).map((r: any) => r.id) : []);
    const goodSessions = sessions.filter((s) => {
      if (known.has(s.binding_id)) return true;
      rejected.push({ sessionId: s.id, code: "unknown_binding" });
      return false;
    });
    if (goodSessions.length) {
      await tx`
        insert into sessions (id, binding_id, machine_id, cwd, repo, subpath, started_at, imported, meta)
        select x.id, x.binding_id, ${machine.id}::uuid, x.cwd, x.repo, x.subpath, x.started_at, x.imported, x.meta
        from jsonb_to_recordset(${JSON.stringify(goodSessions)}::text::jsonb) as x(
          id text, binding_id uuid, cwd text, repo text, subpath text, started_at timestamptz, imported boolean, meta jsonb)
        order by x.id
        on conflict (id) do update set
          binding_id = case when sessions.last_event_at is null then excluded.binding_id else sessions.binding_id end,
          cwd = case when sessions.last_event_at is null then excluded.cwd else sessions.cwd end,
          repo = case when sessions.last_event_at is null then excluded.repo else sessions.repo end,
          subpath = case when sessions.last_event_at is null then excluded.subpath else sessions.subpath end,
          started_at = least(sessions.started_at, excluded.started_at),
          meta = sessions.meta || excluded.meta`;
    }

    const sessionIds = [...new Set(events.map((e) => e.session_id))];
    const existing = new Map<string, boolean>(sessionIds.length
      ? (await tx`select id, imported from sessions where id = any(${tx.array(sessionIds, "text")})`).map((r: any) => [r.id, r.imported]) : []);
    const storableEvents = events.filter((e) => {
      if (existing.has(e.session_id)) return true;
      rejected.push({ key: e.key, sessionId: e.session_id, code: "unknown_session" });
      return false;
    });

    const inserted = storableEvents.length ? await tx`
      insert into events (session_id, key, seq, ts, kind, text, tool_name, tool_input, meta)
      select x.session_id, x.key, x.seq, x.ts, x.kind, x.text, x.tool_name, x.tool_input, x.meta
      from jsonb_to_recordset(${JSON.stringify(storableEvents)}::text::jsonb) as x(
        session_id text, key text, seq integer, ts timestamptz, kind text, text text, tool_name text, tool_input jsonb, meta jsonb)
      on conflict (session_id, key) do nothing
      returning session_id, seq, ts, kind, text, tool_name, tool_input` : [];

    // Chunk what was newly stored, per session, and queue the chunks for embedding.
    const bySession = new Map<string, ChunkInput[]>();
    for (const r of inserted) {
      const list = bySession.get(r.session_id) ?? [];
      list.push({ seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, text: r.text, toolName: r.tool_name, toolInput: r.tool_input });
      bySession.set(r.session_id, list);
    }
    for (const [sessionId, list] of bySession) await storeChunks(tx, sessionId, list, existing.get(sessionId) ? 1 : 0);

    // Imported history is summarised at low priority as soon as its events arrive.
    for (const id of bySession.keys()) if (existing.get(id)) await enqueueSummary(tx, id, { priority: 1 });

    // Session bookkeeping: last activity only moves forward; later activity reopens an ended session.
    if (bySession.size) {
      const marks = [...bySession].map(([id, list]) => ({ id, max_ts: list.reduce((m, e) => (e.ts > m ? e.ts : m), list[0].ts) }));
      await tx`
        update sessions s set
          last_event_at = greatest(coalesce(s.last_event_at, x.max_ts), x.max_ts),
          ended_at = case when s.ended_at is not null and s.ended_at < x.max_ts then null else s.ended_at end
        from jsonb_to_recordset(${JSON.stringify(marks)}::text::jsonb) as x(id text, max_ts timestamptz)
        where s.id = x.id`;
    }

    return {
      sessions: goodSessions.length,
      inserted: inserted.length,
      duplicates: storableEvents.length - inserted.length,
      rejected,
    };
  });
}

export async function endSession(sql: SQL, sessionId: string, endedAt: string): Promise<boolean> {
  const rows = await sql`update sessions set ended_at = ${endedAt} where id = ${sessionId} returning id, imported`;
  if (!rows.length) return false;
  await enqueueSummary(sql, sessionId, { priority: rows[0].imported ? 1 : 0 });
  return true;
}
