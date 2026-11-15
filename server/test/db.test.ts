import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { freshDb } from "./helpers";
import { migrate, checkEmbedSettings } from "../src/db";
import { loadConfig } from "../src/config";

test("migrate creates schema and is idempotent", async () => {
  const { sql, drop } = await freshDb();
  try {
    expect(await migrate(sql)).toEqual([]);
    const [{ n }] = await sql`select count(*)::int as n from clients where name = 'Personal'`;
    expect(n).toBe(1);
    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public'`).map((r: any) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(["chunk_embeddings", "embed_queue", "binding_history", "settings"]));
    const cols = (await sql`select column_name from information_schema.columns where table_name = 'chunks'`).map((c: any) => c.column_name);
    expect(cols).not.toContain("embedding");
    const [{ instance_id }] = await sql`select instance_id from settings`;
    expect(instance_id).toMatch(/^[0-9a-f-]{36}$/);
  } finally { await drop(); }
});

/** The database-level settings (alter database … set), as "name=value" strings. */
const dbSettings = async (sql: any): Promise<string[]> =>
  (await sql`
    select coalesce(s.setconfig, '{}') as c from pg_database d
    left join pg_db_role_setting s on s.setdatabase = d.oid and s.setrole = 0
    where d.datname = current_database()`)[0].c.slice().sort();

test("M1: migrate re-applies the database-level timeouts a restore drops", async () => {
  const { sql, drop } = await freshDb();
  try {
    const want = ["idle_in_transaction_session_timeout=60s", "statement_timeout=30s"];
    expect(await dbSettings(sql)).toEqual(want);
    // pg_restore into a createdb'd database (no --create) brings back schema_migrations with 001 in it, but
    // not 001's `alter database … set`: the same state as resetting them here.
    await sql.unsafe(`alter database ${(await sql`select current_database() as d`)[0].d} reset all`);
    expect(await dbSettings(sql)).toEqual([]);
    expect(await migrate(sql)).toEqual([]);
    expect(await dbSettings(sql)).toEqual(want);
  } finally { await drop(); }
});

test("concurrent migrations both succeed", async () => {
  const { sql, drop, url } = await freshDb({ migrate: false });
  try {
    const { connect } = await import("../src/db");
    const a = connect(url), b = connect(url);
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    const all = readdirSync(new URL("../migrations", import.meta.url).pathname).filter((f) => f.endsWith(".sql")).sort();
    expect([...ra, ...rb].sort()).toEqual(all);
    await a.close(); await b.close();
  } finally { await drop(); }
});

test("the same event key may exist in two sessions", async () => {
  const { sql, drop } = await freshDb();
  try {
    const [m] = await sql`insert into machines (name, token_hash) values ('m', 'h') returning id`;
    const [c] = await sql`select id from clients limit 1`;
    const [b] = await sql`insert into bindings (repo, status, client_id) values ('r', 'active', ${c.id}) returning id`;
    for (const s of ["s1", "s2"]) {
      await sql`insert into sessions (id, binding_id, machine_id, cwd, repo, started_at) values (${s}, ${b.id}, ${m.id}, '/x', 'r', now())`;
      await sql`insert into events (session_id, key, seq, ts, kind, text) values (${s}, 'k1', 1, now(), 'user', 'hi')`;
    }
    const [{ n }] = await sql`select count(*)::int as n from events`;
    expect(n).toBe(2);
  } finally { await drop(); }
});

test("embedding model and dims are pinned on first start", async () => {
  const { sql, drop } = await freshDb();
  try {
    await checkEmbedSettings(sql, "bge-m3", 1024);
    await checkEmbedSettings(sql, "bge-m3", 1024);
    await expect(checkEmbedSettings(sql, "other-model", 1024)).rejects.toThrow(/bge-m3/);
    await expect(checkEmbedSettings(sql, "bge-m3", 768)).rejects.toThrow(/1024/);
  } finally { await drop(); }
});

test("loadConfig applies defaults and validates", () => {
  expect(loadConfig({ DATABASE_URL: "postgres://x" })).toEqual({
    databaseUrl: "postgres://x", port: 8790, embedUrl: null, embedMachineUrls: {}, embedModelDigest: null, embedModel: "bge-m3", embedDims: 1024,
    summariser: { enabled: true, share: 0.2, windowTokens: 2000000, cmd: "claude" },
    chat: { model: "sonnet", timeoutMs: 300_000, maxConcurrent: 1 },
  });
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL: "x", PORT: "" })).not.toThrow();
  expect(loadConfig({ DATABASE_URL: "x", PORT: "" }).port).toBe(8790);
  expect(() => loadConfig({ DATABASE_URL: "x", PORT: "abc" })).toThrow(/PORT/);
});
