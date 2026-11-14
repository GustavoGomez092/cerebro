import type { SQL } from "bun";
import { normalizeIdentity, pathIdentityMachine, type Binding } from "@cerebro/shared";
import type { Machine } from "./auth";
import { invalidateStates, scopeKey } from "./summarise/state";

export type BindingErrorCode = "invalid" | "conflict" | "not_found" | "forbidden" | "rebind_required";

export class BindingError extends Error {
  constructor(public code: BindingErrorCode, message: string) { super(message); }
}

/** Canonical subpath: no leading/trailing or doubled slashes, no "." segments; ".." is rejected. */
export function normalizeSubpath(subpath: string): string {
  const parts = subpath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new BindingError("invalid", "subpath may not contain '..'");
  return parts.join("/");
}

const COLS = `id, repo, subpath, status, client_id as "clientId", project_id as "projectId"`;
const view = (b: Binding | null) => b && { status: b.status, clientId: b.clientId, projectId: b.projectId, repo: b.repo, subpath: b.subpath };

/** A `path:<machine>:` identity may only be written by that machine. */
function assertOwnPath(repo: string, machine?: Machine) {
  const owner = pathIdentityMachine(repo);
  if (owner !== null && machine && owner !== machine.name)
    throw new BindingError("forbidden", `path identities belong to the machine that created them (${owner})`);
}

async function record(sql: SQL, bindingId: string, machine: Machine | undefined, action: string, before: unknown, after: unknown) {
  await sql`
    insert into binding_history (binding_id, machine_id, action, before, after)
    values (${bindingId}, ${machine?.id ?? null}, ${action}, ${JSON.stringify(before)}::text::jsonb, ${JSON.stringify(after)}::text::jsonb)`;
}

/**
 * Re-binding moves history: puts summaries in their binding's current scope (a declined binding has
 * none) and invalidates the project state of every scope they left or joined, so each is rebuilt
 * rather than folded into. `which` picks the summaries: all of a binding's, or those of sessions that
 * moved to `to`. Rows are locked in id order so concurrent moves cannot deadlock.
 */
async function rescopeSummaries(
  tx: SQL, to: Binding, which: { bindingId: string } | { sessionIds: string[] },
): Promise<void> {
  const moved: { client_id: string | null; project_id: string | null }[] = "bindingId" in which
    ? await tx`
        with old as (
          select id, client_id, project_id from summaries where binding_id = ${which.bindingId} order by id for update)
        update summaries s set client_id = ${to.clientId}, project_id = ${to.projectId}
        from old where s.id = old.id
        returning old.client_id, old.project_id`
    : which.sessionIds.length
      ? await tx`
          with old as (
            select id, client_id, project_id from summaries
            where session_id = any(${tx.array(which.sessionIds, "text")}) order by id for update)
          update summaries s set binding_id = ${to.id}, client_id = ${to.clientId}, project_id = ${to.projectId}
          from old where s.id = old.id
          returning old.client_id, old.project_id`
      : [];
  const target = to.status === "active" && to.clientId ? scopeKey(to.clientId, to.projectId) : null;
  const left = moved.map((m) => (m.client_id ? scopeKey(m.client_id, m.project_id) : null));
  if (!left.some((k) => k !== target)) return;
  await invalidateStates(tx, [...left, target].filter((k): k is string => k !== null));
}

export interface BindingInput {
  repo: string;
  subpath: string;
  status: "active" | "declined";
  clientId?: string | null;
  projectId?: string | null;
}

/**
 * Creates the binding for (repo, subpath), or changes an existing one when `rebind` is set.
 * Sessions reference the binding, so a change moves all of that folder's history; without
 * `rebind` a change is refused so two machines can't silently overwrite each other.
 */
export async function upsertBinding(
  sql: SQL, input: BindingInput, opts: { machine?: Machine; rebind?: boolean } = {},
): Promise<Binding> {
  const repo = normalizeIdentity(input.repo);
  const subpath = normalizeSubpath(input.subpath);
  if (!repo) throw new BindingError("invalid", "repo is required");
  assertOwnPath(repo, opts.machine);
  const declined = input.status === "declined";
  const clientId = declined ? null : input.clientId ?? null;
  const projectId = declined ? null : input.projectId ?? null;
  if (!declined && !clientId) throw new BindingError("invalid", "an active binding needs a clientId");
  if (clientId) {
    const [c] = await sql`select id from clients where id = ${clientId}`;
    if (!c) throw new BindingError("invalid", "unknown client");
  }
  if (projectId) {
    const [p] = await sql`select client_id from projects where id = ${projectId}`;
    if (!p || p.client_id !== clientId) throw new BindingError("invalid", "project does not belong to client");
  }
  return sql.begin(async (tx) => {
    const [existing] = await tx.unsafe(`select ${COLS} from bindings where repo = $1 and subpath = $2 for update`, [repo, subpath]);
    if (existing) {
      const same = existing.status === input.status && existing.clientId === clientId && existing.projectId === projectId;
      if (same) return existing;
      if (!opts.rebind)
        throw new BindingError("rebind_required", "this folder is already bound; send rebind: true to move it (and its history)");
      const [row] = await tx.unsafe(
        `update bindings set status = $2, client_id = $3, project_id = $4, updated_at = now() where id = $1 returning ${COLS}`,
        [existing.id, input.status, clientId, projectId]);
      await record(tx, row.id, opts.machine, "rebind", view(existing), view(row));
      await rescopeSummaries(tx, row, { bindingId: row.id });
      return row;
    }
    const [row] = await tx.unsafe(
      `insert into bindings (repo, subpath, status, client_id, project_id) values ($1, $2, $3, $4, $5) returning ${COLS}`,
      [repo, subpath, input.status, clientId, projectId]);
    await record(tx, row.id, opts.machine, "create", null, view(row));
    return row;
  });
}

