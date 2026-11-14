import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import { ApiClient } from "../src/api";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

let h: LiveServer;
const dirs: string[] = [];
beforeAll(async () => { h = await liveServer(); });
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cerebro-mcp-")));
  dirs.push(d);
  return d;
};
let n = 0;
const uid = () => `00000000-0000-4000-b000-${String(++n).padStart(12, "0")}`;
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
function repo(name: string) {
  const root = join(tmp(), name);
  mkdirSync(join(root, "pkg", "a"), { recursive: true });
  sh(root, "init", "-q");
  const remote = `github.com/acme/${name}-${uid().slice(-6)}`;
  sh(root, "remote", "add", "origin", `https://${remote}.git`);
  return { root, remote };
}

/** An MCP client wired in-process to a server for `cwd`; spawned commands are recorded, not run. */
async function connect(cwd: string, opts: { fetchFn?: typeof fetch; prepare?: (store: Store) => void } = {}) {
  const store = new Store(join(tmp(), "cerebro.db"));
  opts.prepare?.(store);
  const spawned: string[][] = [];
  const server = createMcpServer({ api: h.clientFor(store, opts.fetchFn), store, cwd, machine: "mac", spawn: (a) => { spawned.push(a); } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: (r.content as { text: string }[]).map((c) => c.text).join("\n") };
  };
  return { store, spawned, call, client };
}

async function bindRepo(remote: string, subpath: string, name: string) {
  const c = await h.api.createClient(`C-${name}-${uid()}`);
  const p = await h.api.createProject(c.id, name);
  return (await h.api.putBinding({ repo: remote, subpath, status: "active", clientId: c.id, projectId: p.id })).binding;
}
async function seed(remote: string, subpath: string, bindingId: string, texts: string[]) {
  const id = uid();
  const t = (i: number) => `2026-10-20T04:13:${String(10 + i).padStart(2, "0")}.000Z`;
  await h.api.ingest({
    sessions: [{ id, bindingId, cwd: "/x", repo: remote, subpath, startedAt: t(0) }],
    events: texts.map((text, i) => ({ key: `${id}-${i}`, sessionId: id, seq: i + 1, ts: t(i), kind: (i % 2 ? "assistant" : "user") as "user" | "assistant", text })),
  });
  return id;
}

test("search from a project-bound folder never sees another project", async () => {
  const a = repo("alpha");
  const b = repo("beta");
  const ba = await bindRepo(a.remote, "", "Alpha");
  const bb = await bindRepo(b.remote, "", "Beta");
  const sa = await seed(a.remote, "", ba.id, ["the zorblax migration plan for alpha"]);
  const sb = await seed(b.remote, "", bb.id, ["the zorblax migration plan for beta"]);
  const { call } = await connect(a.root);
  const r = await call("cerebro_search", { query: "zorblax" });
  expect(r.isError).toBe(false);
  expect(r.text).toContain(sa);
  expect(r.text).not.toContain(sb);
  const s = await call("cerebro_sessions", {});
  expect(s.text).toContain(sa);
  expect(s.text).not.toContain(sb);
  const e = await call("cerebro_read", { session_id: sb });
  expect(e.isError).toBe(true);
});

