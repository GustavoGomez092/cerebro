import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError } from "../src/api";
import { ensureCliLink, installSchedule, removeSchedule, setUpSchedule } from "../src/schedule";
import { codexSource } from "../src/sources/codex";
import { genericSource } from "../src/sources/generic";
import type { HistorySource } from "../src/sources/types";
import { Store } from "../src/store";
import { syncAllSources } from "../src/sync";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

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
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cerebro-sync-")));
  dirs.push(d);
  return d;
};
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); return path; };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}
/** A git repo with an origin remote unique to this test. */
function repo(name: string) {
  const root = join(tmp(), name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  const remote = `github.com/acme/${name}-${crypto.randomUUID().slice(0, 8)}`;
  git(root, "remote", "add", "origin", `https://${remote}.git`);
  return { root, remote };
}
async function bind(remote: string, name: string) {
  const c = await h.api.createClient(`C-${name}-${crypto.randomUUID()}`);
  const p = await h.api.createProject(c.id, name);
  return (await h.api.putBinding({ repo: remote, subpath: "", status: "active", clientId: c.id, projectId: p.id })).binding;
}
function newStore(): Store {
  const d = tmp();
  process.env.CEREBRO_HOME = d;
  return new Store(join(d, "cerebro.db"));
}

/** History from four agents for the folder `root` (remote `remote`), written under `home`; returns their session ids. */
function agentHistory(home: string, root: string, remote: string) {
  const parent = crypto.randomUUID();
  const sub = `a${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  write(join(home, ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), parent, "subagents", `agent-${sub}.jsonl`),
    fixture("subagent.jsonl").replaceAll("/Users/dev/projects/demo", root));

  const codexId = crypto.randomUUID();
  const codexPath = write(join(home, ".codex", "sessions", "2026", "01", "05", `rollout-2026-01-05T10-00-07-${codexId}.jsonl`),
    fixture("codex-rollout.jsonl")
      .replace("00000000-0000-4000-8000-000000000001", codexId)
      .replaceAll("/Users/dev/projects/demo", root)
      .replace("https://github.com/example/demo.git", `https://${remote}.git`));

  const geminiId = crypto.randomUUID();
  write(join(home, ".gemini", "tmp", sha(root), "logs.json"),
    JSON.stringify(JSON.parse(fixture("gemini-logs.json")).map((r: { sessionId: string }) => ({ ...r, sessionId: geminiId }))));

  const runId = `run-${crypto.randomUUID()}`;
  write(join(home, ".cerebro", "inbox", `${runId}.jsonl`),
    fixture("generic.jsonl").replace("run-0001", runId).replace("/Users/dev/projects/demo", root).replace("https://github.com/example/demo.git", `https://${remote}.git`));

  return {
    codexPath,
    ids: {
      "claude-code-subagent": `${parent}/agent-${sub}`,
      codex: `codex:${codexId}`,
      "gemini-cli": `gemini:${geminiId}`,
      "my-agent": `my-agent:${runId}`,
    } as Record<string, string>,
  };
}

const serverSessions = async (ids: string[]) =>
  (await h.sql`select id, meta->>'agent' as agent, imported from sessions where id = any(${h.sql.array(ids, "text")})`) as { id: string; agent: string; imported: boolean }[];
const eventCount = async (id: string) => Number((await h.sql`select count(*)::int as n from events where session_id = ${id}`)[0].n);

test("sync records every agent's sessions for a bound folder and nothing for an unbound one", async () => {
  const home = tmp();
  const bound = repo("bound");
  const unbound = repo("unbound");
  await bind(bound.remote, "Bound");
  const a = agentHistory(home, bound.root, bound.remote);
  const b = agentHistory(home, unbound.root, unbound.remote);

  const store = newStore();
  const out = await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  for (const id of ["claude-code-subagent", "codex", "gemini-cli", "generic"]) expect(out.bySource[id]?.files, id).toBe(1);

  const rows = await serverSessions(Object.values(a.ids));
  expect(Object.fromEntries(rows.map((r) => [r.agent, r.id]))).toEqual(a.ids);
  expect(rows.every((r) => r.imported)).toBe(true);
  expect(await serverSessions(Object.values(b.ids))).toEqual([]);
  expect(store.pendingCount()).toBe(0);
  expect(store.get("lastSyncAt")).toBeTruthy();
  store.close();
});

test("binding a folder later picks up history that sync skipped earlier", async () => {
  const home = tmp();
  const later = repo("later");
  const c = agentHistory(home, later.root, later.remote);
  const store = newStore();
  await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  expect(await serverSessions(Object.values(c.ids))).toEqual([]);

  await bind(later.remote, "Later");
  await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  const rows = await serverSessions(Object.values(c.ids));
  expect(rows.map((r) => r.agent).sort()).toEqual(["claude-code-subagent", "codex", "gemini-cli", "my-agent"]);
  store.close();
});

test("sync twice uploads nothing new; a growing codex file uploads only the new lines", async () => {
  const home = tmp();
  const r = repo("twice");
  await bind(r.remote, "Twice");
  const t = agentHistory(home, r.root, r.remote);
  const store = newStore();
  await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  const before = await eventCount(t.ids.codex!);
  expect(before).toBe(10);

  const again = await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  for (const s of Object.values(again.bySource)) expect(s.events).toBe(0);
  expect(await eventCount(t.ids.codex!)).toBe(before);

  appendFileSync(t.codexPath, JSON.stringify({
    timestamp: "2026-01-05T11:00:00.000Z", type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "one more answer" }] },
  }) + "\n");
  const grown = await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  expect(grown.bySource.codex).toMatchObject({ events: 1 });
  expect(await eventCount(t.ids.codex!)).toBe(before + 1);

  // once the file has gone quiet its cursor is closed, so flushes stop sweeping it; growth reopens it
  expect(store.getCursor(t.codexPath)?.done).toBe(false);
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(t.codexPath, old, old);
  await syncAllSources(store, h.clientFor(store), "test-mac", { home });
  expect(store.getCursor(t.codexPath)?.done).toBe(true);
  appendFileSync(t.codexPath, JSON.stringify({
    timestamp: "2026-01-05T12:00:00.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "resumed" }] },
  }) + "\n");
  expect((await syncAllSources(store, h.clientFor(store), "test-mac", { home })).bySource.codex).toMatchObject({ events: 1 });
  expect(await eventCount(t.ids.codex!)).toBe(before + 2);
  store.close();
});

