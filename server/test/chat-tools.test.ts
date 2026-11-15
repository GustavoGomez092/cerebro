import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { ev, sess, ingest } from "./fixtures";
import { Metrics } from "../src/metrics";
import { embedPending, newWorkerState } from "../src/worker";
import { fakeEmbedder } from "../src/embed/fake";
import { CHAT_TOOLS, callTool } from "../src/chat/tools";
import { ChatRuns } from "../src/chat/runs";

async function world() {
  const metrics = new Metrics();
  const runs = new ChatRuns(1);
  const t = await authedApp({ deps: { metrics, chat: { runs, model: "sonnet", timeoutMs: 5000, mcpUrl: "http://127.0.0.1:1/mcp/chat" } } });
  const post = async (p: string, b: any) => (await t.call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Cadco" });
  const B = await post("/v1/clients", { name: "Beta" });
  const P1 = await post("/v1/projects", { clientId: A.id, name: "EDA 2.0" });
  const P2 = await post("/v1/projects", { clientId: B.id, name: "Portal" });
  await post("/v1/projects", { clientId: B.id, name: "EDA 2.0" }); // same project name under another client
  const bind = async (repo: string, clientId: string, projectId?: string, status = "active") =>
    (await (await t.call("PUT", "/v1/bindings", { repo, subpath: "", status, clientId, projectId })).json()).binding;
  const b1 = await bind("github.com/cadco/eda", A.id, P1.id);
  const b2 = await bind("github.com/beta/portal", B.id, P2.id);
  const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12)).toISOString();
  await ingest(t, {
    sessions: [
      { ...sess("s1", b1.id, { repo: "github.com/cadco/eda", cwd: "/work/eda" }), startedAt: day(3) },
      { ...sess("s2", b2.id, { repo: "github.com/beta/portal", cwd: "/work/portal" }), startedAt: day(10) },
    ],
    events: [
      { ...ev("s1", 1, "user", "wordpress checkout for cadco"), ts: day(3) },
      { ...ev("s1", 2, "assistant", "moved the checkout to woocommerce " + "y".repeat(5000)), ts: day(3) },
      { ...ev("s2", 1, "user", "wordpress theme for the beta portal"), ts: day(10) },
    ],
  });
  await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
  const ctx = { sql: t.sql, embedder: t.embedder, metrics, machine: "web-ui" };
  const call = async (name: string, args: unknown) => callTool(ctx, name, args);
  const json = async (name: string, args: unknown) => {
    const r = await call(name, args);
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.text);
  };
  return { t, A, B, P1, P2, b1, b2, day, call, json, metrics, runs };
}

test("the chat has exactly the six read-only tools, each with an input schema", () => {
  expect(CHAT_TOOLS.map((x) => x.name).sort()).toEqual(
    ["get_project_state", "get_session_events", "get_session_summary", "global_search", "list_clients_projects", "recent_sessions"]);
  for (const tool of CHAT_TOOLS) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe("object");
  }
});

test("global_search spans every client, narrows by client and project name, and counts as a search", async () => {
  const w = await world();
  try {
    const all = await w.json("global_search", { query: "wordpress" });
    expect(new Set(all.hits.map((h: any) => h.client))).toEqual(new Set(["Cadco", "Beta"]));
    const h = all.hits.find((x: any) => x.sessionId === "s1");
    expect(h).toMatchObject({ client: "Cadco", project: "EDA 2.0", machine: "test-mac", cwd: "/work/eda" });
    expect(h.date).toMatch(/^2026-11-03/);
    const cadco = await w.json("global_search", { query: "wordpress", client: "cadco" });
    expect(cadco.hits.every((x: any) => x.client === "Cadco")).toBe(true);
    const portal = await w.json("global_search", { query: "wordpress", client: "Beta", project: "portal", limit: 1 });
    expect(portal.hits).toHaveLength(1);
    expect(portal.hits[0].project).toBe("Portal");
    expect(w.metrics.searchRates().m1).toBe(3);
  } finally { await w.t.drop(); }
});

