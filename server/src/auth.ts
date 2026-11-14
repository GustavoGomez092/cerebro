import type { SQL } from "bun";
import type { MiddlewareHandler } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Machine { id: string; name: string }

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Issues a new token for a machine. A revoked machine name can be re-issued. */
export async function createToken(sql: SQL, machineName: string): Promise<{ machineId: string; token: string }> {
  const token = `cbr_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hash(token);
  const [existing] = await sql`select id, revoked_at from machines where name = ${machineName}`;
  if (existing && !existing.revoked_at) throw new Error(`machine "${machineName}" already has an active token`);
  const [row] = existing
    ? await sql`update machines set token_hash = ${tokenHash}, revoked_at = null, created_at = now() where id = ${existing.id} returning id`
    : await sql`insert into machines (name, token_hash) values (${machineName}, ${tokenHash}) returning id`;
  return { machineId: row.id, token };
}

export type TokenCheck = { machine: Machine } | { revoked: true } | null;

export async function verifyToken(sql: SQL, token: string): Promise<TokenCheck> {
  if (!token) return null;
  const tokenHash = hash(token);
  const [row] = await sql`select id, name, token_hash, revoked_at from machines where token_hash = ${tokenHash}`;
  if (!row) return null;
  const a = Buffer.from(row.token_hash), b = Buffer.from(tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.revoked_at ? { revoked: true } : { machine: { id: row.id, name: row.name } };
}

export async function revokeToken(sql: SQL, machineName: string): Promise<boolean> {
  const rows = await sql`update machines set revoked_at = now() where name = ${machineName} and revoked_at is null returning id`;
  return rows.length > 0;
}

/** Bearer auth. A revoked token gets `token_revoked` so clients stop retrying and tell the owner. */
export function bearerAuth(sql: SQL): MiddlewareHandler {
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)$/.exec(c.req.header("Authorization") ?? "");
    const check = m ? await verifyToken(sql, m[1]) : null;
    if (!check) return c.json({ error: "unauthorized", message: "missing or unknown token" }, 401);
    if ("revoked" in check) return c.json({ error: "token_revoked", message: "this machine's token was revoked; ask the owner for a new one" }, 401);
    c.set("machine", check.machine);
    await sql`update machines set last_used_at = now()
              where id = ${check.machine.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
    await next();
  };
}
