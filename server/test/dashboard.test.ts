import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { ev, sess, ingest } from "./fixtures";
import { createToken } from "../src/auth";
import { Metrics } from "../src/metrics";
import { embedPending, newWorkerState } from "../src/worker";
import { fakeEmbedder } from "../src/embed/fake";
import type { Embedder } from "../src/embed/embedder";
import { clientsOverview, dbStats } from "../src/dashboard";
import { WEB_UI_MACHINE } from "../src/http/app";

/** An app with a Mac token (t.call) and a web-ui token (ui). */
async function setup(opts: { embedder?: Embedder; metrics?: Metrics } = {}) {
  const metrics = opts.metrics ?? new Metrics();
  const t = await authedApp({ embedder: opts.embedder, deps: { metrics } });
  const { token: uiToken } = await createToken(t.sql, WEB_UI_MACHINE);
  const ui = (method: string, path: string, body?: unknown, tok: string | null = uiToken) => t.call(method, path, body, tok);
  return { t, ui, uiToken, metrics };
}

/** Two clients, a project each, sessions from two machines. */
async function world(t: any, opts: { embed?: boolean } = {}) {
  const post = async (p: string, b: any) => (await t.call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Acme" });
  const B = await post("/v1/clients", { name: "Beta" });
  const P1 = await post("/v1/projects", { clientId: A.id, name: "Shop" });
  const P2 = await post("/v1/projects", { clientId: B.id, name: "Portal" });
  await post("/v1/projects", { clientId: A.id, name: "Empty" });
  const bind = async (repo: string, clientId: string, projectId?: string) =>
    (await (await t.call("PUT", "/v1/bindings", { repo, subpath: "", status: "active", clientId, projectId })).json()).binding;
  const b1 = await bind("github.com/a/shop", A.id, P1.id);
  const b2 = await bind("github.com/b/portal", B.id, P2.id);
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 12)).toISOString();
  await ingest(t, {
    sessions: [
      { ...sess("s1", b1.id, { repo: "github.com/a/shop", cwd: "/work/shop" }), startedAt: day(1) },
      { ...sess("s2", b2.id, { repo: "github.com/b/portal", cwd: "/work/portal" }), startedAt: day(5) },
    ],
    events: [
      { ...ev("s1", 1, "user", "checkout pricing for the shop"), ts: day(1) },
      { ...ev("s1", 2, "assistant", "fixed the checkout totals"), ts: day(2) },
      { ...ev("s2", 1, "user", "checkout flow for the portal"), ts: day(5) },
    ],
  });
  if (opts.embed !== false) await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
  return { A, B, P1, P2, b1, b2, day };
}

test("dashboard routes need a token", async () => {
  const { t, ui } = await setup();
  try {
    for (const [m, p] of [["GET", "/v1/dashboard/overview"], ["GET", "/v1/dashboard/db"], ["GET", "/v1/dashboard/clients"],
      ["POST", "/v1/dashboard/search"], ["GET", "/v1/dashboard/sessions/s1/summaries"], ["POST", "/v1/dashboard/chat"]]) {
      const res = await ui(m, p, m === "POST" ? { query: "x" } : undefined, null);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    }
    expect((await ui("GET", "/v1/dashboard/overview", undefined, "cbr_wrong")).status).toBe(401);
  } finally { await t.drop(); }
});

test("a Mac's token is refused on dashboard routes", async () => {
  const { t } = await setup();
  try {
    const res = await t.call("GET", "/v1/dashboard/overview");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  } finally { await t.drop(); }
});

test("the web-ui token is dashboard-only: no ingest, search, reads or status", async () => {
  const { t, ui } = await setup();
  try {
    for (const [m, p, b] of [["POST", "/v1/ingest", { sessions: [], events: [] }], ["POST", "/v1/search", { query: "x", scope: "open" }],
      ["GET", "/v1/sessions?scope=open"], ["GET", "/v1/status"], ["GET", "/v1/clients"]] as const) {
      const res = await ui(m, p, b);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
    }
  } finally { await t.drop(); }
});

test("a revoked web-ui token is told so", async () => {
  const { t, ui } = await setup();
  try {
    await t.sql`update machines set revoked_at = now() where name = ${WEB_UI_MACHINE}`;
    const res = await ui("GET", "/v1/dashboard/overview");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token_revoked");
  } finally { await t.drop(); }
});

