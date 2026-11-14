import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { ev, sess } from "./fixtures";
import { indexPending } from "../src/indexer";
import { fakeEmbedder } from "../src/embed/fake";

async function world() {
  const t = await authedApp();
  const post = async (p: string, b: any) => (await t.call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Acme" });
  const B = await post("/v1/clients", { name: "Beta" });
  const P1 = await post("/v1/projects", { clientId: A.id, name: "P1" });
  const P2 = await post("/v1/projects", { clientId: B.id, name: "P2" });
  const bind = async (repo: string, clientId: string, projectId?: string) =>
    (await (await t.call("PUT", "/v1/bindings", { repo, subpath: "", status: "active", clientId, projectId })).json()).binding;
  const b1 = await bind("r1", A.id, P1.id), b2 = await bind("r2", B.id, P2.id), b3 = await bind("r3", A.id);
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
  const add = async (sid: string, bindingId: string, text: string, ts: string) => {
    const r = await t.call("POST", "/v1/ingest", {
      sessions: [{ ...sess(sid, bindingId), startedAt: ts }],
      events: [{ ...ev(sid, 1, "user", text), ts }],
    });
    expect(r.status).toBe(200);
  };
  await add("s1", b1.id, "pricing tiers for the Acme dashboard", day(1));
  await add("s2", b2.id, "pricing for Beta Corp renewal", day(10));
  await add("s3", b3.id, "pricing notes for Acme marketing", day(20));
  await indexPending(t.sql, fakeEmbedder());
  const search = async (body: any) => {
    const res = await t.call("POST", "/v1/search", body);
    expect(res.status).toBe(200);
    return res.json();
  };
  return { t, A, B, P1, P2, search, day };
}

test("project-bound folder sees only its project, even if it asks for another", async () => {
  const { t, B, P2, search } = await world();
  try {
    const r = await search({ query: "pricing", repo: "r1", clientId: B.id, projectId: P2.id });
    expect(r.scope).toBe("project");
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.projectName).toBe("P1");
  } finally { await t.drop(); }
});

test("client-only and unbound folders search all clients", async () => {
  const { t, search } = await world();
  try {
    for (const repo of ["r3", "never-bound"]) {
      const r = await search({ query: "pricing", repo });
      expect(r.scope).toBe("open");
      expect(new Set(r.hits.map((h: any) => h.sessionId))).toEqual(new Set(["s1", "s2", "s3"]));
    }
  } finally { await t.drop(); }
});

test("open scope honours explicit filters", async () => {
  const { t, P2, B, search } = await world();
  try {
    expect((await search({ query: "pricing", projectId: P2.id })).hits.map((h: any) => h.sessionId)).toEqual(["s2"]);
    expect((await search({ query: "pricing", clientId: B.id })).hits.map((h: any) => h.clientName)).toEqual(["Beta"]);
  } finally { await t.drop(); }
});

test("date range filters by chunk time", async () => {
  const { t, search, day } = await world();
  try {
    const r = await search({ query: "pricing", from: day(5), to: day(15) });
    expect(r.hits.map((h: any) => h.sessionId)).toEqual(["s2"]);
  } finally { await t.drop(); }
});

test("hits carry snippet, range and names", async () => {
  const { t, search } = await world();
  try {
    const [h] = (await search({ query: "renewal" })).hits;
    expect(h).toMatchObject({ sessionId: "s2", firstSeq: 1, lastSeq: 1, clientName: "Beta", projectName: "P2" });
    expect(h.snippet).toContain("renewal");
    expect(typeof h.score).toBe("number");
  } finally { await t.drop(); }
});

test("awkward queries never 500", async () => {
  const { t, search } = await world();
  try {
    for (const q of ["", "   ", '"foo', "canción", "a & b | !c", "'; drop table events; --", ":*", "\\"]) {
      const r = await search({ query: q });
      expect(Array.isArray(r.hits)).toBe(true);
    }
    expect((await search({ query: "  " })).hits).toEqual([]);
    const [{ n }] = await t.sql`select count(*)::int as n from events`;
    expect(n).toBe(3);
  } finally { await t.drop(); }
});

test("vector match finds a hit without an exact full-text match", async () => {
  const { t, search } = await world();
  try {
    // "dashboards" (plural) does not match the tsvector token "dashboard" under the 'simple' config,
    // but the query shares "acme" with s1's text, so the vector list still surfaces s1.
    const r = await search({ query: "acme dashboards", repo: "r1" });
    expect(r.hits.map((h: any) => h.sessionId)).toEqual(["s1"]);
  } finally { await t.drop(); }
});

test("limit is capped at 50 and invalid bodies are 400", async () => {
  const { t } = await world();
  try {
    expect((await t.call("POST", "/v1/search", { query: "x", limit: 500 })).status).toBe(400);
    expect((await t.call("POST", "/v1/search", { nope: 1 })).status).toBe(400);
  } finally { await t.drop(); }
});
