// The web dashboard's database role (migration 009): give it LOGIN and a fresh password. The password goes to
// Postgres as a SCRAM-SHA-256 verifier (so even a logged failing statement can't show it) and leaves this process
// only as the DATABASE_URL line for web.env, written into a pipe (deploy/zima/web-db-role.sh), never to a terminal.
import type { SQL } from "bun";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const WEB_DB_ROLE = "cerebro_web";
const ITERATIONS = 4096;

/** Postgres's stored form of a SCRAM-SHA-256 password (RFC 5802/7677), as `password_encryption = scram-sha-256` makes. */
export function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** 40 random alphanumerics (URL-safe in DATABASE_URL). */
function newPassword(): string {
  let s = "";
  while (s.length < 40) s += randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "");
  return s.slice(0, 40);
}

/**
 * Sets cerebro_web's LOGIN and a new password; returns `DATABASE_URL=…` for web.env: the server's own database
 * address with cerebro_web's credentials. Re-running rotates the password.
 */
export async function setWebDbRole(sql: SQL, databaseUrl: string): Promise<string> {
  const password = newPassword();
  const verifier = scramVerifier(password);
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error("bad verifier");
  const [role] = await sql`select 1 from pg_roles where rolname = ${WEB_DB_ROLE}`;
  if (!role) throw new Error(`role ${WEB_DB_ROLE} does not exist: run the migrations first (bun server/src/cli.ts migrate)`);
  // ALTER ROLE takes no bind parameters; the verifier is checked above to hold no quote.
  await sql.unsafe(`alter role ${WEB_DB_ROLE} login password '${verifier}'`);
  const u = new URL(databaseUrl);
  u.username = WEB_DB_ROLE;
  u.password = password;
  return `DATABASE_URL=${u.toString()}`;
}

/** The CLI command: refuses a terminal (the line holds a password), else prints the line once. */
export async function runWebDbRole(
  sql: SQL, databaseUrl: string, out: { isTTY: boolean; write: (s: string) => void },
): Promise<void> {
  if (out.isTTY) {
    throw new Error("web-db-role prints a password: pipe it into deploy/zima/web-db-role.sh (or a root-only file), not a terminal");
  }
  out.write(`${await setWebDbRole(sql, databaseUrl)}\n`);
}
