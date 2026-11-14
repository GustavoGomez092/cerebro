import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { embedPending, newWorkerState } from "../src/worker";
import { EmbedderError, type Embedder } from "../src/embed/embedder";
import { fakeEmbedder } from "../src/embed/fake";
import { redactSession } from "../src/redact-session";
import { requeueDead } from "../src/worker";

const deep = (n: number) => { let v: any = "x"; for (let i = 0; i < n; i++) v = { d: v }; return v; };

test("deeply nested unknown fields and session meta are rejected per item, not 500", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const r = await ingest(t, {
      sessions: [sess("s1", binding.id), sess("s2", binding.id, { meta: deep(20_000) })],
      events: [ev("s1", 1, "user", "ok"), { ...ev("s1", 2, "user", "x"), extra: deep(20_000) }],
    });
    expect(r.inserted).toBe(1);
    expect(r.rejected).toEqual(expect.arrayContaining([
      { sessionId: "s2", code: "invalid_session" },
      { key: "s1:2", sessionId: "s1", code: "too_deep" },
    ]));
  } finally { await t.drop(); }
});

test("the same session twice in one batch is merged, not 500", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const r = await ingest(t, { sessions: [sess("s1", binding.id), sess("s1", binding.id, { cwd: "/other" })], events: [ev("s1", 1, "user", "x")] });
    expect(r).toMatchObject({ inserted: 1, rejected: [] });
  } finally { await t.drop(); }
});

test("an embedder failing every item the same way pauses instead of dead-lettering the queue", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [1, 2, 3].map((i) => ev("s1", i, "user", `m${i} ${"w".repeat(1000)}`)) });
    const missingModel: Embedder = { dims: 1024, embed: async () => { throw new EmbedderError("embedder returned 400: model not found"); } };
    const state = newWorkerState();
    const r = await embedPending(t.sql, missingModel, { state, maxAttempts: 1 });
    expect(r.paused).toBe(true);
    const rows = await t.sql`select attempts, dead from embed_queue`;
    expect(rows.every((x: any) => x.attempts === 0 && !x.dead)).toBe(true);
  } finally { await t.drop(); }
});

test("404 and 500 from Ollama are transient", async () => {
  const { ollamaEmbedder } = await import("../src/embed/ollama");
  for (const status of [404, 500]) {
    const e = ollamaEmbedder("http://o", "m", 3, (async () => new Response("", { status })) as any);
    expect(await e.embed(["a"]).catch((err) => err.transient)).toBe(true);
  }
});

test("dead-lettered chunks can be requeued", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [ev("s1", 1, "user", "x")] });
    await t.sql`update embed_queue set dead = true, attempts = 5`;
    expect(await requeueDead(t.sql)).toBe(1);
    expect((await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() })).embedded).toBe(1);
  } finally { await t.drop(); }
});

test("redact-session scrubs meta, session meta and cwd too", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("s1", binding.id, { cwd: "/w/MYSECRETVALUE123", note: "MYSECRETVALUE123" })],
      events: [ev("s1", 1, "assistant", "hi", { meta: { thinking: "the key is MYSECRETVALUE123" } })],
    });
    await redactSession(t.sql, "s1", "MYSECRETVALUE123");
    const dump = JSON.stringify(await t.sql`select meta from events`) + JSON.stringify(await t.sql`select meta, cwd from sessions`);
    expect(dump).not.toContain("MYSECRETVALUE123");
  } finally { await t.drop(); }
});
