import type { SQL } from "bun";
import type { IngestBatch, IngestResult } from "@cerebro/shared";

export class IngestError extends Error {
  constructor(public code: "unknown_session" | "unknown_binding" | "binding_declined", public detail: Record<string, string>) {
    super(code);
  }
}

/** Postgres text/jsonb cannot hold U+0000 (common in `find -print0` output); replace it. */
const clean = (s: string) => s.replaceAll("\u0000", "\uFFFD");
function cleanDeep(v: unknown): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), cleanDeep(x)]));
  return v;
}

/** Stores sessions and events in one transaction. Replays are harmless: events dedupe on `key`. */
export async function ingestBatch(sql: SQL, machineId: string, batch: IngestBatch): Promise<IngestResult> {
  return sql.begin(async (tx) => {
    for (const s of batch.sessions) {
      const [b] = await tx`select status from bindings where id = ${s.bindingId}`;
      if (!b) throw new IngestError("unknown_binding", { bindingId: s.bindingId });
      if (b.status === "declined") throw new IngestError("binding_declined", { bindingId: s.bindingId });
      await tx`
        insert into sessions (id, binding_id, machine_id, cwd, started_at, imported)
        values (${s.id}, ${s.bindingId}, ${machineId}, ${s.cwd}, ${s.startedAt}, ${s.imported ?? false})
        on conflict (id) do update set
          binding_id = case when sessions.last_event_at is null then excluded.binding_id else sessions.binding_id end,
          cwd = case when sessions.last_event_at is null then excluded.cwd else sessions.cwd end,
          started_at = least(sessions.started_at, excluded.started_at)`;
    }
    const sessionIds = [...new Set(batch.events.map((e) => e.sessionId))];
    if (sessionIds.length) {
      const known = new Set((await tx`select id from sessions where id in ${tx(sessionIds)}`).map((r: any) => r.id));
      const missing = sessionIds.find((id) => !known.has(id));
      if (missing) throw new IngestError("unknown_session", { sessionId: missing });
    }
    let inserted = 0;
    for (const e of batch.events) {
      const toolInput = e.toolInput === undefined ? null : JSON.stringify(cleanDeep(e.toolInput));
      const rows = await tx`
        insert into events (key, session_id, seq, ts, kind, text, tool_name, tool_input)
        values (${e.key}, ${e.sessionId}, ${e.seq}, ${e.ts}, ${e.kind}, ${clean(e.text)}, ${e.toolName ?? null}, ${toolInput}::text::jsonb)
        on conflict (key) do nothing returning id`;
      inserted += rows.length;
    }
    for (const id of sessionIds) {
      await tx`update sessions set last_event_at = (select max(ts) from events where session_id = ${id}) where id = ${id}`;
    }
    return { sessions: batch.sessions.length, inserted, duplicates: batch.events.length - inserted };
  });
}

export async function endSession(sql: SQL, sessionId: string, endedAt: string): Promise<boolean> {
  const rows = await sql`update sessions set ended_at = ${endedAt} where id = ${sessionId} returning id`;
  return rows.length > 0;
}
