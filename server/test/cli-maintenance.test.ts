import { test, expect } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { boundFolder, sess, ingest } from "./fixtures";
import { claudeSmoke, requeueMissingEmbeddings } from "../src/cli";
import { runClaude, type ClaudeInput } from "../src/summarise/claude";
import { SUMMARY_SCHEMA } from "../src/summarise/prompts";
import { fakeEmbedder } from "../src/embed/fake";
import { toVector } from "../src/embed/embedder";
import { summaryEmbedText } from "../src/summarise/summarise";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** A stored summary as the summariser leaves it (real schema: title, body jsonb, text), without a vector. */
async function seedSummary(t: any, binding: any, sessionId: string, seq: number, s: { title: string; overview: string; facts: string[] }) {
  const body = { title: s.title, period: "Nov 2026", overview: s.overview, decisions: ["a decision"], changes: [], facts: s.facts, open_threads: [], resolved_threads: [] };
  const [row] = await t.sql`
    insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
    values (${sessionId}, 'session', ${binding.id}, ${binding.clientId}, ${binding.projectId ?? null}, ${seq}, ${seq}, now(), now(),
            ${s.title}, ${JSON.stringify(body)}::text::jsonb, ${"searchable text that is not the embed text " + seq}, 'test')
    returning id`;
  return { id: Number(row.id), title: s.title, body };
}

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
    expect(r).toEqual({ chunks: 2, summaries: 0 });
    const q = await db.sql`select chunk_id, priority from embed_queue order by chunk_id`;
    expect(q.map((x: any) => [Number(x.chunk_id), x.priority])).toEqual([[ids[1], 1], [ids[2], 1], [ids[3], 0]]);
    expect((await requeueMissingEmbeddings(db.sql)).chunks).toBe(0); // idempotent
  } finally { await db.drop(); }
});

test("requeue-missing-embeddings skips summaries when the summary tables do not exist", async () => {
  const db = await freshDb();
  try {
    await db.sql`drop table summary_embeddings`;
    expect((await requeueMissingEmbeddings(db.sql)).summaries).toBeNull();
  } finally { await db.drop(); }
});

test("requeue-missing-embeddings re-embeds summaries with the live path's summaryEmbedText (real schema)", async () => {
  const db = await authedApp();
  try {
    const { binding } = await boundFolder(db);
    await ingest(db, { sessions: [sess("s1", binding.id)] });
    const a = await seedSummary(db, binding, "s1", 1, { title: "Auth rework", overview: "Moved tokens to argon2.", facts: ["tokens hashed"] });
    const b = await seedSummary(db, binding, "s1", 2, { title: "Deploy", overview: "Compose on Zima.", facts: [] });
    const c = await seedSummary(db, binding, "s1", 3, { title: "Search", overview: "Hybrid RRF.", facts: ["k=60", "halfvec"] });
    const e = fakeEmbedder();
    const [vec] = await e.embed(["x"]);
    await db.sql`insert into summary_embeddings (summary_id, embedding) values (${a.id}, ${toVector(vec)}::halfvec)`;
    const seen: string[] = [];
    const recording = { dims: e.dims, embed: async (texts: string[]) => { seen.push(...texts); return e.embed(texts); } };
    expect((await requeueMissingEmbeddings(db.sql, async () => recording)).summaries).toBe(2);
    // Exactly the text the live summariser embeds, so a re-embed after a restore yields the same vectors.
    expect(seen).toEqual([summaryEmbedText(b), summaryEmbedText(c)]);
    const rows = await db.sql`select summary_id, embedding::text as v from summary_embeddings order by summary_id`;
    expect(rows.map((r: any) => Number(r.summary_id))).toEqual([a.id, b.id, c.id]);
    const [live] = await e.embed([summaryEmbedText(c)]);
    const [{ v: want }] = await db.sql`select ${toVector(live)}::halfvec::text as v`;
    expect(rows[2].v).toBe(want);
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
  const db = await authedApp();
  try {
    const { binding } = await boundFolder(db);
    await ingest(db, { sessions: [sess("s1", binding.id)] });
    await seedSummary(db, binding, "s1", 1, { title: "a", overview: "one", facts: [] });
    await seedSummary(db, binding, "s1", 2, { title: "b", overview: "two", facts: [] });
    const short = { dims: 1024, embed: async () => [new Array(1024).fill(0)] };
    await expect(requeueMissingEmbeddings(db.sql, async () => short)).rejects.toThrow(/1 vector\(s\) for 2 summaries/);
    const [{ n }] = await db.sql`select count(*)::int as n from summary_embeddings`;
    expect(n).toBe(0);
  } finally { await db.drop(); }
});

// M3: one tiny real summary call through the server's own runClaude, run in the container after `claude auth login`.
const FAKE_CLAUDE = "bun server/test/fakes/fake-claude.ts";
const fakeRun = (mode: string) => (input: ClaudeInput) =>
  runClaude(input, { ...process.env, SUMMARISER_CMD: FAKE_CLAUDE, FAKE_CLAUDE_MODE: mode } as NodeJS.ProcessEnv);

test("M3: claude-smoke runs one summary call with the server's prompt and schema, charges it, and prints ok", async () => {
  const db = await freshDb();
  try {
    const calls: ClaudeInput[] = [];
    const r = await claudeSmoke((input) => { calls.push(input); return fakeRun("ok")(input); }, db.sql);
    expect(calls).toHaveLength(1);
    expect(calls[0].schema).toBe(SUMMARY_SCHEMA);
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^ok: a summary call answered .*model claude-haiku-fake, 22 tokens/);
    expect(await db.sql`select tokens, kind from usage_ledger`).toEqual([{ tokens: 22, kind: "summary" }]);
  } finally { await db.drop(); }
});

test("M3: claude-smoke prints the classified error with what to do, and never the prompt", async () => {
  for (const [mode, kind, hint] of [["auth", "auth", /claude auth login/], ["missing", "bad_output", /summary schema/], ["notjson", "bad_output", /Dockerfile/], ["connection", "unavailable", /network|API/]] as const) {
    const r = await claudeSmoke(fakeRun(mode));
    expect([mode, r.ok]).toEqual([mode, false]);
    expect(r.line).toStartWith(`FAIL ${kind}: `);
    expect(r.line).toMatch(hint);
    expect(r.line).not.toContain("<transcript");
  }
});

test("M3: `cli.ts claude-smoke` exits 0 on a good call and 1 on a failure", async () => {
  const db = await freshDb();
  try {
    const run = async (mode: string) => {
      const p = Bun.spawn(["bun", CLI, "claude-smoke"], {
        env: { ...process.env, DATABASE_URL: db.url, SUMMARISER_CMD: FAKE_CLAUDE, FAKE_CLAUDE_MODE: mode }, stdout: "pipe", stderr: "pipe",
      });
      return { out: await new Response(p.stdout).text(), code: await p.exited };
    };
    const good = await run("ok");
    expect(good.code).toBe(0);
    expect(good.out).toStartWith("ok: ");
    const bad = await run("auth");
    expect(bad.code).toBe(1);
    expect(bad.out).toStartWith("FAIL auth: ");
  } finally { await db.drop(); }
});