test("recall calls always carry the folder's repo/subpath and never scope open, even when unbound", async () => {
  const a = repo("lonely");
  const seen: string[] = [];
  const spy = ((i: any, init?: any) => {
    const url = new Request(i).url;
    if (new URL(url).pathname !== "/health") seen.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`); // each tool checks the instance first
    return h.fetch(i, init);
  }) as typeof fetch;
  const store = new Store(join(tmp(), "cerebro.db"));
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, store, spy);
  const server = createMcpServer({ api, store, cwd: join(a.root, "pkg"), machine: "mac", spawn: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(ct);
  await client.callTool({ name: "cerebro_search", arguments: { query: "anything" } });
  await client.callTool({ name: "cerebro_sessions", arguments: {} });
  await client.callTool({ name: "cerebro_read", arguments: { session_id: uid() } });
  expect(seen.length).toBe(3);
  for (const r of seen) {
    expect(decodeURIComponent(r)).toContain(a.remote);
    expect(r).toContain("pkg");
    expect(r).not.toContain("scope=open");
  }
});

test("bind creates client/project, caches the binding and schedules an import", async () => {
  const a = repo("fresh");
  const { call, store, spawned } = await connect(a.root);
  const r = await call("cerebro_bind", { client: "Acme Corp", project: "Website" });
  expect(r.isError).toBe(false);
  const cached = store.cachedBinding(a.remote, "");
  expect(cached?.binding?.status).toBe("active");
  expect(cached?.binding?.projectId).toBeTruthy();
  expect(spawned).toEqual([["import", "--cwd", a.root]]);
  const f = await call("cerebro_folder");
  expect(f.text).toContain("Acme Corp");
  expect(f.text).toContain("Website");
  // an existing client is reused, not duplicated
  const b2 = repo("fresh2");
  const c2 = await connect(b2.root);
  expect((await c2.call("cerebro_bind", { client: "Acme Corp", project: "Other" })).isError).toBe(false);
  const clients = (await h.api.listClients()).clients.filter((c) => c.name === "Acme Corp");
  expect(clients.length).toBe(1);
});

test("binding a subfolder in a repo with history suggests adopt; adopt moves them", async () => {
  const a = repo("mono");
  const top = await bindRepo(a.remote, "", "Top");
  const sid = await seed(a.remote, "pkg/a", top.id, ["glimmerwick refactor"]);
  const sub = join(a.root, "pkg", "a");
  const { call, store } = await connect(sub);
  const r = await call("cerebro_bind", { client: "Mono Client", project: "Pkg A", whole_repo: false });
  expect(r.isError).toBe(false);
  expect(r.text).toContain("cerebro_adopt");
  expect(store.cachedBinding(a.remote, "pkg/a")?.binding?.status).toBe("active");
  const ad = await call("cerebro_adopt");
  expect(ad.isError).toBe(false);
  expect(ad.text).toContain("1");
  const [row] = await h.sql`select binding_id from sessions where id = ${sid}`;
  expect(row.binding_id).toBe(store.cachedBinding(a.remote, "pkg/a")!.binding!.id);
});

test("decline caches a declined binding so capture stops", async () => {
  const a = repo("nope");
  const { call, store, spawned } = await connect(a.root);
  const r = await call("cerebro_decline");
  expect(r.isError).toBe(false);
  expect(store.cachedBinding(a.remote, "")?.binding?.status).toBe("declined");
  expect(spawned).toEqual([]);
});

test("read pages through a session with next_seq", async () => {
  const a = repo("pager");
  const b = await bindRepo(a.remote, "", "Pager");
  const sid = await seed(a.remote, "", b.id, ["one", "two", "three", "four"]);
  const { call } = await connect(a.root);
  const p1 = await call("cerebro_read", { session_id: sid, limit: 2 });
  expect(p1.text).toContain("[1] user");
  expect(p1.text).toContain("[2] assistant");
  expect(p1.text).not.toContain("[3]");
  expect(p1.text).toContain("next_seq: 2");
  const p2 = await call("cerebro_read", { session_id: sid, after_seq: 2, limit: 2 });
  expect(p2.text).toContain("[3] user");
  expect(p2.text).toContain("[4] assistant");
  expect(p2.text).not.toContain("next_seq");
});

test("server errors come back as tool errors, not crashes", async () => {
  const a = repo("rebinder");
  const { call, store } = await connect(a.root);
  expect((await call("cerebro_bind", { client: "R Client", project: "One" })).isError).toBe(false);
  const again = await call("cerebro_bind", { client: "R Client", project: "Two" });
  expect(again.isError).toBe(true);
  expect(again.text).toContain("rebind");
  expect(store.cachedBinding(a.remote, "")?.binding?.projectId).toBeTruthy();
  const ok = await call("cerebro_bind", { client: "R Client", project: "Two", rebind: true });
  expect(ok.isError).toBe(false);
  // adopt without any binding is a tool error too
  const c = repo("nobind");
  const c2 = await connect(c.root);
  expect((await c2.call("cerebro_adopt")).isError).toBe(true);
});

test("bind and decline from a subfolder are visible to capture under the folder's own subpath", async () => {
  const a = repo("subcache");
  const { call, store } = await connect(join(a.root, "pkg"));
  expect((await call("cerebro_bind", { client: "Sub Client", project: "P" })).isError).toBe(false);
  expect(store.cachedBinding(a.remote, "")?.binding?.status).toBe("active");
  expect(store.cachedBinding(a.remote, "pkg")?.binding?.status).toBe("active");
  const b = repo("subdecl");
  const d = await connect(join(b.root, "pkg"));
  expect((await d.call("cerebro_decline")).isError).toBe(false);
  expect(d.store.cachedBinding(b.remote, "pkg")?.binding?.status).toBe("declined");
});

test("a whole-repo bind from a subfolder with its own binding caches that subfolder's binding, not the repo's", async () => {
  const a = repo("ownsub");
  const sub = await bindRepo(a.remote, "pkg/a", "SubB");
  const { call, store } = await connect(join(a.root, "pkg", "a"));
  const r = await call("cerebro_bind", { client: "Root A", project: "Whole" });
  expect(r.isError).toBe(false);
  const root = store.cachedBinding(a.remote, "")?.binding;
  expect(root?.subpath).toBe("");
  expect(store.cachedBinding(a.remote, "pkg/a")?.binding?.id).toBe(sub.id);
});

test("whole_repo false at the repo root says it binds the whole repo", async () => {
  const a = repo("rootnote");
  const { call } = await connect(a.root);
  const r = await call("cerebro_bind", { client: "Root Client", project: "P", whole_repo: false });
  expect(r.text).toContain("whole repo");
});

/** Wraps the live server's fetch, noting the path of every request that carried the token. */
function authSpy() {
  const authed: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.get("authorization")) authed.push(new URL(req.url).pathname);
    return h.fetch(req);
  }) as typeof fetch;
  return { authed, fetchFn };
}

const EVERY_TOOL: [string, Record<string, unknown>][] = [
  ["cerebro_search", { query: "anything" }],
  ["cerebro_sessions", {}],
  ["cerebro_read", { session_id: "00000000-0000-4000-b000-000000000000" }],
  ["cerebro_folder", {}],
  ["cerebro_bind", { client: "Never Sent" }],
  ["cerebro_decline", {}],
  ["cerebro_adopt", {}],
  ["cerebro_state", {}],
  ["cerebro_summaries", {}],
  ["cerebro_save_history", { title: "t", text: "x", from: "2026-01-01", to: "2026-02-01" }],
];

test("every tool refuses with a clear error, sending no token, when the server is not the pinned instance", async () => {
  const a = repo("impostor");
  const { authed, fetchFn } = authSpy();
  const { call, spawned } = await connect(a.root, { fetchFn, prepare: (s) => s.set("instanceId", crypto.randomUUID()) });
  for (const [tool, args] of EVERY_TOOL) {
    const r = await call(tool, args);
    expect({ tool, isError: r.isError }).toEqual({ tool, isError: true });
    expect(r.text).toContain("not the Cerebro instance this Mac was set up with");
  }
  expect(authed).toEqual([]);
  expect(spawned).toEqual([]);
});

test("every tool refuses, sending no token, while uploads are blocked by a revoked or refused token", async () => {
  for (const reason of ["token_revoked", "unauthorized"]) {
    const a = repo(`blocked-${reason}`);
    const { authed, fetchFn } = authSpy();
    const { call } = await connect(a.root, { fetchFn, prepare: (s) => { s.set("instanceId", h.instanceId); s.set("blocked", reason); } });
    for (const [tool, args] of EVERY_TOOL) {
      const r = await call(tool, args);
      expect({ reason, tool, isError: r.isError }).toEqual({ reason, tool, isError: true });
      expect(r.text).toContain("~/.cerebro/bin/cerebro status --retry");
    }
    expect({ reason, authed }).toEqual({ reason, authed: [] });
  }
});

test("the MCP server's startup never sends the token to a server that is not the pinned instance", async () => {
  const authed: string[] = [];
  const impostor = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (req.headers.get("authorization")) authed.push(new URL(req.url).pathname);
      if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, apiVersion: 1, instanceId: "impostor" });
      return Response.json({ machine: "stolen" });
    },
  });
  try {
    const home = tmp();
    const pinned = new Store(join(home, "cerebro.db"));
    pinned.set("instanceId", "the-real-instance");
    pinned.close();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CEREBRO_|CLAUDE_PLUGIN_OPTION_|CLAUDE_CODE_)/.test(k)) env[k] = v;
    const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "mcp"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...env, CEREBRO_HOME: home, CLAUDE_PROJECT_DIR: home, CLAUDE_PLUGIN_OPTION_SERVER_URL: `http://127.0.0.1:${impostor.port}`, CLAUDE_PLUGIN_OPTION_TOKEN: "SECRET" },
    });
    // The server answers `initialize` only once its startup (machine lookup) is over.
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    p.stdin.flush();
    const first = await p.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain('"id":1');
    p.stdin.end();
    await p.exited;
    expect(authed).toEqual([]);
  } finally {
    impostor.stop(true);
  }
}, 15_000);

