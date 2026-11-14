import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";
import { indexPending } from "../src/indexer";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";

const broken: Embedder = { dims: 1024, embed: async () => { throw new EmbedderError("down"); } };
const status = async (t: any) => (await (await t.call("GET", "/v1/status")).json()).unindexedEvents;

async function seeded(t: any) {
  const { binding } = await boundFolder(t);
  const res = await t.call("POST", "/v1/ingest", {
    sessions: [sess("s1", binding.id)],
    events: [ev("s1", 1, "user", "plan the launch"), ev("s1", 2, "assistant", "ok"), ev("s1", 3, "tool_result", "big output", { toolName: "Bash" })],
  });
  expect(res.status).toBe(200);
}

test("indexes new events once", async () => {
  const t = await authedApp();
  try {
    await seeded(t);
    expect(await indexPending(t.sql, fakeEmbedder())).toEqual({ sessions: 1, chunks: 1, failed: 0 });
    expect(await indexPending(t.sql, fakeEmbedder())).toEqual({ sessions: 0, chunks: 0, failed: 0 });
    expect(await status(t)).toBe(0);
    const [{ n }] = await t.sql`select count(*)::int as n from chunks`;
    expect(n).toBe(1);
  } finally { await t.drop(); }
});

test("embedder outage leaves events pending, then recovers", async () => {
  const t = await authedApp({ embedder: broken });
  try {
    await seeded(t);
    expect(await indexPending(t.sql, broken)).toEqual({ sessions: 1, chunks: 0, failed: 1 });
    expect(await status(t)).toBe(3);
    expect(await indexPending(t.sql, fakeEmbedder())).toEqual({ sessions: 1, chunks: 1, failed: 0 });
    expect(await status(t)).toBe(0);
  } finally { await t.drop(); }
});

test("later events in the same session index into new chunks", async () => {
  const t = await authedApp();
  try {
    await seeded(t);
    await indexPending(t.sql, fakeEmbedder());
    await t.call("POST", "/v1/ingest", { sessions: [], events: [ev("s1", 4, "user", "follow up")] });
    expect((await indexPending(t.sql, fakeEmbedder())).chunks).toBe(1);
    const rows = await t.sql`select first_seq, last_seq from chunks order by first_seq`;
    expect(rows.map((r: any) => [r.first_seq, r.last_seq])).toEqual([[1, 2], [4, 4]]);
  } finally { await t.drop(); }
});

test("tool_result-only sessions get marked indexed with no chunks", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await t.call("POST", "/v1/ingest", { sessions: [sess("s9", binding.id)], events: [ev("s9", 1, "tool_result", "x", { toolName: "Read" })] });
    expect(await indexPending(t.sql, fakeEmbedder())).toEqual({ sessions: 1, chunks: 0, failed: 0 });
    expect(await status(t)).toBe(0);
  } finally { await t.drop(); }
});