test("global_search explains an unknown or ambiguous name instead of guessing", async () => {
  const w = await world();
  try {
    const unknown = await w.call("global_search", { query: "x", client: "Nobody" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/list_clients_projects/);
    const ambiguous = await w.call("global_search", { query: "x", project: "EDA 2.0" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/Cadco.*Beta|Beta.*Cadco/);
  } finally { await w.t.drop(); }
});

test("bad arguments are a tool error, not a crash", async () => {
  const w = await world();
  try {
    for (const [name, args] of [["global_search", {}], ["global_search", { query: "x", limit: 500 }], ["get_session_events", { session_id: "s1", limit: 10_000 }],
      ["nope", {}], ["recent_sessions", { since: "last tuesday" }]] as const) {
      const r = await w.call(name, args);
      expect(r.isError).toBe(true);
    }
  } finally { await w.t.drop(); }
});

test("list_clients_projects lists clients, projects, machines and last activity", async () => {
  const w = await world();
  try {
    const r = await w.json("list_clients_projects", {});
    const cadco = r.clients.find((c: any) => c.name === "Cadco");
    expect(cadco.sessions).toBe(1);
    expect(cadco.projects[0]).toMatchObject({ name: "EDA 2.0", sessions: 1, machines: [{ machine: "test-mac", sessions: 1 }] });
  } finally { await w.t.drop(); }
});

test("get_session_summary returns the session and its summaries; unknown sessions say so", async () => {
  const w = await world();
  try {
    await w.t.sql`insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
                  values ('s1', 'session', ${w.b1.id}, ${w.A.id}, ${w.P1.id}, 1, 2, now(), now(), 'Checkout move',
                          ${JSON.stringify({ overview: "Moved checkout to WooCommerce" })}::text::jsonb, 'x', 'm')`;
    const r = await w.json("get_session_summary", { session_id: "s1" });
    expect(r.session).toMatchObject({ id: "s1", clientName: "Cadco", projectName: "EDA 2.0" });
    expect(r.summaries[0]).toMatchObject({ title: "Checkout move", overview: "Moved checkout to WooCommerce" });
    const none = await w.call("get_session_summary", { session_id: "nope" });
    expect(none.isError).toBe(true);
  } finally { await w.t.drop(); }
});

test("get_project_state reads the project's (or client's) running state", async () => {
  const w = await world();
  try {
    await w.t.sql`insert into project_states (scope, client_id, project_id, doc, text, version)
                  values (${`project:${w.P1.id}`}, ${w.A.id}, ${w.P1.id}, '{}'::jsonb, 'EDA 2.0 is in QA', 3)`;
    const r = await w.json("get_project_state", { client: "Cadco", project: "EDA 2.0" });
    expect(r).toMatchObject({ client: "Cadco", project: "EDA 2.0", text: "EDA 2.0 is in QA", version: 3 });
    const none = await w.json("get_project_state", { client: "Beta" });
    expect(none.state).toBeNull();
    // An empty state is "not built yet" (the summariser works through imported history over days), not "no project".
    expect(none).toMatchObject({ sessions: 1, summarisedSessions: 0 });
    expect(none.note).toContain("not built yet");
    expect(none.note).toContain("get_session_events");
  } finally { await w.t.drop(); }
});

test("recent_sessions: newest first, filtered by client, project and since", async () => {
  const w = await world();
  try {
    const all = await w.json("recent_sessions", {});
    expect(all.sessions.map((s: any) => s.id)).toEqual(["s2", "s1"]);
    expect(all.sessions[1]).toMatchObject({ client: "Cadco", project: "EDA 2.0", machine: "test-mac", cwd: "/work/eda" });
    expect((await w.json("recent_sessions", { client: "Cadco" })).sessions.map((s: any) => s.id)).toEqual(["s1"]);
    expect((await w.json("recent_sessions", { since: "2026-11-05" })).sessions.map((s: any) => s.id)).toEqual(["s2"]);
    expect((await w.json("recent_sessions", { limit: 1 })).sessions).toHaveLength(1);
  } finally { await w.t.drop(); }
});

test("get_session_events pages raw events with capped text", async () => {
  const w = await world();
  try {
    const r = await w.json("get_session_events", { session_id: "s1", limit: 1 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ seq: 1, kind: "user", text: "wordpress checkout for cadco" });
    expect(r.nextSeq).toBe(1);
    const next = await w.json("get_session_events", { session_id: "s1", after_seq: 1 });
    expect(next.events[0].text.length).toBeLessThanOrEqual(2001);
    expect(next.events[0].text.endsWith("…")).toBe(true);
    expect((await w.call("get_session_events", { session_id: "nope" })).isError).toBe(true);
  } finally { await w.t.drop(); }
});

test("a declined folder's sessions are not readable through the tools", async () => {
  const w = await world();
  try {
    await w.t.call("PUT", "/v1/bindings", { repo: "github.com/beta/portal", subpath: "", status: "declined", rebind: true });
    expect((await w.call("get_session_events", { session_id: "s2" })).isError).toBe(true);
    expect((await w.call("get_session_summary", { session_id: "s2" })).isError).toBe(true);
    const r = await w.json("recent_sessions", {});
    expect(r.sessions.map((s: any) => s.id)).toEqual(["s1"]);
  } finally { await w.t.drop(); }
});

// --- the MCP endpoint the chat run's CLI connects to ---

const rpc = (w: any, body: unknown, secret: string | null, headers: Record<string, string> = {}) =>
  w.t.app.request("/mcp/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...headers },
    body: JSON.stringify(body),
  });

test("the MCP endpoint answers initialize, tools/list and tools/call for the active run's secret", async () => {
  const w = await world();
  const run = w.runs.tryBegin()!;
  try {
    const init = await rpc(w, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, run.secret);
    expect(init.status).toBe(200);
    const i = await init.json();
    expect(i).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cerebro" } } });
    const note = await rpc(w, { jsonrpc: "2.0", method: "notifications/initialized" }, run.secret);
    expect(note.status).toBe(202);
    const list = await (await rpc(w, { jsonrpc: "2.0", id: 2, method: "tools/list" }, run.secret)).json();
    expect(list.result.tools.map((x: any) => x.name).sort()).toEqual(CHAT_TOOLS.map((x) => x.name).sort());
    const called = await (await rpc(w, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "global_search", arguments: { query: "wordpress" } } }, run.secret)).json();
    expect(called.result.isError).toBeFalsy();
    expect(JSON.parse(called.result.content[0].text).hits.length).toBeGreaterThan(0);
    const unknown = await (await rpc(w, { jsonrpc: "2.0", id: 4, method: "resources/list" }, run.secret)).json();
    expect(unknown.error.code).toBe(-32601);
  } finally { run.end(); await w.t.drop(); }
});

test("the MCP endpoint refuses a wrong secret, no secret, proxied requests and secrets of finished runs", async () => {
  const w = await world();
  const run = w.runs.tryBegin()!;
  try {
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await rpc(w, msg, null)).status).toBe(401);
    expect((await rpc(w, msg, "wrong")).status).toBe(401);
    expect((await rpc(w, msg, run.secret, { "X-Forwarded-For": "192.168.4.10" })).status).toBe(403);
    expect((await w.t.app.request("/mcp/chat", { method: "GET", headers: { Authorization: `Bearer ${run.secret}` } })).status).toBe(405);
    // A machine token is not a run secret.
    expect((await rpc(w, msg, w.t.token)).status).toBe(401);
    run.end();
    expect((await rpc(w, msg, run.secret)).status).toBe(401);
  } finally { run.end(); await w.t.drop(); }
});