// ---- summaries, state and the initial history ----

const GH_SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

test("cerebro_save_history stores a history summary for this folder", async () => {
  const a = repo("histo");
  const b = await bindRepo(a.remote, "", "Histo");
  const bodies: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "POST" && new URL(req.url).pathname === "/v1/summaries") bodies.push(await req.clone().text());
    return h.fetch(req);
  }) as typeof fetch;
  const { call } = await connect(a.root, { fetchFn });
  const text = `Histo is a ledger app. It started in 2025-12.\nDeploy token was ${GH_SECRET} (rotated).`;
  const r = await call("cerebro_save_history", { title: "Histo: the first year", text, from: "2025-11-14", to: "2026-11-14" });
  expect(r.isError).toBe(false);
  expect(r.text).toContain("Saved");
  // redacted before it left this Mac
  expect(bodies.length).toBe(1);
  expect(bodies[0]).not.toContain(GH_SECRET);
  expect(bodies[0]).toContain("[REDACTED:github-token]");
  const rows = await h.sql`select kind, session_id, title, text, ts_from, ts_to from summaries where binding_id = ${b.id}`;
  expect(rows.length).toBe(1);
  expect(rows[0].kind).toBe("history");
  expect(rows[0].session_id).toBeNull();
  expect(rows[0].title).toBe("Histo: the first year");
  expect(rows[0].text).not.toContain(GH_SECRET);
  expect(rows[0].ts_from.toISOString()).toBe("2025-11-14T00:00:00.000Z");
  expect(rows[0].ts_to.toISOString()).toBe("2026-11-14T23:59:59.999Z");

  // the same period again replaces it
  expect((await call("cerebro_save_history", { title: "Histo v2", text: "updated", from: "2025-11-14", to: "2026-11-14" })).isError).toBe(false);
  const again = await h.sql`select title from summaries where binding_id = ${b.id}`;
  expect(again.map((x: any) => x.title)).toEqual(["Histo v2"]);
});