test("overview: health, the same status /v1/status computes, query rates, throughput and chat usage", async () => {
  const { t, ui, metrics } = await setup();
  try {
    await world(t);
    const status = await (await t.call("GET", "/v1/status")).json();
    const res = await ui("GET", "/v1/dashboard/overview");
    expect(res.status).toBe(200);
    const o = await res.json();
    const [{ instance_id }] = await t.sql`select instance_id from settings`;
    expect(o.health).toMatchObject({ db: true, apiVersion: 1, instanceId: instance_id, startedAt: metrics.startedAt });
    expect(typeof o.health.uptimeSeconds).toBe("number");
    const { machine, ...rest } = status;
    expect(machine).toBe("test-mac");
    expect(o.status).toEqual(rest);
    expect(o.queries.perMinute).toEqual({ m1: 0, m5: 0, m15: 0 });
    expect(o.queries.active).toEqual([]);
    expect(Array.isArray(o.queries.database)).toBe(true);
    expect(o.throughput.eventsPerMinute).toBe(3);
    expect(o.throughput.chunksEmbeddedPerMinute).toBe(0); // embedded outside the app's worker
    expect(o.throughput.summariesLastHour).toBe(0);
    expect(o.throughput.queues.embed).toEqual({ pending: 0, dead: 0 });
    expect(o.throughput.queues.summary).toEqual({ live: 0, imported: 0, dead: 0 });
    expect(o.chat.window).toEqual({ hours: 5, tokens: 0, runs: 0 });
  } finally { await t.drop(); }
});

test("client searches count per minute and show as in flight while they run", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const slow: Embedder = { dims: 1024, embed: async (texts) => { await held; return fakeEmbedder().embed(texts); } };
  const { t, ui } = await setup({ embedder: slow });
  try {
    await world(t, { embed: false });
    const pending = t.call("POST", "/v1/search", { query: "checkout pricing", scope: "open" });
    await Bun.sleep(50);
    const during = await (await ui("GET", "/v1/dashboard/overview")).json();
    expect(during.queries.active).toHaveLength(1);
    expect(during.queries.active[0]).toMatchObject({ query: "checkout pricing", machine: "test-mac" });
    release();
    expect((await pending).status).toBe(200);
    const after = await (await ui("GET", "/v1/dashboard/overview")).json();
    expect(after.queries.active).toEqual([]);
    expect(after.queries.perMinute).toEqual({ m1: 1, m5: 1, m15: 1 });
  } finally { release(); await t.drop(); }
});

test("the worker's embedded chunks feed chunks per minute", async () => {
  const metrics = new Metrics();
  const { t, ui } = await setup({ metrics });
  try {
    await world(t, { embed: false });
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState(), onEmbedded: (n) => metrics.chunks.add(n) });
    const o = await (await ui("GET", "/v1/dashboard/overview")).json();
    const [{ n }] = await t.sql`select count(*)::int as n from chunk_embeddings`;
    expect(n).toBeGreaterThan(0);
    expect(o.throughput.chunksEmbeddedPerMinute).toBe(n);
  } finally { await t.drop(); }
});

test("summaries per hour and queue depths come from the database", async () => {
  const { t, ui } = await setup();
  try {
    const { b1 } = await world(t, { embed: false });
    await t.sql`insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
                select 's1', 'session', ${b1.id}, client_id, project_id, 1, 2, now(), now(), 'T', '{}'::jsonb, 'x', 'm' from bindings where id = ${b1.id}`;
    await t.sql`insert into summary_jobs (session_id, priority) values ('s2', 1)`;
    const o = await (await ui("GET", "/v1/dashboard/overview")).json();
    expect(o.throughput.summariesLastHour).toBe(1);
    expect(o.throughput.queues.summary).toEqual({ live: 0, imported: 1, dead: 0 });
    expect(o.throughput.queues.embed.pending).toBeGreaterThan(0);
  } finally { await t.drop(); }
});

test("database size and exact row counts", async () => {
  const { t, ui } = await setup();
  try {
    await world(t, { embed: false });
    const direct = await dbStats(t.sql);
    expect(direct.bytes).toBeGreaterThan(0);
    expect(direct.counts).toMatchObject({ sessions: 2, events: 3, summaries: 0, clients: 3, projects: 3 }); // + the seeded Personal client
    expect(direct.counts.chunks).toBeGreaterThan(0);
    const res = await ui("GET", "/v1/dashboard/db");
    expect(res.status).toBe(200);
    expect((await res.json()).counts).toEqual(direct.counts);
  } finally { await t.drop(); }
});

