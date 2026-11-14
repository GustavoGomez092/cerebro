import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { embedPending, EmbedGate, newWorkerState } from "../src/worker";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";

async function seed(t: any, sessions: { id: string; imported?: boolean; texts: string[] }[]) {
  const { binding } = await boundFolder(t);
  await ingest(t, {
    sessions: sessions.map((s) => sess(s.id, binding.id, { imported: !!s.imported })),
    events: sessions.flatMap((s) => s.texts.map((x, i) => ev(s.id, i + 1, "user", x + " " + "w".repeat(1000)))),
  });
}
const count = async (t: any, q: string) => (await t.sql.unsafe(q))[0].n;

test("embeds queued chunks once and empties the queue", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["a", "b", "c"] }]);
    const r = await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
    expect(r).toMatchObject({ claimed: 3, embedded: 3, failed: 0, paused: false });
    expect(await count(t, "select count(*)::int n from chunk_embeddings")).toBe(3);
    expect(await count(t, "select count(*)::int n from embed_queue")).toBe(0);
    expect((await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() })).claimed).toBe(0);
  } finally { await t.drop(); }
});

test("a poison chunk dead-letters while the others embed", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["fine one", "POISON", "fine two"] }]);
    const picky: Embedder = {
      dims: 1024,
      embed: async (xs) => { if (xs.some((x) => x.includes("POISON"))) throw new EmbedderError("bad input"); return fakeEmbedder().embed(xs); },
    };
    const state = newWorkerState();
    const r1 = await embedPending(t.sql, picky, { state, maxAttempts: 2 });
    expect(r1).toMatchObject({ embedded: 2, failed: 1 });
    await t.sql`update embed_queue set next_attempt_at = now()`;
    const r2 = await embedPending(t.sql, picky, { state: newWorkerState(), maxAttempts: 2 });
    expect(r2).toMatchObject({ claimed: 1, failed: 1, dead: 1 });
    const [q] = await t.sql`select attempts, dead, last_error from embed_queue`;
    expect(q).toMatchObject({ attempts: 2, dead: true });
    expect(q.last_error).toContain("bad input");
    expect((await embedPending(t.sql, picky, { state: newWorkerState() })).claimed).toBe(0);
  } finally { await t.drop(); }
});

test("two workers never embed the same chunk", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: Array.from({ length: 12 }, (_, i) => `chunk${i}`) }]);
    const seen: string[] = [];
    const slow: Embedder = { dims: 1024, embed: async (xs) => { seen.push(...xs); await Bun.sleep(20); return fakeEmbedder().embed(xs); } };
    const [a, b] = await Promise.all([
      embedPending(t.sql, slow, { state: newWorkerState(), limit: 8, maxBatch: 2 }),
      embedPending(t.sql, slow, { state: newWorkerState(), limit: 8, maxBatch: 2 }),
    ]);
    expect(a.embedded + b.embedded).toBe(12);
    expect(new Set(seen).size).toBe(seen.length);
  } finally { await t.drop(); }
});

test("live chunks are embedded before imported history", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "old", imported: true, texts: ["o1", "o2", "o3"] }, { id: "live", texts: ["l1"] }]);
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState(), limit: 1 });
    const [r] = await t.sql`select c.session_id from chunk_embeddings e join chunks c on c.id = e.chunk_id`;
    expect(r.session_id).toBe("live");
  } finally { await t.drop(); }
});

test("an unreachable embedder pauses the worker without burning attempts", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["a", "b"] }]);
    const down: Embedder = { dims: 1024, embed: async () => { throw new EmbedderError("connection refused", { transient: true }); } };
    const state = newWorkerState();
    expect(await embedPending(t.sql, down, { state })).toMatchObject({ paused: true, embedded: 0 });
    const rows = await t.sql`select attempts, locked_until from embed_queue`;
    expect(rows.every((r: any) => r.attempts === 0 && r.locked_until === null)).toBe(true);
    expect(state.lastError).toContain("connection refused");
    expect(await embedPending(t.sql, fakeEmbedder(), { state })).toMatchObject({ paused: true, claimed: 0 });
    state.pausedUntil = 0;
    expect((await embedPending(t.sql, fakeEmbedder(), { state })).embedded).toBe(2);
    expect(state.lastSuccessAt).not.toBeNull();
  } finally { await t.drop(); }
});

test("the worker yields while a search is embedding", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["a"] }]);
    const gate = new EmbedGate();
    let calls = 0;
    const counting: Embedder = { dims: 1024, embed: async (xs) => { calls++; return fakeEmbedder().embed(xs); } };
    gate.enter();
    const run = embedPending(t.sql, counting, { state: newWorkerState(), gate });
    await Bun.sleep(80);
    expect(calls).toBe(0);
    gate.leave();
    expect((await run).embedded).toBe(1);
  } finally { await t.drop(); }
});

test("status reports queue health", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["a", "b"] }]);
    const s = await (await t.call("GET", "/v1/status")).json();
    expect(s).toMatchObject({ machine: "test-mac", queue: { pending: 2, dead: 0 } });
    expect(typeof s.queue.oldestPendingSeconds).toBe("number");
    expect(s.dbBytes).toBeGreaterThan(0);
    expect(s.embedder).toHaveProperty("lastSuccessAt");
  } finally { await t.drop(); }
});

test("a 200 KB message embeds end to end", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("huge", binding.id)], events: [ev("huge", 1, "assistant", "z ".repeat(100_000))] });
    const r = await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState(), limit: 100 });
    expect(r.failed).toBe(0);
    expect(r.embedded).toBeGreaterThan(15);
  } finally { await t.drop(); }
});

test("by default the worker sends one chunk per embed call, so a query never waits behind a batch", async () => {
  const t = await authedApp();
  try {
    await seed(t, [{ id: "s1", texts: ["a", "b", "c"] }]);
    const sizes: number[] = [];
    const spy: Embedder = { dims: 1024, embed: async (xs, s) => { sizes.push(xs.length); return fakeEmbedder().embed(xs, s); } };
    const r = await embedPending(t.sql, spy, { state: newWorkerState() });
    expect(r.embedded).toBe(3);
    expect(sizes).toEqual([1, 1, 1]);
  } finally { await t.drop(); }
});