test("cerebro_save_history checks its limits before sending and explains unbound or declined folders", async () => {
  const a = repo("histlimits");
  await bindRepo(a.remote, "", "Limits");
  const { authed, fetchFn } = authSpy();
  const { call } = await connect(a.root, { fetchFn });
  const bad: [Record<string, unknown>, string][] = [
    [{ title: "t".repeat(201), text: "ok", from: "2026-01-01", to: "2026-02-01" }, "200"],
    [{ title: "ok", text: "x".repeat(20_001), from: "2026-01-01", to: "2026-02-01" }, "20000"],
    [{ title: "  ", text: "ok", from: "2026-01-01", to: "2026-02-01" }, "title"],
    [{ title: "ok", text: "ok", from: "last spring", to: "2026-02-01" }, "from"],
    [{ title: "ok", text: "ok", from: "2026-03-01", to: "2026-02-01" }, "after"],
  ];
  for (const [args, says] of bad) {
    const r = await call("cerebro_save_history", args);
    expect({ args, isError: r.isError }).toEqual({ args, isError: true });
    expect(r.text).toContain(says);
  }
  expect(authed.filter((p) => p === "/v1/summaries")).toEqual([]);

  const u = repo("histunbound");
  const un = await connect(u.root);
  const r404 = await un.call("cerebro_save_history", { title: "t", text: "x", from: "2026-01-01", to: "2026-02-01" });
  expect(r404.isError).toBe(true);
  expect(r404.text).toContain("not bound");
  expect(r404.text).toContain("cerebro_bind");

  const d = repo("histdeclined");
  await h.api.putBinding({ repo: d.remote, subpath: "", status: "declined", clientId: null, projectId: null });
  const dc = await connect(d.root);
  const r409 = await dc.call("cerebro_save_history", { title: "t", text: "x", from: "2026-01-01", to: "2026-02-01" });
  expect(r409.isError).toBe(true);
  expect(r409.text).toContain("declined");
});

