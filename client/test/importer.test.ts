import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFolder } from "../src/importer";
import { Store } from "../src/store";
import { liveServer, type LiveServer } from "./harness";

let h: LiveServer;
let prevHome: string | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  h = await liveServer();
  prevHome = process.env.CEREBRO_HOME;
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prevHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cerebro-import-")));
  dirs.push(d);
  return d;
};
let n = 0;
const uid = () => `00000000-0000-4000-a000-${String(++n).padStart(12, "0")}`;

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
/** A git repo with an origin remote unique to this test. */
function repo(name: string) {
  const root = join(tmp(), name);
  mkdirSync(join(root, "packages", "a"), { recursive: true });
  git(root, "init", "-q");
  const remote = `github.com/acme/${name}-${uid().slice(-6)}`;
  git(root, "remote", "add", "origin", `https://${remote}.git`);
  return { root, remote };
}

function entry(sid: string, cwd: string, entrypoint: string, i: number) {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type: i % 2 ? "assistant" : "user", timestamp: `2026-10-20T04:13:${String(10 + i).padStart(2, "0")}.000Z`,
    entrypoint, userType: "external", version: "2.1.304", gitBranch: "main", uuid: uid(), sessionId: sid, cwd,
    message: { role: i % 2 ? "assistant" : "user", content: `message ${i}` },
  }) + "\n";
}
/** Writes a transcript under <home>/.claude/projects/<dir>/<sid>.jsonl, optionally aged. */
function transcript(home: string, cwd: string, opts: { entrypoint?: string; ageMs?: number; lines?: number } = {}) {
  const sid = uid();
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, Array.from({ length: opts.lines ?? 2 }, (_, i) => entry(sid, cwd, opts.entrypoint ?? "cli", i)).join(""));
  const t = (Date.now() - (opts.ageMs ?? 60 * 60_000)) / 1000;
  utimesSync(path, t, t);
  return { sid, path };
}
/** Imports `root` with a fresh store and a client gated by it. */
function importFolderFresh(root: string, machine: string, opts: { home: string }) {
  const store = newStore();
  return importFolder(store, h.clientFor(store), root, machine, opts);
}
function newStore(): Store {
  const d = tmp();
  process.env.CEREBRO_HOME = d;
  return new Store(join(d, "cerebro.db"));
}
async function bind(remote: string, subpath: string, name: string) {
  const c = await h.api.createClient(`C-${name}-${uid()}`);
  const p = await h.api.createProject(c.id, name);
  return (await h.api.putBinding({ repo: remote, subpath, status: "active", clientId: c.id, projectId: p.id })).binding;
}
const serverSession = async (sid: string) => (await h.sql`select * from sessions where id = ${sid}`)[0];

test("imports only this folder's past sessions, marked imported", async () => {
  const home = tmp();
  const { root, remote } = repo("one");
  const other = repo("other");
  const b = await bind(remote, "", "One");
  await bind(other.remote, "", "Other");
  const a = transcript(home, root);
  const sdk = transcript(home, root, { entrypoint: "sdk-cli" });
  const elsewhere = transcript(home, other.root);

  const store = newStore();
  const r = await importFolder(store, h.clientFor(store), root, "mac", { home });
  expect(r).toMatchObject({ sessions: 1, events: 2, skipped: 1, bySource: { "claude-code": 1 } });
  const s = await serverSession(a.sid);
  expect(s.imported).toBe(true);
  expect(s.binding_id).toBe(b.id);
  expect(await serverSession(sdk.sid)).toBeUndefined();
  expect(await serverSession(elsewhere.sid)).toBeUndefined();
  expect(store.pendingCount()).toBe(0);
  expect(store.get(`imported:${remote}|`)).toBeTruthy();
});

test("monorepo subfolder sessions go to their own binding", async () => {
  const home = tmp();
  const { root, remote } = repo("mono");
  const top = await bind(remote, "", "Top");
  const sub = await bind(remote, "packages/a", "Sub");
  const t = transcript(home, root);
  const s = transcript(home, join(root, "packages", "a"));

  const store = newStore();
  const r = await importFolder(store, h.clientFor(store), root, "mac", { home });
  expect(r.sessions).toBe(2);
  expect((await serverSession(t.sid)).binding_id).toBe(top.id);
  expect((await serverSession(s.sid)).binding_id).toBe(sub.id);
});