test("a held sync lock returns no work", async () => {
  const store = newStore();
  expect(store.tryLock("sync", 60_000)).toBe(true);
  expect(await syncAllSources(store, h.clientFor(store), "test-mac", { home: tmp() })).toEqual({ bySource: {} });
  store.close();
});

test("a new inbox file under a finished file's name is judged by its own folder, not the old one's binding", async () => {
  const home = tmp();
  const bound = repo("redrop-bound");
  const unbound = repo("redrop-unbound");
  await bind(bound.remote, "RedropBound");
  const drop = (root: string, remote: string, id: string) => write(join(home, ".cerebro", "inbox", "export.jsonl"),
    fixture("generic.jsonl").replace("run-0001", id).replace("/Users/dev/projects/demo", root).replace("https://github.com/example/demo.git", `https://${remote}.git`));
  const store = newStore();
  const first = drop(bound.root, bound.remote, `first-${crypto.randomUUID()}`);
  await syncAllSources(store, h.clientFor(store), "test-mac", { home, sources: [genericSource] });
  expect(existsSync(first)).toBe(false); // recorded and moved to done/

  const secondId = `second-${crypto.randomUUID()}`;
  drop(unbound.root, unbound.remote, secondId);
  const out = await syncAllSources(store, h.clientFor(store), "test-mac", { home, sources: [genericSource] });
  expect(out.bySource.generic).toMatchObject({ files: 0, events: 0, skipped: 1 });
  expect(await serverSessions([`my-agent:${secondId}`])).toEqual([]);
  expect(existsSync(first)).toBe(true); // left in the inbox for when its folder opts in
  expect(store.getCursor(first)?.bindingId ?? null).toBeNull();
  store.close();
});

test("the 50-resolve cap never starves a folder: the oldest-checked identities go first", async () => {
  const home = tmp();
  const tag = crypto.randomUUID().slice(0, 8);
  const remotes = Array.from({ length: 60 }, (_, i) => `github.com/acme/starve-${tag}-${i}`);
  remotes.forEach((remote, i) => write(join(home, ".cerebro", "inbox", `s${i}.jsonl`),
    fixture("generic.jsonl").replace("run-0001", `s${i}`).replace("/Users/dev/projects/demo", `/nonexistent/starve/${i}`)
      .replace("https://github.com/example/demo.git", `https://${remote}.git`)));
  const asked: string[] = [];
  const store = newStore();
  const counting = new Proxy(h.clientFor(store), {
    get(target, prop, recv) {
      if (prop !== "resolve") return Reflect.get(target, prop, recv);
      return (...args: Parameters<typeof target.resolve>) => { asked.push(args[0]); return target.resolve(...args); };
    },
  });
  await syncAllSources(store, counting, "test-mac", { home, sources: [genericSource] });
  expect(new Set(asked).size).toBe(50);
  const missed = remotes.filter((r) => !asked.includes(r));
  expect(missed).toHaveLength(10);

  asked.length = 0;
  await syncAllSources(store, counting, "test-mac", { home, sources: [genericSource] });
  expect(asked).toHaveLength(50);
  for (const r of missed) expect(asked).toContain(r);
  store.close();
});

