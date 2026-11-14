import { test, expect } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { boundFolder, sess, ingest } from "./fixtures";
import { requeueMissingEmbeddings } from "../src/cli";
import { fakeEmbedder } from "../src/embed/fake";
import { toVector } from "../src/embed/embedder";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function seedChunks(t: any, n: number) {
  const sql = t.sql;
  const { binding } = await boundFolder(t);
  await ingest(t, { sessions: [sess("s1", binding.id)] });
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const [r] = await sql`insert into chunks (session_id, first_seq, last_seq, ts_from, ts_to, text)
      values ('s1', ${i}, ${i}, now(), now(), ${"chunk " + i}) returning id`;
    ids.push(Number(r.id));
  }
  return ids;
}

test("requeue-missing-embeddings queues exactly the chunks without vectors", async () => {
  const db = await authedApp();
  try {
    const ids = await seedChunks(db, 4);
    const e = fakeEmbedder();
    const [vec] = await e.embed(["x"]);
    await db.sql`insert into chunk_embeddings (chunk_id, embedding) values (${ids[0]}, ${toVector(vec)}::halfvec)`;
    await db.sql`insert into embed_queue (chunk_id, priority, dead, attempts) values (${ids[3]}, 0, true, 5)`; // already queued: untouched
    const r = await requeueMissingEmbeddings(db.sql);
    expect(r).toEqual({ chunks: 2, summaries: null });
    const q = await db.sql`select chunk_id, priority from embed_queue order by chunk_id`;
    expect(q.map((x: any) => [Number(x.chunk_id), x.priority])).toEqual([[ids[1], 1], [ids[2], 1], [ids[3], 0]]);
    expect((await requeueMissingEmbeddings(db.sql)).chunks).toBe(0); // idempotent
  } finally { await db.drop(); }
});

test("requeue-missing-embeddings re-embeds summaries only when summary_embeddings exists", async () => {
  const db = await freshDb();
  try {
    expect((await requeueMissingEmbeddings(db.sql)).summaries).toBeNull();
    // Minimal stand-in for plan 3's tables (only the columns the command relies on).
    await db.sql.unsafe(`
      create table summaries (id bigserial primary key, title text not null, text text not null);
      create table summary_embeddings (summary_id bigint primary key references summaries(id) on delete cascade, embedding halfvec(1024) not null)`);
    await db.sql`insert into summaries (title, text) values ('a', 'one'), ('b', 'two'), ('c', 'three')`;
    const e = fakeEmbedder();
    const [vec] = await e.embed(["x"]);
    await db.sql`insert into summary_embeddings (summary_id, embedding) select id, ${toVector(vec)}::halfvec from summaries where title = 'a'`;
    expect((await requeueMissingEmbeddings(db.sql, async () => e)).summaries).toBe(2);
    const [{ n }] = await db.sql`select count(*)::int as n from summary_embeddings`;
    expect(n).toBe(3);
  } finally { await db.drop(); }
});

test("cli migrate applies migrations and exits 0; requeue-missing-embeddings prints counts", async () => {
  const db = await freshDb({ migrate: false });
  try {
    const env = { ...process.env, DATABASE_URL: db.url };
    const run = (...args: string[]) => Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const m = run("migrate");
    const out = await new Response(m.stdout).text();
    expect(await m.exited).toBe(0);
    expect(out).toMatch(/migrat/i);
    const [{ n }] = await db.sql`select count(*)::int as n from chunks`;
    expect(n).toBe(0);
    const r = run("requeue-missing-embeddings");
    const rout = await new Response(r.stdout).text();
    expect(await r.exited).toBe(0);
    expect(rout).toContain("queued 0 chunk(s)");
  } finally { await db.drop(); }
});

test("requeue-missing-embeddings fails clearly when the embedder returns the wrong number of vectors", async () => {
  const db = await freshDb();
  try {
    await db.sql.unsafe(`
      create table summaries (id bigserial primary key, title text not null, text text not null);
      create table summary_embeddings (summary_id bigint primary key references summaries(id) on delete cascade, embedding halfvec(1024) not null)`);
    await db.sql`insert into summaries (title, text) values ('a', 'one'), ('b', 'two')`;
    const short = { dims: 1024, embed: async () => [new Array(1024).fill(0)] };
    await expect(requeueMissingEmbeddings(db.sql, async () => short)).rejects.toThrow(/1 vector\(s\) for 2 summaries/);
    const [{ n }] = await db.sql`select count(*)::int as n from summary_embeddings`;
    expect(n).toBe(0);
  } finally { await db.drop(); }
});
