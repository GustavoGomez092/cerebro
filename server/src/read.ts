import type { SQL } from "bun";
import type { EventView, SearchScope, SessionView } from "@cerebro/shared";

const TOOL_RESULT_PREVIEW = 2000;
/** `full=1` reads stop once this many bytes of text are collected. */
export const FULL_READ_BUDGET = 2 * 1024 * 1024;

function scopeWhere(scope: SearchScope, params: unknown[]): string[] {
  const where = ["b.status = 'active'"];
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
  if (scope.kind === "project") add("b.project_id = ?", scope.projectId);
  else {
    if (scope.clientId) add("b.client_id = ?", scope.clientId);
    if (scope.projectId) add("b.project_id = ?", scope.projectId);
  }
  return where;
}

/** Sessions visible in a scope, newest first. `before` is the previous page's `next` cursor. */
export async function listSessions(
  sql: SQL, scope: SearchScope, f: { from?: string; to?: string; limit?: number; before?: string },
): Promise<{ sessions: SessionView[]; next: string | null }> {
  const params: unknown[] = [];
  const where = scopeWhere(scope, params);
  const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace("?", `$${params.length}`)); };
  if (f.from) add("coalesce(s.last_event_at, s.started_at) >= ?::timestamptz", f.from);
  if (f.to) add("s.started_at <= ?::timestamptz", f.to);
  if (f.before) {
    const [ts, id] = f.before.split("|");
    params.push(ts, id ?? "");
    where.push(`(s.started_at, s.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  const limit = Math.min(f.limit ?? 50, 200);
  const rows = await sql.unsafe(
    `select s.id, cl.name as client_name, p.name as project_name, m.name as machine, s.cwd,
            s.started_at, s.last_event_at, s.ended_at, s.imported
     from sessions s join bindings b on b.id = s.binding_id join machines m on m.id = s.machine_id
     left join clients cl on cl.id = b.client_id left join projects p on p.id = b.project_id
     where ${where.join(" and ")}
     order by s.started_at desc, s.id desc limit ${limit}`, params);
  const sessions = rows.map((r: any) => ({
    id: r.id, clientName: r.client_name, projectName: r.project_name, machine: r.machine, cwd: r.cwd,
    startedAt: r.started_at.toISOString(), lastEventAt: r.last_event_at?.toISOString() ?? null,
    endedAt: r.ended_at?.toISOString() ?? null, imported: r.imported,
  }));
  const last = sessions[sessions.length - 1];
  return { sessions, next: sessions.length === limit && last ? `${last.startedAt}|${last.id}` : null };
}

/**
 * A page of a session's events after `afterSeq`, or null when the session is unknown or outside
 * the scope. Tool output is truncated in SQL unless `full`, which is capped by a byte budget.
 */
export async function getEvents(
  sql: SQL, sessionId: string, scope: SearchScope, f: { afterSeq?: number; limit?: number; full?: boolean },
): Promise<{ events: EventView[]; nextSeq: number | null } | null> {
  const params: unknown[] = [sessionId];
  const where = scopeWhere(scope, params);
  const [visible] = await sql.unsafe(
    `select 1 from sessions s join bindings b on b.id = s.binding_id where s.id = $1 and ${where.join(" and ")}`, params);
  if (!visible) return null;

  const after = f.afterSeq ?? -1;
  let limit = Math.min(f.limit ?? 200, 1000);
  if (f.full) {
    // Find how many rows fit the byte budget before loading any text (always at least one).
    const sizes = await sql`
      select seq, octet_length(text)::int8 as n from events
      where session_id = ${sessionId} and seq > ${after} order by seq limit ${limit}`;
    let total = 0, fit = 0;
    for (const s of sizes) {
      total += Number(s.n);
      if (fit > 0 && total > FULL_READ_BUDGET) break;
      fit++;
    }
    limit = Math.max(fit, 1);
  }
  const full = !!f.full;
  const rows = await sql`
    select seq, ts, kind, tool_name, tool_input,
           case when kind = 'tool_result' and not ${full} then left(text, ${TOOL_RESULT_PREVIEW}) else text end as text,
           (kind = 'tool_result' and not ${full} and length(text) > ${TOOL_RESULT_PREVIEW}) as truncated
    from events where session_id = ${sessionId} and seq > ${after}
    order by seq limit ${limit + 1}`;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    events: page.map((r: any) => ({
      seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, toolName: r.tool_name, toolInput: r.tool_input, text: r.text, truncated: r.truncated,
    })),
    nextSeq: more && page.length ? page[page.length - 1].seq : null,
  };
}
