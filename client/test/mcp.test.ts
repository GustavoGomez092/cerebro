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
