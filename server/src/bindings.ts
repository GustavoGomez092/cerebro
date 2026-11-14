import type { SQL } from "bun";
import type { Binding } from "@cerebro/shared";

export class BindingError extends Error {
  constructor(public code: "invalid" | "conflict" | "not_found", message: string) { super(message); }
}

/** Canonical subpath: no leading/trailing or doubled slashes, no "." segments; ".." is rejected. */
export function normalizeSubpath(subpath: string): string {
  const parts = subpath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new BindingError("invalid", "subpath may not contain '..'");
  return parts.join("/");
}

const COLS = `id, repo, subpath, status, client_id as "clientId", project_id as "projectId"`;

export interface BindingInput {
  repo: string;
  subpath: string;
  status: "active" | "declined";
  clientId?: string | null;
  projectId?: string | null;
}

/**
 * Creates or updates the binding for (repo, subpath). Sessions reference the binding,
 * so changing client/project here moves all of that folder's history.
 */
export async function upsertBinding(sql: SQL, input: BindingInput): Promise<Binding> {
  const b = { ...input, subpath: normalizeSubpath(input.subpath) };
  const declined = b.status === "declined";
  const clientId = declined ? null : b.clientId ?? null;
  const projectId = declined ? null : b.projectId ?? null;
  if (!declined && !clientId) throw new BindingError("invalid", "an active binding needs a clientId");
  if (projectId) {
    const [p] = await sql`select client_id from projects where id = ${projectId}`;
    if (!p || p.client_id !== clientId) throw new BindingError("invalid", "project does not belong to client");
  }
  if (clientId) {
    const [c] = await sql`select id from clients where id = ${clientId}`;
    if (!c) throw new BindingError("invalid", "unknown client");
  }
  if (declined) {
    const [hist] = await sql`
      select 1 from bindings bd join sessions s on s.binding_id = bd.id
      where bd.repo = ${b.repo} and bd.subpath = ${b.subpath} limit 1`;
    if (hist) throw new BindingError("conflict", "this folder already has recorded history; re-bind it instead of declining");
  }
  const [row] = await sql.unsafe(
    `insert into bindings (repo, subpath, status, client_id, project_id)
     values ($1, $2, $3, $4, $5)
     on conflict (repo, subpath) do update
       set status = excluded.status, client_id = excluded.client_id,
           project_id = excluded.project_id, updated_at = now()
     returning ${COLS}`,
    [b.repo, b.subpath, b.status, clientId, projectId],
  );
  return row;
}

/** The most specific binding for a folder: longest subpath that equals or is a path-boundary prefix. */
export async function resolveBinding(sql: SQL, repo: string, rawSubpath: string): Promise<Binding | null> {
  const subpath = normalizeSubpath(rawSubpath);
  const rows = await sql.unsafe(
    `select ${COLS} from bindings
     where repo = $1 and (subpath = '' or subpath = $2 or $2 like replace(replace(replace(subpath, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%')
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
export async function repointBinding(sql: SQL, id: string, repo: string, rawSubpath: string): Promise<Binding> {
  const subpath = normalizeSubpath(rawSubpath);
  const [clash] = await sql`select id from bindings where repo = ${repo} and subpath = ${subpath} and id <> ${id}`;
  if (clash) throw new BindingError("conflict", "that folder identity is already bound");
  const rows = await sql.unsafe(
    `update bindings set repo = $2, subpath = $3, updated_at = now() where id = $1 returning ${COLS}`,
    [id, repo, subpath],
  );
  if (!rows[0]) throw new BindingError("not_found", "unknown binding");
  return rows[0];
}
