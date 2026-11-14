import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { ev, sess, ingest } from "./fixtures";
import { embedPending, newWorkerState } from "../src/worker";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";
import { search } from "../src/search";

const down: Embedder = { dims: 1024, embed: async () => { throw new EmbedderError("down", { transient: true }); } };

async function world(opts: { embedder?: Embedder } = {}) {
  const t = await authedApp({ embedder: opts.embedder });
  const post = async (p: string, b: any) => (await t.call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Acme" });
  const B = await post("/v1/clients", { name: "Beta" });
  const P1 = await post("/v1/projects", { clientId: A.id, name: "P1" });
  const P2 = await post("/v1/projects", { clientId: B.id, name: "P2" });
  const bind = async (repo: string, clientId: string | null, projectId?: string, status = "active", subpath = "") =>
    (await (await t.call("PUT", "/v1/bindings", { repo, subpath, status, clientId, projectId })).json()).binding;
  const b1 = await bind("github.com/a/one", A.id, P1.id), b2 = await bind("github.com/b/two", B.id, P2.id), b3 = await bind("github.com/a/three", A.id);
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
  const add = async (sid: string, binding: any, repo: string, text: string, ts: string) =>
    ingest(t, { sessions: [{ ...sess(sid, binding.id, { repo }), startedAt: ts }], events: [{ ...ev(sid, 1, "user", text), ts }] });
  await add("s1", b1, "github.com/a/one", "pricing tiers for the Acme dashboard, fixed the login bug on staging in auth/cookies.ts", day(1));
  await add("s2", b2, "github.com/b/two", "pricing for Beta Corp renewal", day(10));
  await add("s3", b3, "github.com/a/three", "pricing notes for Acme marketing", day(20));
  await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
  const searchRaw = (body: any) => t.call("POST", "/v1/search", body);
  const s = async (body: any) => {
    const res = await searchRaw(body);
    expect(res.status).toBe(200);
    return res.json();
  };
  return { t, A, B, P1, P2, bind, add, search: s, searchRaw, day };
}

test("a scope is required: a repo or an explicit open scope", async () => {
  const { t, searchRaw } = await world();
  try {
    const res = await searchRaw({ query: "pricing" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("scope_required");
  } finally { await t.drop(); }
});

test("project-bound folder sees only its project, even if it asks for another", async () => {
  const { t, B, P2, search } = await world();
  try {
    const r = await search({ query: "pricing", repo: "github.com/a/one", clientId: B.id, projectId: P2.id });
    expect(r.scope).toBe("project");
    expect(r.binding.projectId).toBeTruthy();
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.projectName).toBe("P1");
  } finally { await t.drop(); }
});

test("every spelling of a locked repo stays locked", async () => {
  const { t, search } = await world();
  try {
    for (const repo of ["GitHub.com/A/One", "github.com/a/one.git", "https://github.com/a/one", "git@github.com:a/one.git", "github.com/a/one/", " github.com/a/one"]) {
      const r = await search({ query: "pricing", repo });
      expect(r.scope).toBe("project");
      for (const h of r.hits) expect(h.projectName).toBe("P1");
    }
  } finally { await t.drop(); }
});

test("a declined subfolder inside a locked repo stays locked", async () => {
  const { t, bind, search } = await world();
  try {
    await bind("github.com/a/one", null, undefined, "declined", "scratch");
    const r = await search({ query: "pricing", repo: "github.com/a/one", subpath: "scratch/x" });
    expect(r.scope).toBe("project");
    expect(r.binding.status).toBe("declined");
  } finally { await t.drop(); }
});

test("client-only and unbound folders search all clients", async () => {
  const { t, search } = await world();
  try {
    for (const body of [{ repo: "github.com/a/three" }, { repo: "never-bound" }, { scope: "open" }]) {
      const r = await search({ query: "pricing", ...body });
      expect(r.scope).toBe("open");
      expect(new Set(r.hits.map((h: any) => h.sessionId))).toEqual(new Set(["s1", "s2", "s3"]));
    }
  } finally { await t.drop(); }
});

test("sessions held under a declined binding never appear", async () => {
  const { t, bind, add, search } = await world();
  try {
    const d = await bind("github.com/x/held", null, undefined, "declined");
    await add("held", d, "github.com/x/held", "pricing secret plans", new Date().toISOString());
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
    const r = await search({ query: "pricing", scope: "open" });
    expect(r.hits.map((h: any) => h.sessionId)).not.toContain("held");
  } finally { await t.drop(); }
});

test("open scope honours explicit filters", async () => {
  const { t, P2, B, search } = await world();
  try {
    expect((await search({ query: "pricing", scope: "open", projectId: P2.id })).hits.map((h: any) => h.sessionId)).toEqual(["s2"]);
    expect((await search({ query: "pricing", scope: "open", clientId: B.id })).hits.map((h: any) => h.clientName)).toEqual(["Beta"]);
  } finally { await t.drop(); }
});

test("date range filters by chunk time; an inverted range is 400", async () => {
  const { t, search, searchRaw, day } = await world();
  try {
    expect((await search({ query: "pricing", scope: "open", from: day(5), to: day(15) })).hits.map((h: any) => h.sessionId)).toEqual(["s2"]);
    expect((await searchRaw({ query: "pricing", scope: "open", from: day(15), to: day(5) })).status).toBe(400);
  } finally { await t.drop(); }
});

test("natural questions and file names match through full-text alone", async () => {
  const { t, search } = await world({ embedder: down });
  try {
    for (const q of ["how did we fix the login bug on staging?", "cookies.ts", "cookies", "Cookies", "auth"]) {
      const r = await search({ query: q, scope: "open" });
      expect(r.degraded).toBe(true);
      expect(r.hits.map((h: any) => h.sessionId)).toContain("s1");
    }
  } finally { await t.drop(); }
});

test("hits carry snippet, range, names and what matched", async () => {
  const { t, search } = await world();
  try {
    const [h] = (await search({ query: "renewal", scope: "open" })).hits;
    expect(h).toMatchObject({ sessionId: "s2", firstSeq: 1, lastSeq: 1, clientName: "Beta", projectName: "P2" });
    expect(h.matched).toEqual(expect.arrayContaining(["fts", "vec"]));
    expect(typeof h.distance).toBe("number");
    expect(h.snippet).toContain("renewal");
  } finally { await t.drop(); }
});

test("windows of one long message collapse into one hit", async () => {
  const { t, search } = await world();
  try {
    const { binding } = await (await t.call("PUT", "/v1/bindings", { repo: "github.com/a/long", subpath: "", status: "active", clientId: (await (await t.call("GET", "/v1/clients")).json()).clients[0].id })).json();
    await ingest(t, { sessions: [sess("long", binding.id, { repo: "github.com/a/long" })], events: [ev("long", 1, "assistant", "zebra ".repeat(1000))] });
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
    const r = await search({ query: "zebra", scope: "open" });
    expect(r.hits.filter((h: any) => h.sessionId === "long")).toHaveLength(1);
  } finally { await t.drop(); }
});

test("a small project among many still gets all its vector candidates", async () => {
  const { t, A, search } = await world();
  try {
    const big = await (await t.call("POST", "/v1/projects", { clientId: A.id, name: "Big" })).json();
    const { binding } = await (await t.call("PUT", "/v1/bindings", { repo: "github.com/a/big", subpath: "", status: "active", clientId: A.id, projectId: big.id })).json();
    const events = Array.from({ length: 400 }, (_, i) => ev("big", i + 1, "user", `pricing variant number ${i} ${"q".repeat(1200)}`));
    await ingest(t, { sessions: [sess("big", binding.id, { repo: "github.com/a/big" })], events });
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState(), limit: 1000 });
    const r = await search({ query: "pricing dashboard tiers", repo: "github.com/a/one" });
    expect(r.hits.filter((h: any) => h.matched.includes("vec")).map((h: any) => h.sessionId)).toEqual(["s1"]);
  } finally { await t.drop(); }
});

