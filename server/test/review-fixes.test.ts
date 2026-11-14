import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";
import { indexPending } from "../src/indexer";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";
import { ollamaEmbedder } from "../src/embed/ollama";
import { search } from "../src/search";

test("NUL characters in text and tool input are stored, not rejected", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const res = await t.call("POST", "/v1/ingest", {
      sessions: [sess("s1", binding.id)],
      events: [
        ev("s1", 1, "tool_result", "a\u0000b", { toolName: "Bash" }),
        ev("s1", 2, "tool_call", "", { toolName: "Bash", toolInput: { command: "find . -print0\u0000" } }),
      ],
    });
    expect(res.status).toBe(200);
    const rows = await t.sql`select text, tool_input->>'command' as cmd from events order by seq`;
    expect(rows[0].text).toBe("a�b");
    expect(rows[1].cmd).toBe("find . -print0�");
  } finally { await t.drop(); }
});

test("subpaths are normalised so slashes cannot dodge a project lock", async () => {
  const t = await authedApp();
  try {
    const A = await (await t.call("POST", "/v1/clients", { name: "Acme" })).json();
    const P = await (await t.call("POST", "/v1/projects", { clientId: A.id, name: "Web" })).json();
    await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "", status: "active", clientId: A.id });
    const put = await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "/apps//web/", status: "active", clientId: A.id, projectId: P.id });
    expect((await put.json()).binding.subpath).toBe("apps/web");
    for (const sub of ["apps/web", "apps/web/", "/apps/web/src", "./apps/web"]) {
      const { binding } = await (await t.call("GET", `/v1/bindings/resolve?repo=r&subpath=${encodeURIComponent(sub)}`)).json();
      expect(binding.projectId).toBe(P.id);
    }
    expect((await t.call("PUT", "/v1/bindings", { repo: "r", subpath: "apps/../secret", status: "active", clientId: A.id })).status).toBe(400);
    const r = await (await t.call("POST", "/v1/search", { query: "x", repo: "r", subpath: "apps/web/" })).json();
    expect(r.scope).toBe("project");
  } finally { await t.drop(); }
});

test("declining a folder that already has history is refused", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t, { repo: "hist" });
    await t.call("POST", "/v1/ingest", { sessions: [sess("s1", binding.id)], events: [] });
    const res = await t.call("PUT", "/v1/bindings", { repo: "hist", subpath: "", status: "declined" });
    expect(res.status).toBe(409);
    const [b] = await t.sql`select status from bindings where id = ${binding.id}`;
    expect(b.status).toBe("active");
  } finally { await t.drop(); }
});

test("a hanging embedder makes search fall back instead of hanging", async () => {
  const t = await authedApp();
  try {
    const hang: Embedder = { dims: 1024, embed: () => new Promise(() => {}) };
    const started = Date.now();
    const r = await search(t.sql, hang, { query: "anything" }, { embedTimeoutMs: 100 });
    expect(r.degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { await t.drop(); }
});

test("ollama embedder times out and treats a bad body as EmbedderError", async () => {
  const slow = ollamaEmbedder("http://o", "m", 3, ((_u: string, init: any) => new Promise((_res, rej) => {
    init.signal.addEventListener("abort", () => rej(init.signal.reason));
  })) as any, 50);
  await expect(slow.embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
  const garbage = ollamaEmbedder("http://o", "m", 3, (async () => new Response("<html>")) as any);
  await expect(garbage.embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
});

test("a failing session backs off and does not block others", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await t.call("POST", "/v1/ingest", { sessions: [sess("bad", binding.id), sess("good", binding.id)], events: [ev("bad", 1, "user", "POISON"), ev("good", 1, "user", "fine")] });
    const picky: Embedder = { dims: 1024, embed: async (xs) => { if (xs.some((x) => x.includes("POISON"))) throw new EmbedderError("nope"); return fakeEmbedder().embed(xs); } };
    const backoff = new Map();
    expect(await indexPending(t.sql, picky, { backoff })).toEqual({ sessions: 2, chunks: 1, failed: 1 });
    expect(await indexPending(t.sql, picky, { backoff })).toEqual({ sessions: 0, chunks: 0, failed: 0 });
    expect(backoff.get("bad").failures).toBe(1);
  } finally { await t.drop(); }
});

test("indexing is capped per session per run", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const events = Array.from({ length: 30 }, (_, i) => ev("big", i + 1, "user", `message ${i + 1} ${"y".repeat(1000)}`));
    await t.call("POST", "/v1/ingest", { sessions: [sess("big", binding.id)], events });
    await indexPending(t.sql, fakeEmbedder(), { maxEventsPerSession: 10 });
    const [{ n }] = await t.sql`select count(*)::int as n from events where not indexed`;
    expect(n).toBe(20);
  } finally { await t.drop(); }
});

test("a 200 KB event indexes end to end", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await t.call("POST", "/v1/ingest", { sessions: [sess("huge", binding.id)], events: [ev("huge", 1, "assistant", "z ".repeat(100_000))] });
    const r = await indexPending(t.sql, fakeEmbedder());
    expect(r.failed).toBe(0);
    expect(r.chunks).toBeGreaterThan(100);
  } finally { await t.drop(); }
});

test("out-of-range seq and bad dates are 400, not 500", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    expect((await t.call("POST", "/v1/ingest", { sessions: [sess("s1", binding.id)], events: [ev("s1", 2 ** 31, "user", "x")] })).status).toBe(400);
    expect((await t.call("GET", "/v1/sessions?from=1")).status).toBe(400);
    expect((await t.call("GET", "/v1/sessions?to=yesterday")).status).toBe(400);
  } finally { await t.drop(); }
});