test("a folder the server refuses to resolve (4xx) is put to the back of the queue, not retried first forever", async () => {
  const home = tmp();
  const tag = crypto.randomUUID().slice(0, 8);
  const refused = `github.com/acme/refused-${tag}`;
  write(join(home, ".cerebro", "inbox", "refused.jsonl"), fixture("generic.jsonl").replace("/Users/dev/projects/demo", "/nonexistent/refused")
    .replace("https://github.com/example/demo.git", `https://${refused}.git`));
  const store = newStore();
  const failing = new Proxy(h.clientFor(store), {
    get(target, prop, recv) {
      if (prop !== "resolve") return Reflect.get(target, prop, recv);
      return (...args: Parameters<typeof target.resolve>) =>
        args[0] === refused ? Promise.reject(new ApiError(400, "invalid_request", "bad identity")) : target.resolve(...args);
    },
  });
  await syncAllSources(store, failing, "test-mac", { home, sources: [genericSource] });
  const cached = store.cachedBinding(refused, "");
  expect(cached?.binding ?? null).toBeNull();
  expect(cached?.at).toBeString(); // known now, so never-asked folders sort ahead of it next run
  store.close();
});

test("sync checks the pinned instance first and never sends the token to another one", async () => {
  const home = tmp();
  const r = repo("impostor");
  await bind(r.remote, "Impostor");
  agentHistory(home, r.root, r.remote);
  const store = newStore();
  store.set("instanceId", crypto.randomUUID());
  const authed: string[] = [];
  const spy = new ApiClient({ serverUrl: TEST_URL, token: h.token }, store, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.get("authorization")) authed.push(new URL(req.url).pathname);
    return h.fetch(req);
  }) as typeof fetch);
  await syncAllSources(store, spy, "test-mac", { home });
  expect(authed).toEqual([]);
  expect(store.get("blocked")).toBe("instance_mismatch");
  store.close();
});

test("sync sends no token while uploads are blocked by a revoked or refused token", async () => {
  for (const reason of ["token_revoked", "unauthorized"]) {
    const home = tmp();
    const r = repo(`blocked-${reason}`);
    await bind(r.remote, `Blocked-${reason}`);
    agentHistory(home, r.root, r.remote);
    const store = newStore();
    store.set("instanceId", h.instanceId);
    store.set("blocked", reason);
    const authed: string[] = [];
    const spy = h.clientFor(store, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.headers.get("authorization")) authed.push(new URL(req.url).pathname);
      return h.fetch(req);
    }) as typeof fetch);
    await syncAllSources(store, spy, "test-mac", { home });
    expect({ reason, authed }).toEqual({ reason, authed: [] });
    store.close();
  }
});

test("a finished file remembers its size and time, so later syncs tell discover to skip it", async () => {
  const home = tmp();
  const r = repo("unchanged");
  await bind(r.remote, "Unchanged");
  const t = agentHistory(home, r.root, r.remote);
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(t.codexPath, old, old);
  const store = newStore();
  await syncAllSources(store, h.clientFor(store), "test-mac", { home, sources: [codexSource] });
  expect(store.getCursor(t.codexPath)?.done).toBe(true);

  const verdicts: boolean[] = [];
  const spy: HistorySource = {
    ...codexSource,
    discover: (roots) => {
      const st = statSync(t.codexPath);
      verdicts.push(roots?.unchanged?.(t.codexPath, st.size, st.mtimeMs) ?? false);
      return codexSource.discover(roots);
    },
  };
  await syncAllSources(store, h.clientFor(store), "test-mac", { home, sources: [spy] });
  appendFileSync(t.codexPath, "\n");
  await syncAllSources(store, h.clientFor(store), "test-mac", { home, sources: [spy] });
  expect(verdicts).toEqual([true, false]);
  store.close();
});