test("cerebro_search lists summary hits first, marked [summary], and never prints null", async () => {
  const a = repo("sumsearch");
  const b = await bindRepo(a.remote, "", "SumSearch");
  await seed(a.remote, "", b.id, ["the quuxifier rollout went badly"]);
  await h.api.saveHistory({ repo: a.remote, subpath: "", title: "Quuxifier history", text: "the quuxifier was introduced in March", tsFrom: "2026-01-01T00:00:00.000Z", tsTo: "2026-06-30T00:00:00.000Z" });
  const { call } = await connect(a.root);
  const r = await call("cerebro_search", { query: "quuxifier" });
  expect(r.isError).toBe(false);
  const lines = r.text.split("\n");
  expect(lines[0]).toStartWith("[summary]");
  expect(lines[0]).toContain("Quuxifier history");
  expect(lines[0]).toContain("2026-01-01");
  expect(lines[0]).toContain("2026-06-30");
  expect(lines[0]).toContain("SumSearch");
  expect(lines.some((l) => !l.startsWith("[summary]") && l.includes("seq 1-1"))).toBe(true);
  expect(r.text).not.toContain("null");
});

test("cerebro_state and cerebro_summaries show this folder's state and dated summaries", async () => {
  const a = repo("stateful");
  const b = await bindRepo(a.remote, "", "Stateful");
  const none = await connect(a.root);
  const empty = await none.call("cerebro_state");
  expect(empty.isError).toBe(false);
  expect(empty.text).toContain("No project state yet");
  expect((await none.call("cerebro_summaries")).text).toContain("No summaries");

  await h.sql`
    insert into project_states (scope, client_id, project_id, doc, text, version)
    values (${`project:${b.projectId}`}, ${b.clientId}, ${b.projectId}, '{"current_status":"shipping"}'::jsonb,
            ${"## Status\nThe frobnicator ships Friday.\u0007"}, 4)`;
  await h.api.saveHistory({ repo: a.remote, subpath: "", title: "Stateful origins", text: "began as a fork of blorp", tsFrom: "2025-12-01T00:00:00.000Z", tsTo: "2026-11-01T00:00:00.000Z" });
  const { call } = await connect(a.root);
  const s = await call("cerebro_state");
  expect(s.isError).toBe(false);
  expect(s.text).toContain("The frobnicator ships Friday.");
  expect(s.text).toContain("version 4");
  expect(s.text).not.toContain("\u0007");
  const l = await call("cerebro_summaries", { from: "2025-01-01", limit: 5 });
  expect(l.isError).toBe(false);
  expect(l.text).toContain("Stateful origins");
  expect(l.text).toContain("history");
  expect(l.text).toContain("began as a fork of blorp");
  expect(l.text).toContain("2025-12-01");
  expect(l.text).not.toContain("null");
});
