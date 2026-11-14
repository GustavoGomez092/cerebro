import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSchedule, removeSchedule } from "../src/schedule";
import { Store } from "../src/store";
import { syncAllSources } from "../src/sync";
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
  const out = await syncAllSources(store, h.api, "test-mac", { home });
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
  await syncAllSources(store, h.api, "test-mac", { home });
  expect(await serverSessions(Object.values(c.ids))).toEqual([]);

  await bind(later.remote, "Later");
  await syncAllSources(store, h.api, "test-mac", { home });
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
  await syncAllSources(store, h.api, "test-mac", { home });
  const before = await eventCount(t.ids.codex!);
  expect(before).toBe(10);

  const again = await syncAllSources(store, h.api, "test-mac", { home });
  for (const s of Object.values(again.bySource)) expect(s.events).toBe(0);
  expect(await eventCount(t.ids.codex!)).toBe(before);

  appendFileSync(t.codexPath, JSON.stringify({
    timestamp: "2026-01-05T11:00:00.000Z", type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "one more answer" }] },
  }) + "\n");
  const grown = await syncAllSources(store, h.api, "test-mac", { home });
  expect(grown.bySource.codex).toMatchObject({ events: 1 });
  expect(await eventCount(t.ids.codex!)).toBe(before + 1);

  // once the file has gone quiet its cursor is closed, so flushes stop sweeping it; growth reopens it
  expect(store.getCursor(t.codexPath)?.done).toBe(false);
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(t.codexPath, old, old);
  await syncAllSources(store, h.api, "test-mac", { home });
  expect(store.getCursor(t.codexPath)?.done).toBe(true);
  appendFileSync(t.codexPath, JSON.stringify({
    timestamp: "2026-01-05T12:00:00.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "resumed" }] },
  }) + "\n");
  expect((await syncAllSources(store, h.api, "test-mac", { home })).bySource.codex).toMatchObject({ events: 1 });
  expect(await eventCount(t.ids.codex!)).toBe(before + 2);
  store.close();
});

test("a held sync lock returns no work", async () => {
  const store = newStore();
  expect(store.tryLock("sync", 60_000)).toBe(true);
  expect(await syncAllSources(store, h.api, "test-mac", { home: tmp() })).toEqual({ bySource: {} });
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
