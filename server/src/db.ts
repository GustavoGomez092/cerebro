import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Sql = SQL;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const MIGRATION_LOCK = 0x63657262; // "cerb"
/** The vector size baked into the schema (chunk_embeddings.embedding halfvec(1024)). */
export const SCHEMA_DIMS = 1024;

export function connect(url: string, opts: { max?: number } = {}): SQL {
  return new SQL(url, { max: opts.max ?? 10, idleTimeout: 60, onnotice: () => {} } as any);
}

/**
 * Applies pending migrations in name order under a session advisory lock, so concurrent
 * starters wait instead of colliding. A file whose first line is `-- no-transaction` runs
 * outside a transaction (needed for `create index concurrently`).
 */
export async function migrate(sql: SQL): Promise<string[]> {
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await conn`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const done = new Set((await conn`select name from schema_migrations`).map((r: any) => r.name));
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
      const applied: string[] = [];
      for (const name of files) {
        if (done.has(name)) continue;
        const body = await Bun.file(join(MIGRATIONS_DIR, name)).text();
        const transactional = !body.startsWith("-- no-transaction");
        if (transactional) await conn.unsafe("begin");
        try {
          await conn.unsafe("set statement_timeout = 0");
          await conn.unsafe(body);
          await conn`insert into schema_migrations (name) values (${name})`;
          if (transactional) await conn.unsafe("commit");
        } catch (e) {
          if (transactional) await conn.unsafe("rollback");
          throw new Error(`migration ${name} failed: ${(e as Error).message}`);
        }
        applied.push(name);
      }
      return applied;
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK})`;
      await conn.unsafe("reset statement_timeout");
    }
  } finally {
    conn.release();
  }
}

/** Pins the embedding model/dims on first start; refuses a different model or size later. */
export async function checkEmbedSettings(sql: SQL, model: string, dims: number): Promise<void> {
  if (dims !== SCHEMA_DIMS) throw new Error(`EMBED_DIMS is ${dims} but the schema stores ${SCHEMA_DIMS}-dim vectors`);
  const [s] = await sql`
    update settings set embed_model = coalesce(embed_model, ${model}), embed_dims = coalesce(embed_dims, ${dims})
    returning embed_model, embed_dims`;
  if (s.embed_model !== model || s.embed_dims !== dims)
    throw new Error(`stored embeddings use ${s.embed_model} (${s.embed_dims} dims); configured ${model} (${dims}). Re-embedding is required to switch.`);
}

/** SQLSTATE of a Postgres error (Bun reports it in `errno`), or null. */
export function pgState(e: unknown): string | null {
  const s = (e as any)?.errno;
  return typeof s === "string" && /^[0-9A-Z]{5}$/.test(s) ? s : null;
}