test("running the import twice uploads nothing new", async () => {
  const home = tmp();
  const { root, remote } = repo("twice");
  await bind(remote, "", "Twice");
  transcript(home, root);
  const store = newStore();
  expect((await importFolder(store, h.clientFor(store), root, "mac", { home })).sessions).toBe(1);
  const again = await importFolder(store, h.clientFor(store), root, "mac", { home });
  expect(again).toMatchObject({ sessions: 0, events: 0 });
  expect(store.pendingCount()).toBe(0);
});

test("a live transcript keeps its cursor open for further capture", async () => {
  const home = tmp();
  const { root, remote } = repo("live");
  await bind(remote, "", "Live");
  const t = transcript(home, root, { ageMs: 30_000 });
  const store = newStore();
  expect((await importFolder(store, h.clientFor(store), root, "mac", { home })).sessions).toBe(1);
  expect(store.getCursor(t.path)?.done).toBe(false);
  appendFileSync(t.path, entry(t.sid, root, "cli", 5));
  const again = await importFolder(store, h.clientFor(store), root, "mac", { home });
  expect(again.events).toBe(1);
});

test("an unbound folder imports nothing", async () => {
  const home = tmp();
  const { root } = repo("unbound");
  transcript(home, root);
  const r = await importFolderFresh(root, "mac", { home });
  expect(r).toMatchObject({ sessions: 0, events: 0, skipped: 1 });
});

test("a failed resolve leaves the imported marker unset and the next run finishes the job", async () => {
  const home = tmp();
  const { root, remote } = repo("flaky");
  await bind(remote, "", "FlakyTop");
  await bind(remote, "packages/a", "FlakySub");
  transcript(home, root);
  transcript(home, join(root, "packages", "a"));

  const store = newStore();
  let failed = false;
  const flaky = new Proxy(h.clientFor(store), {
    get(target, prop, recv) {
      if (prop !== "resolve") return Reflect.get(target, prop, recv);
      return (...args: Parameters<typeof target.resolve>) => {
        if (!failed) { failed = true; return Promise.reject(new Error("network down")); }
        return target.resolve(...args);
      };
    },
  });
  const first = await importFolder(store, flaky, root, "mac", { home });
  expect(first.sessions).toBe(1);
  expect(store.get(`imported:${remote}|`)).toBeUndefined();

  const second = await importFolder(store, h.clientFor(store), root, "mac", { home });
  expect(second.sessions).toBe(1);
  expect(store.get(`imported:${remote}|`)).toBeTruthy();
});

test("a child directory named like '..foo' is still inside the folder", async () => {
  const home = tmp();
  const { root, remote } = repo("dots");
  mkdirSync(join(root, "..foo"));
  await bind(remote, "", "DotsTop");
  const t = transcript(home, join(root, "..foo"));
  const r = await importFolderFresh(root, "mac", { home });
  expect(r.sessions).toBe(1);
  expect((await serverSession(t.sid)).imported).toBe(true);
});

test("a held import lock returns zeros", async () => {
  const home = tmp();
  const { root, remote } = repo("locked");
  await bind(remote, "", "Locked");
  transcript(home, root);
  const store = newStore();
  expect(store.tryLock(`import:${remote}|`, 60_000)).toBe(true);
  expect(await importFolder(store, h.clientFor(store), root, "mac", { home })).toEqual({ sessions: 0, events: 0, skipped: 0, bySource: {} });
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

test("import never sends the token to a server that is not the pinned instance", async () => {
  const home = tmp();
  const { root, remote } = repo("impostor");
  await bind(remote, "", "Impostor");
  transcript(home, root);
  const store = newStore();
  store.set("instanceId", crypto.randomUUID()); // pinned to another instance than the one answering
  const { authed, fetchFn } = authSpy();
  const r = await importFolder(store, h.clientFor(store, fetchFn), root, "mac", { home });
  expect(authed).toEqual([]);
  expect(r.sessions).toBe(0);
  expect(store.get(`imported:${remote}|`)).toBeUndefined();
});

test("import sends nothing while uploads are blocked (revoked or refused token)", async () => {
  for (const reason of ["token_revoked", "unauthorized"]) {
    const home = tmp();
    const { root, remote } = repo(`blocked-${reason}`);
    await bind(remote, "", `Blocked-${reason}`);
    transcript(home, root);
    const store = newStore();
    store.set("instanceId", h.instanceId);
    store.set("blocked", reason);
    const { authed, fetchFn } = authSpy();
    await importFolder(store, h.clientFor(store, fetchFn), root, "mac", { home });
    expect({ reason, authed }).toEqual({ reason, authed: [] });
  }
});
