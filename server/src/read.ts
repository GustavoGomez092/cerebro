import type { SQL } from "bun";
import type { EventView, SessionView } from "@cerebro/shared";

const TOOL_RESULT_PREVIEW = 2000;

export async function listSessions(
  sql: SQL,
  f: { clientId?: string; projectId?: string; from?: string; to?: string; limit?: number },
): Promise<SessionView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
  if (f.clientId) add("b.client_id = ?", f.clientId);
  if (f.projectId) add("b.project_id = ?", f.projectId);
  if (f.from) add("coalesce(s.last_event_at, s.started_at) >= ?::timestamptz", f.from);
  if (f.to) add("s.started_at <= ?::timestamptz", f.to);
  const limit = Math.min(f.limit ?? 50, 200);
  const rows = await sql.unsafe(
    `select s.id, cl.name as client_name, p.name as project_name, m.name as machine, s.cwd,
            s.started_at, s.last_event_at, s.ended_at, s.imported
     from sessions s join bindings b on b.id = s.binding_id join machines m on m.id = s.machine_id
     left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
     ${where.length ? "where " + where.join(" and ") : ""}
     order by s.started_at desc limit ${limit}`, params);
  return rows.map((r: any) => ({
    id: r.id, clientName: r.client_name, projectName: r.project_name, machine: r.machine, cwd: r.cwd,
    startedAt: r.started_at.toISOString(), lastEventAt: r.last_event_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null, imported: r.imported,
  }));
}

/** Returns a session's events in order, or null when the session is unknown. */
export async function getEvents(
  sql: SQL,
  sessionId: string,
  f: { fromSeq?: number; toSeq?: number; full?: boolean },
): Promise<EventView[] | null> {
  const [s] = await sql`select id from sessions where id = ${sessionId}`;
  if (!s) return null;
  const rows = await sql`
    select seq, ts, kind, text, tool_name, tool_input from events
    where session_id = ${sessionId}
      and seq >= ${f.fromSeq ?? 0} and seq <= ${f.toSeq ?? 2147483647}
    order by seq`;
  return rows.map((r: any) => {
    const cut = !f.full && r.kind === "tool_result" && r.text.length > TOOL_RESULT_PREVIEW;
    return {
      seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, toolName: r.tool_name, toolInput: r.tool_input,
      text: cut ? r.text.slice(0, TOOL_RESULT_PREVIEW) : r.text, truncated: cut,
    };
  });
}