/** The most specific binding for a folder: longest subpath that equals or is a path-boundary prefix. */
export async function resolveBinding(
  sql: SQL, rawRepo: string, rawSubpath: string, opts: { activeOnly?: boolean } = {},
): Promise<Binding | null> {
  const repo = normalizeIdentity(rawRepo);
  const subpath = normalizeSubpath(rawSubpath);
  const rows = await sql.unsafe(
    `select ${COLS} from bindings
     where repo = $1 and (subpath = '' or subpath = $2 or $2 like replace(replace(replace(subpath, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%')
       ${opts.activeOnly ? "and status = 'active'" : ""}
     order by length(subpath) desc limit 1`,
    [repo, subpath],
  );
  return rows[0] ?? null;
}

export async function getBinding(sql: SQL, id: string): Promise<Binding | null> {
  const rows = await sql.unsafe(`select ${COLS} from bindings where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Re-points a binding at a new folder identity (e.g. after a remote rename). */
export async function repointBinding(sql: SQL, id: string, rawRepo: string, rawSubpath: string, machine?: Machine): Promise<Binding> {
  const repo = normalizeIdentity(rawRepo);
  const subpath = normalizeSubpath(rawSubpath);
  assertOwnPath(repo, machine);
  return sql.begin(async (tx) => {
    const before = await getBinding(tx, id);
    if (!before) throw new BindingError("not_found", "unknown binding");
    const [clash] = await tx`select id from bindings where repo = ${repo} and subpath = ${subpath} and id <> ${id}`;
    if (clash) throw new BindingError("conflict", "that folder identity is already bound");
    const [row] = await tx.unsafe(`update bindings set repo = $2, subpath = $3, updated_at = now() where id = $1 returning ${COLS}`, [id, repo, subpath]);
    await record(tx, id, machine, "repoint", view(before), view(row));
    return row;
  });
}

/**
 * Moves sessions recorded under a less specific binding of the same repo into this binding,
 * when their folder lies under it (monorepo subfolder bound after work already happened there).
 */
export async function adoptSessions(sql: SQL, bindingId: string, machine?: Machine): Promise<number> {
  return sql.begin(async (tx) => {
    const b = await getBinding(tx, bindingId);
    if (!b) throw new BindingError("not_found", "unknown binding");
    if (b.status !== "active") throw new BindingError("invalid", "only an active binding can adopt sessions");
    const moved = await tx`
      update sessions s set binding_id = ${b.id}
      from bindings cur
      where cur.id = s.binding_id and cur.repo = ${b.repo} and length(cur.subpath) < length(${b.subpath})
        and s.repo = ${b.repo}
        and (${b.subpath} = '' or s.subpath = ${b.subpath} or starts_with(s.subpath, ${b.subpath} || '/'))
      returning s.id, cur.id as from_binding`;
    if (moved.length) {
      await record(tx, b.id, machine, "adopt", null, { sessions: moved.map((m: any) => ({ id: m.id, from: m.from_binding })) });
      await rescopeSummaries(tx, b, { sessionIds: moved.map((m: any) => m.id) });
    }
    return moved.length;
  });
}

/** Moves one session to another active binding. Returns false when the session is unknown. */
export async function moveSession(sql: SQL, sessionId: string, bindingId: string, machine?: Machine): Promise<boolean> {
  return sql.begin(async (tx) => {
    const target = await getBinding(tx, bindingId);
    if (!target) throw new BindingError("invalid", "unknown binding");
    if (target.status !== "active") throw new BindingError("invalid", "sessions can only move to an active binding");
    const [s] = await tx`select binding_id from sessions where id = ${sessionId} for update`;
    if (!s) return false;
    await tx`update sessions set binding_id = ${bindingId} where id = ${sessionId}`;
    await record(tx, bindingId, machine, "session_move", { sessionId, bindingId: s.binding_id }, { sessionId, bindingId });
    await rescopeSummaries(tx, target, { sessionIds: [sessionId] });
    return true;
  });
}
