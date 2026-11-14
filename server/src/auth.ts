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

export async function verifyToken(sql: SQL, token: string): Promise<Machine | null> {
  if (!token) return null;
  const tokenHash = hash(token);
  const [row] = await sql`select id, name, token_hash from machines where token_hash = ${tokenHash} and revoked_at is null`;
  if (!row) return null;
  const a = Buffer.from(row.token_hash), b = Buffer.from(tokenHash);
  return a.length === b.length && timingSafeEqual(a, b) ? { id: row.id, name: row.name } : null;
}

export async function revokeToken(sql: SQL, machineName: string): Promise<boolean> {
  const rows = await sql`update machines set revoked_at = now() where name = ${machineName} and revoked_at is null returning id`;
  return rows.length > 0;
}

export function bearerAuth(sql: SQL): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/.exec(header);
    const machine = m ? await verifyToken(sql, m[1]) : null;
    if (!machine) return c.json({ error: "unauthorized" }, 401);
    c.set("machine", machine);
    await next();
  };
}
