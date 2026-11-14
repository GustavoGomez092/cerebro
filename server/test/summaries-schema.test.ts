import { test, expect } from "bun:test";
import { freshDb } from "./helpers";

test("migrate creates the summary tables and unique summary ranges", async () => {
  const { sql, drop } = await freshDb();
  try {
    const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public'`).map((r: any) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(["summaries", "summary_embeddings", "summary_jobs", "project_states", "usage_ledger"]));

    const [m] = await sql`insert into machines (name, token_hash) values ('m', 'h') returning id`;
    const [c] = await sql`select id from clients where name = 'Personal'`;
    const [b] = await sql`insert into bindings (repo, status, client_id) values ('r', 'active', ${c.id}) returning id`;
    await sql`insert into sessions (id, binding_id, machine_id, cwd, repo, started_at) values ('s1', ${b.id}, ${m.id}, '/x', 'r', now())`;

    const insert = () => sql`
      insert into summaries (session_id, kind, binding_id, client_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
      values ('s1', 'session', ${b.id}, ${c.id}, 0, 9, now(), now(), 'Refactoring the Zebra importer', '{}'::jsonb, 'moved parsing into a module', 'test-model')`;
    await insert();
    await expect(insert()).rejects.toThrow(/unique|duplicate/i);

    const hit = await sql`select id from summaries where tsv @@ plainto_tsquery('cerebro', 'zebra')`;
    expect(hit.length).toBe(1);

    await expect(sql`
      insert into summaries (session_id, kind, binding_id, ts_from, ts_to, title, body, text, model)
      values ('s1', 'bogus', ${b.id}, now(), now(), 't', '{}'::jsonb, 'x', 'm')`).rejects.toThrow(/check/i);

    const [job] = await sql`insert into summary_jobs (session_id) values ('s1') returning priority, covered_seq, attempts, dead`;
    expect(job).toMatchObject({ priority: 0, covered_seq: -1, attempts: 0, dead: false });
    const [st] = await sql`insert into project_states (scope, client_id, doc, text) values ('client:x', ${c.id}, '{}'::jsonb, 't') returning version, dirty`;
    expect(st).toMatchObject({ version: 1, dirty: false });
    await sql`insert into usage_ledger (tokens, kind) values (5, 'summary')`;
  } finally { await drop(); }
});