test("a slow query embedding is aborted and search falls back", async () => {
  const { t } = await world();
  try {
    let aborted = false;
    const hang: Embedder = { dims: 1024, embed: (_x, signal) => new Promise((_r, rej) => signal?.addEventListener("abort", () => { aborted = true; rej(new EmbedderError("aborted")); })) };
    const started = Date.now();
    const r = await search(t.sql, hang, { query: "pricing", scope: "open" }, { embedTimeoutMs: 100 });
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toContain("embedder");
    expect(aborted).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally { await t.drop(); }
});

test("awkward queries never 500", async () => {
  const { t, search } = await world();
  try {
    for (const q of ["", "   ", '"foo', "canción", "cancion", "a & b | !c", "'; drop table events; --", ":*", "\\", "the of and", "x\u0000y"]) {
      const r = await search({ query: q, scope: "open" });
      expect(Array.isArray(r.hits)).toBe(true);
    }
    expect((await search({ query: "  ", scope: "open" })).hits).toEqual([]);
    expect((await t.sql`select count(*)::int as n from events`)[0].n).toBe(3);
  } finally { await t.drop(); }
});

test("limit is capped at 50 and invalid bodies are 400", async () => {
  const { t, searchRaw } = await world();
  try {
    expect((await searchRaw({ query: "x", scope: "open", limit: 500 })).status).toBe(400);
    expect((await searchRaw({ nope: 1 })).status).toBe(400);
  } finally { await t.drop(); }
});