test("schedule writes a launchd plist running `cerebro sync` every 1800 s and --off removes it", () => {
  const home = tmp();
  process.env.CEREBRO_HOME = join(home, ".cerebro");
  const calls: string[][] = [];
  const launchctl = (args: string[]) => { calls.push(args); return 0; };

  const path = installSchedule({ home, program: ["/opt/cerebro/bin/cerebro"], launchctl, uid: 501 });
  expect(path).toBe(join(home, "Library", "LaunchAgents", "dev.cerebro.sync.plist"));
  const xml = readFileSync(path, "utf8");
  expect(xml).toContain("<string>dev.cerebro.sync</string>");
  expect(xml).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/cerebro\/bin\/cerebro<\/string>\s*<string>sync<\/string>\s*<\/array>/);
  expect(xml).toMatch(/<key>StartInterval<\/key>\s*<integer>1800<\/integer>/);
  expect(xml).toContain(`<string>${join(home, ".cerebro", "logs", "sync.log")}</string>`);
  expect(existsSync(join(home, ".cerebro", "logs"))).toBe(true);
  expect(calls).toContainEqual(["bootstrap", "gui/501", path]);

  calls.length = 0;
  expect(removeSchedule({ home, launchctl, uid: 501 })).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(calls).toEqual([["bootout", "gui/501", path]]);
  expect(removeSchedule({ home, launchctl, uid: 501 })).toBe(false);
});

test("the schedule runs the stable ~/.cerebro/bin/cerebro link, which follows the current binary", () => {
  const home = tmp();
  process.env.CEREBRO_HOME = join(home, ".cerebro");
  const link = join(home, ".cerebro", "bin", "cerebro");
  expect(ensureCliLink({ compiled: false })).toBeNull(); // under `bun cli.ts` there is no binary to point at
  expect(existsSync(link)).toBe(false);
  expect(ensureCliLink({ compiled: true, target: "/plugins/cerebro/1.0.0/bin/cerebro-darwin-arm64" })).toBe(link);
  expect(readlinkSync(link)).toBe("/plugins/cerebro/1.0.0/bin/cerebro-darwin-arm64");
  expect(ensureCliLink({ compiled: true, target: "/plugins/cerebro/1.1.0/bin/cerebro-darwin-arm64" })).toBe(link);
  expect(readlinkSync(link)).toBe("/plugins/cerebro/1.1.0/bin/cerebro-darwin-arm64");

  const path = installSchedule({ home, launchctl: () => 0, uid: 501 });
  expect(readFileSync(path, "utf8")).toMatch(new RegExp(`<array>\\s*<string>${link}</string>\\s*<string>sync</string>\\s*</array>`));
});

test("scheduling saves the server settings to config.json so launchd's sync can upload", () => {
  const home = tmp();
  process.env.CEREBRO_HOME = join(home, ".cerebro");
  const config = join(home, ".cerebro", "config.json");
  const unconfigured = setUpSchedule({ config: null, home, program: ["/x/cerebro"], launchctl: () => 0, uid: 501 });
  expect(unconfigured.configured).toBe(false);
  expect(existsSync(unconfigured.path)).toBe(true);
  expect(existsSync(config)).toBe(false);

  const r = setUpSchedule({ config: { serverUrl: "http://zima:8787", token: "cbr_test" }, home, program: ["/x/cerebro"], launchctl: () => 0, uid: 501 });
  expect(r.configured).toBe(true);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ serverUrl: "http://zima:8787", token: "cbr_test" });
  expect(statSync(config).mode & 0o777).toBe(0o600);
});

test("cerebro import-file copies a valid file into the inbox and syncs; an invalid one is refused", () => {
  const home = tmp();
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, CEREBRO_HOME: join(home, ".cerebro") };
  const cli = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const src = write(join(tmp(), "hermes.jsonl"), fixture("generic.jsonl"));
  const ok = cli("import-file", src, "--agent", "hermes");
  expect(ok.code).toBe(0);
  expect(ok.out).toContain('"sessionId":"hermes:run-0001"');
  expect(ok.out).toContain('"bySource"');
  expect(existsSync(join(home, ".cerebro", "inbox", "hermes.jsonl"))).toBe(true); // unbound: stays for a later sync

  const bad = cli("import-file", write(join(tmp(), "bad.jsonl"), "{}\n"));
  expect(bad.code).toBe(0);
  expect(bad.err).toContain("not a cerebro-jsonl v1 file");
  expect(cli("import-file").err).toContain("usage");
});
