import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export type Sql = SQL;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export function connect(url: string): SQL {
  return new SQL(url, { onnotice: () => {} } as any);
}

/** Applies pending migrations in name order; returns the names applied this run. */
export async function migrate(sql: SQL): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from schema_migrations`).map((r: any) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const body = await Bun.file(join(MIGRATIONS_DIR, name)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    applied.push(name);
  }
  return applied;
}