test("clients: projects with sessions per machine and last activity", async () => {
  const { t, ui } = await setup();
  try {
    const { day } = await world(t, { embed: false });
    // A second machine's session in Acme / Shop.
    const { token: mini } = await createToken(t.sql, "mac-mini");
    const [b1] = await t.sql`select id from bindings where repo = 'github.com/a/shop'`;
    const r = await t.call("POST", "/v1/ingest", { sessions: [{ ...sess("s3", b1.id, { repo: "github.com/a/shop" }), startedAt: day(9) }], events: [] }, mini);
    expect(r.status).toBe(200);
    const direct = await clientsOverview(t.sql);
    const res = await ui("GET", "/v1/dashboard/clients");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(direct)));
    const acme = body.clients.find((c: any) => c.name === "Acme");
    expect(acme.sessions).toBe(2);
    expect(acme.lastActivityAt).toBe(day(9));
    const shop = acme.projects.find((p: any) => p.name === "Shop");
    expect(shop.machines).toEqual([
      { machine: "mac-mini", sessions: 1, lastActivityAt: day(9) },
      { machine: "test-mac", sessions: 1, lastActivityAt: new Date(Date.UTC(2026, 9, 2, 12)).toISOString() },
    ]);
    expect(acme.projects.find((p: any) => p.name === "Empty")).toMatchObject({ sessions: 0, machines: [], lastActivityAt: null });
    expect(body.clients.find((c: any) => c.name === "Personal")).toMatchObject({ sessions: 0, projects: [] });
  } finally { await t.drop(); }
});

test("global search is unscoped: hits from every client, with machine, cwd, session and date", async () => {
  const { t, ui } = await setup();
  try {
    await world(t);
    const res = await ui("POST", "/v1/dashboard/search", { query: "checkout" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("open");
    const clients = new Set(body.hits.map((h: any) => h.clientName));
    expect(clients).toEqual(new Set(["Acme", "Beta"]));
    const h = body.hits.find((x: any) => x.sessionId === "s2");
    expect(h).toMatchObject({ clientName: "Beta", projectName: "Portal", machine: "test-mac", cwd: "/work/portal", repo: "github.com/b/portal" });
    expect(typeof h.snippet).toBe("string");
    expect(h.tsFrom).toBeTruthy();
  } finally { await t.drop(); }
});

test("global search takes no scope fields and is counted as a search", async () => {
  const { t, ui } = await setup();
  try {
    await world(t);
    for (const extra of [{ repo: "github.com/a/shop" }, { scope: "open" }, { clientId: crypto.randomUUID() }]) {
      const res = await ui("POST", "/v1/dashboard/search", { query: "checkout", ...extra });
      expect(res.status).toBe(400);
    }
    expect((await ui("POST", "/v1/dashboard/search", {})).status).toBe(400);
    await ui("POST", "/v1/dashboard/search", { query: "checkout", limit: 5, include: "raw" });
    const o = await (await ui("GET", "/v1/dashboard/overview")).json();
    expect(o.queries.perMinute.m1).toBe(1);
  } finally { await t.drop(); }
});

test("the client search's scope rules are unchanged: no repo and no open scope is still refused", async () => {
  const { t } = await setup();
  try {
    const res = await t.call("POST", "/v1/search", { query: "checkout" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("scope_required");
  } finally { await t.drop(); }
});

test("a session's summaries, oldest range first; 404 for an unknown session", async () => {
  const { t, ui } = await setup();
  try {
    const { b1 } = await world(t, { embed: false });
    const body = JSON.stringify({ overview: "Fixed checkout totals", decisions: ["round half up"], facts: ["uses cents"], changes: [], open_threads: [] });
    for (const [first, last, title] of [[3, 4, "Second"], [1, 2, "First"]] as const) {
      await t.sql`insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
                  select 's1', 'session', ${b1.id}, client_id, project_id, ${first}, ${last}, now(), now(), ${title}, ${body}::text::jsonb, 'x', 'm'
                  from bindings where id = ${b1.id}`;
    }
    const res = await ui("GET", "/v1/dashboard/sessions/s1/summaries");
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.session).toMatchObject({ id: "s1", clientName: "Acme", projectName: "Shop", machine: "test-mac", cwd: "/work/shop" });
    expect(r.summaries.map((s: any) => s.title)).toEqual(["First", "Second"]);
    expect(r.summaries[0]).toMatchObject({ overview: "Fixed checkout totals", decisions: ["round half up"], facts: ["uses cents"] });
    expect((await ui("GET", "/v1/dashboard/sessions/nope/summaries")).status).toBe(404);
  } finally { await t.drop(); }
});
