import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { createToken } from "../src/auth";
import { migrate } from "../src/db";
import { requeueMissingEmbeddings } from "../src/cli";
import { claimQuery } from "../src/worker";

const MIGRATION = "007_embed_queue_machine.sql";

test("a queued chunk carries its uploading machine, at ingest and when requeued", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [ev("s1", 1, "user", "hello there")] });
    const [q] = await t.sql`select machine_id, enqueued_at from embed_queue`;
    expect(q.machine_id).toBe(t.machineId);
    expect(Date.now() - new Date(q.enqueued_at).getTime()).toBeLessThan(60_000);
    await t.sql`delete from embed_queue`;
    await requeueMissingEmbeddings(t.sql, async () => { throw new Error("no summaries to embed"); }).catch(() => {});
    expect((await t.sql`select machine_id from embed_queue`).map((r: any) => r.machine_id)).toEqual([t.machineId]);
  } finally { await t.drop(); }
});

test("migration 007 backfills machine_id on rows already queued", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [ev("s1", 1, "user", "hello there")] });
    // Back to the schema before 007, with a row queued under it.
    await t.sql.unsafe(`alter table embed_queue drop column machine_id, drop column enqueued_at`);
    await t.sql`delete from schema_migrations where name = ${MIGRATION}`;
    expect(await migrate(t.sql)).toEqual([MIGRATION]);
    expect((await t.sql`select machine_id from embed_queue`).map((r: any) => r.machine_id)).toEqual([t.machineId]);
  } finally { await t.drop(); }
});

/** The plan of a claim, as JSON, without claiming anything. */
async function plan(sql: any, route: Parameters<typeof claimQuery>[0], limit: number) {
  const { text, params } = claimQuery(route, limit, 600);
  let out: any;
  await sql.begin(async (tx: any) => {
    out = (await tx.unsafe(`explain (format json) ${text}`, params))[0]["QUERY PLAN"];
    throw new Error("rollback");
  }).catch((e: Error) => { if (e.message !== "rollback") throw e; });
  return JSON.stringify(out);
}

test("lane claims use the machine index and never scan chunks, with a 20k backlog", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await createToken(t.sql, "macbook-pro");
    const mbp = (await t.sql`select id from machines where name = 'macbook-pro'`)[0].id;
    await t.sql`insert into sessions (id, binding_id, machine_id, cwd, repo, started_at, imported)
                select 'm' || g, ${binding.id}, ${t.machineId}, '/', 'r', now(), true from generate_series(1, 50) g`;
    await t.sql`insert into sessions (id, binding_id, machine_id, cwd, repo, started_at) values ('b1', ${binding.id}, ${mbp}, '/', 'r', now())`;
    await t.sql.unsafe(`insert into chunks (session_id, first_seq, last_seq, ts_from, ts_to, text)
      select 'm' || (g % 50 + 1), g, g, now(), now(), repeat(md5(g::text) || ' word ', 40) from generate_series(1, 20000) g`);
    await t.sql.unsafe(`insert into chunks (session_id, first_seq, last_seq, ts_from, ts_to, text)
      select 'b1', g, g, now(), now(), 'x' from generate_series(1, 10) g`);
    await t.sql.unsafe(`insert into embed_queue (chunk_id, priority, machine_id)
      select c.id, case when s.imported then 1 else 0 end, s.machine_id from chunks c join sessions s on s.id = c.session_id`);
    await t.sql.unsafe("analyze");
    for (const [route, limit] of [
      [{ machine: "test-mac" }, 32], [{ machine: "macbook-pro" }, 32],
      [{ zima: { mapped: ["test-mac", "macbook-pro"], waiting: [] } }, 4],
      [{ zima: { mapped: ["test-mac", "macbook-pro"], waiting: ["test-mac"] } }, 4],
    ] as const) {
      const p = await plan(t.sql, route as any, limit);
      expect(p, JSON.stringify(route)).not.toMatch(/"Node Type":"Seq Scan","Parallel Aware":false,"Async Capable":false,"Relation Name":"chunks"/);
      expect(p.replace(/\s/g, "")).not.toMatch(/"NodeType":"SeqScan"[^}]*"RelationName":"(chunks|embed_queue)"/);
      expect(p, JSON.stringify(route)).toContain("embed_queue_machine_ready_idx");
    }
  } finally { await t.drop(); }
});
