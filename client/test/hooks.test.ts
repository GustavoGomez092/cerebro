import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Binding } from "@cerebro/shared";
import { createToken } from "../../server/src/auth";
import { createApp } from "../../server/src/http/app";
import { fakeEmbedder } from "../../server/src/embed/fake";
import { freshDb } from "../../server/test/helpers";
import { ApiClient } from "../src/api";
import { buildBrief, TOOLS_LINE } from "../src/brief";
import { handleHook, type HookInput } from "../src/hooks";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

const CLI = join(import.meta.dir, "../src/cli.ts");
const UNKNOWN_FOLDER =
  "Cerebro memory is installed but this folder is not set up. Before starting the user's task, use the cerebro skill to ask whether to use Cerebro here.";

let h: LiveServer;
let clientId: string;
let projectId: string;
let prevHome: string | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  h = await liveServer();
  clientId = (await h.api.createClient("Acme")).id;
  projectId = (await h.api.createProject(clientId, "App")).id;
  prevHome = process.env.CEREBRO_HOME;
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prevHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "cerebro-hooks-")));
  dirs.push(d);
  return d;
}

let repoN = 0;
/** A temp git repo whose origin is github.com/acme/<name>; returns its dir and folder identity. */
function gitRepo(): { dir: string; repo: string } {
  const dir = tmp();
  const name = `hooks-${process.pid}-${++repoN}-${Date.now()}`;
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", `https://github.com/acme/${name}.git`]);
  return { dir, repo: `github.com/acme/${name}` };
}

let n = 0;
function line(sid: string, cwd: string, type: "user" | "assistant", content: string): string {
  n++;
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type, timestamp: new Date(Date.UTC(2026, 9, 20, 4, 0, n % 60)).toISOString(),
    entrypoint: "cli", userType: "external", version: "2.1.304", gitBranch: "main",
    uuid: crypto.randomUUID(), sessionId: sid, cwd, message: { role: type, content },
  }) + "\n";
}

interface Env {
  store: Store;
  dir: string;
  repo: string;
  sid: string;
  transcript: string;
  calls: string[][];
  input: (extra?: Partial<HookInput>) => HookInput;
  deps: (api?: ApiClient | null) => Parameters<typeof handleHook>[2];
}

function setup(): Env {
  const home = tmp();
  process.env.CEREBRO_HOME = home;
  const store = new Store(join(home, "cerebro.db"));
  store.set("lastSyncAt", new Date().toISOString()); // a recent sync, so SessionStart does not schedule another
  const { dir, repo } = gitRepo();
  const sid = crypto.randomUUID();
  const transcript = join(tmp(), `${sid}.jsonl`);
  writeFileSync(transcript, "");
  const calls: string[][] = [];
  return {
    store, dir, repo, sid, transcript, calls,
    input: (extra = {}) => ({ session_id: sid, transcript_path: transcript, cwd: dir, hook_event_name: "SessionStart", ...extra }),
    deps: (api = h.api) => ({ store, api, machine: "test-mac", env: {}, spawn: (args: string[]) => { calls.push(args); } }),
  };
}

const bind = async (repo: string, status: "active" | "declined" = "active") =>
  (await h.api.putBinding({ repo, subpath: "", status, clientId: status === "active" ? clientId : null, projectId: status === "active" ? projectId : null })).binding;

const contextOf = (out: string): string => {
  const j = JSON.parse(out);
  expect(j.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return j.hookSpecificOutput.additionalContext;
};

/** An API whose server never answers (requests only end when their timeout aborts them). */
const hangingApi = () => new ApiClient({ serverUrl: TEST_URL, token: h.token }, ((_: unknown, init?: RequestInit) =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch);

test("unknown folder: SessionStart asks Claude to run the cerebro skill", async () => {
  const e = setup();
  const out = await handleHook("SessionStart", e.input({ source: "startup" }), e.deps());
  expect(contextOf(out)).toBe(UNKNOWN_FOLDER);
  expect(e.calls).toEqual([["flush"]]);
  expect(e.store.cachedBinding(e.repo, "")).toEqual({ binding: null, at: expect.any(String) });
  e.store.close();
});

test("not configured: SessionStart says so and needs no network", async () => {
  const e = setup();
  const ctx = contextOf(await handleHook("SessionStart", e.input(), e.deps(null)));
  expect(ctx).toContain("not configured");
  expect(e.calls).toEqual([["flush"]]);
  e.store.close();
});

test("bound folder: SessionStart returns a brief under 1500 chars and schedules import once", async () => {
  const e = setup();
  const b = await bind(e.repo);
  await h.api.ingest({
    sessions: [{ id: crypto.randomUUID(), bindingId: b.id, cwd: e.dir, repo: e.repo, subpath: "", startedAt: "2026-11-01T09:30:00.000Z" }],
    events: [],
  });

  const ctx = contextOf(await handleHook("SessionStart", e.input({ source: "startup" }), e.deps()));
  expect(ctx.length).toBeLessThanOrEqual(1500);
  expect(ctx).toContain("Acme / App");
  expect(ctx).toContain("2026-11-01");
  expect(ctx).toContain("test-mac");
  expect(ctx).toContain("cerebro_search");
  expect(e.calls).toContainEqual(["import", "--cwd", e.dir]);
  expect(e.calls).toContainEqual(["flush"]);
  expect(e.store.getCursor(e.transcript)).toMatchObject({ sessionId: e.sid, offset: 0, bindingId: b.id, repo: e.repo, done: false });
  expect(e.store.get("instanceId")).toBe(h.instanceId);

  e.store.set(`imported:${e.repo}|`, new Date().toISOString());
  e.calls.length = 0;
  await handleHook("SessionStart", e.input({ source: "resume" }), e.deps());
  expect(e.calls).toEqual([["flush"]]);
  e.store.close();
});

test("SessionStart schedules `cerebro sync` when the last sync is over an hour old", async () => {
  const e = setup();
  await handleHook("SessionStart", e.input(), e.deps());
  expect(e.calls).not.toContainEqual(["sync"]);

  e.store.set("lastSyncAt", new Date(Date.now() - 61 * 60_000).toISOString());
  e.calls.length = 0;
  await handleHook("SessionStart", e.input(), e.deps());
  expect(e.calls).toContainEqual(["sync"]);

  e.store.set("lastSyncAt", null);
  e.calls.length = 0;
  await handleHook("SessionStart", e.input(), e.deps());
  expect(e.calls).toContainEqual(["sync"]);

  // not configured or headless: no sync
  e.calls.length = 0;
  await handleHook("SessionStart", e.input(), e.deps(null));
  await handleHook("SessionStart", e.input(), { ...e.deps(), env: { CEREBRO_HEADLESS: "1" } });
  expect(e.calls).not.toContainEqual(["sync"]);
  e.store.close();
});

test("SessionStart keeps ~/.cerebro/config.json equal to the plugin settings it was started with", async () => {
  const e = setup();
  const home = process.env.CEREBRO_HOME!;
  const file = join(home, "config.json");
  const plugin = { CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://zima:8787", CLAUDE_PLUGIN_OPTION_TOKEN: "cbr_first" };
  const run = (env: Record<string, string>) => handleHook("SessionStart", e.input(), { ...e.deps(), env });
  const saved = () => JSON.parse(readFileSync(file, "utf8"));
  const mode = () => statSync(file).mode & 0o777;

  // no file yet: written, owner-only
  await run(plugin);
  expect(saved()).toEqual({ serverUrl: "http://zima:8787", token: "cbr_first" });
  expect(mode()).toBe(0o600);

  // equal: left alone
  const old = (Date.now() - 3600_000) / 1000;
  utimesSync(file, old, old);
  const before = statSync(file).mtimeMs;
  await run(plugin);
  expect(statSync(file).mtimeMs).toBe(before);

  // the token was rotated in the plugin settings: replaced
  await run({ ...plugin, CLAUDE_PLUGIN_OPTION_TOKEN: "cbr_rotated" });
  expect(saved()).toEqual({ serverUrl: "http://zima:8787", token: "cbr_rotated" });
  expect(mode()).toBe(0o600);

  // an older, world-readable file ends owner-only (same content or not)
  chmodSync(file, 0o644);
  await run({ ...plugin, CLAUDE_PLUGIN_OPTION_TOKEN: "cbr_rotated" });
  expect(mode()).toBe(0o600);
  writeFileSync(file, JSON.stringify({ serverUrl: "http://old", token: "cbr_old" }));
  chmodSync(file, 0o644);
  await run(plugin);
  expect(saved()).toEqual({ serverUrl: "http://zima:8787", token: "cbr_first" });
  expect(mode()).toBe(0o600);
  expect(readdirSync(home).filter((n) => n.startsWith("config.json") && n !== "config.json")).toEqual([]); // no temp files left

  // headless, or settings not complete in the env: untouched
  writeFileSync(file, JSON.stringify({ serverUrl: "http://keep", token: "cbr_keep" }));
  await run({ ...plugin, CLAUDE_PLUGIN_OPTION_TOKEN: "cbr_headless", CEREBRO_HEADLESS: "1" });
  await run({ CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://half" });
  expect(saved()).toEqual({ serverUrl: "http://keep", token: "cbr_keep" });
  rmSync(file);
  await run({});
  expect(existsSync(file)).toBe(false);
  e.store.close();
});

test("declined folder: SessionStart prints nothing", async () => {
  const e = setup();
  await bind(e.repo, "declined");
  expect(await handleHook("SessionStart", e.input(), e.deps())).toBe("");
  expect(e.calls).toEqual([["flush"]]);
  e.store.close();
});

const HEADLESS_ENVS: Record<string, string>[] = [
  { CEREBRO_HEADLESS: "1" },
  { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
  { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
  { CLAUDE_CODE_SESSION_ATTENDED: "0" },
];

test("headless runs (CEREBRO_HEADLESS, sdk entrypoint, unattended): SessionStart does nothing at all", async () => {
  for (const env of HEADLESS_ENVS) {
    const e = setup();
    await bind(e.repo);
    let fetched = 0;
    const counting = new ApiClient({ serverUrl: TEST_URL, token: h.token }, ((i: RequestInfo | URL, init?: RequestInit) => { fetched++; return h.fetch(i, init); }) as typeof fetch);
    expect(await handleHook("SessionStart", e.input(), { ...e.deps(counting), env })).toBe("");
    expect({ env, fetched, calls: e.calls, cursor: e.store.getCursor(e.transcript) }).toEqual({ env, fetched: 0, calls: [], cursor: undefined });
    e.store.close();
  }
});

test("headless runs capture nothing on Stop, PreCompact or SessionEnd", async () => {
  for (const env of HEADLESS_ENVS) {
    const e = setup();
    await bind(e.repo);
    await handleHook("SessionStart", e.input(), e.deps()); // registered while interactive: binding cached, cursor open
    writeFileSync(e.transcript, line(e.sid, e.dir, "user", "hello") + line(e.sid, e.dir, "assistant", "hi"));
    for (const event of ["Stop", "PreCompact", "SessionEnd"] as const) {
      expect(await handleHook(event, e.input({ hook_event_name: event, reason: "other" }), { ...e.deps(), env })).toBe("");
    }
    expect({ env, pending: e.store.pendingCount(), sessions: e.store.unsentSessions(10).length }).toEqual({ env, pending: 0, sessions: 0 });
    e.store.close();
  }
});

test("interactive Claude Code env still records", async () => {
  const e = setup();
  await bind(e.repo);
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1" };
  expect(contextOf(await handleHook("SessionStart", e.input(), { ...e.deps(), env }))).toContain("cerebro_search");
  writeFileSync(e.transcript, line(e.sid, e.dir, "user", "hello"));
  await handleHook("Stop", e.input({ hook_event_name: "Stop" }), { ...e.deps(), env });
  expect(e.store.pendingCount()).toBe(1);
  e.store.close();
});

test("SessionEnd still ends a bound session whose transcript is gone", async () => {
  const e = setup();
  const b = await bind(e.repo);
  await handleHook("SessionStart", e.input(), e.deps());
  rmSync(e.transcript);
  e.calls.length = 0;
  await handleHook("SessionEnd", e.input({ hook_event_name: "SessionEnd", reason: "logout" }), e.deps());
  expect(e.store.getCursor(e.transcript)?.bindingId).toBe(b.id);
  expect(e.calls).toHaveLength(1);
  expect(e.calls[0].slice(0, 3)).toEqual(["flush", "--end", e.sid]);
  e.store.close();
});

test("server down: SessionStart answers from the cache within 2 s and never throws", async () => {
  const e = setup();
  const b = await bind(e.repo);
  await h.api.ingest({
    sessions: [{ id: crypto.randomUUID(), bindingId: b.id, cwd: e.dir, repo: e.repo, subpath: "", startedAt: "2026-11-02T10:00:00.000Z" }],
    events: [],
  });
  await handleHook("SessionStart", e.input(), e.deps()); // online: fills the binding and brief caches

  const t0 = Date.now();
  const ctx = contextOf(await handleHook("SessionStart", e.input(), e.deps(hangingApi())));
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(ctx).toContain("Acme / App");
  expect(ctx).toContain("2026-11-02");

  const refusing = new ApiClient({ serverUrl: TEST_URL, token: h.token }, (() => { throw new TypeError("connection refused"); }) as unknown as typeof fetch);
  expect(contextOf(await handleHook("SessionStart", e.input(), e.deps(refusing)))).toContain("Acme / App");

  // Offline and never seen: say nothing rather than asking about a folder we cannot set up.
  const fresh = setup();
  expect(await handleHook("SessionStart", fresh.input(), fresh.deps(hangingApi()))).toBe("");
  e.store.close();
  fresh.store.close();
});

test("a server that is not the pinned instance never sees the token, and the brief says why", async () => {
  const e = setup();
  await bind(e.repo);
  await handleHook("SessionStart", e.input(), e.deps());
  e.store.set("instanceId", crypto.randomUUID());
  const authed: string[] = [];
  const spy = new ApiClient({ serverUrl: TEST_URL, token: h.token }, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.get("authorization")) authed.push(new URL(req.url).pathname);
    return h.fetch(req);
  }) as typeof fetch);
  const ctx = contextOf(await handleHook("SessionStart", e.input(), e.deps(spy)));
  expect(authed).toEqual([]);
  expect(ctx).toContain("Acme / App");
  expect(ctx).toContain("run `~/.cerebro/bin/cerebro reset-instance`");
  expect(e.store.get("blocked")).toBe("instance_mismatch");
  e.store.close();
});

test("problem lines name the CLI by its stable path, which works without cerebro on PATH", async () => {
  for (const reason of ["token_revoked", "unauthorized"] as const) {
    const e = setup();
    await bind(e.repo);
    e.store.set("blocked", reason);
    const ctx = contextOf(await handleHook("SessionStart", e.input(), e.deps()));
    expect(ctx, reason).toContain("run `~/.cerebro/bin/cerebro status --retry`");
    expect(ctx, reason).not.toMatch(/(^|[^/])`?cerebro (status|reset-instance|retention|schedule|sync|import)/m);
    e.store.close();
  }
  const binding: Binding = { id: "b", repo: "r", subpath: "", status: "active", clientId: "c", projectId: "p" };
  const brief = buildBrief(binding, "Acme", [], { pending: 0, quarantined: 2 }, []);
  expect(brief).toContain("(see `~/.cerebro/bin/cerebro status`)");
});

test("no message in client/src or plugin/ tells anyone to run a bare `cerebro <command>`", async () => {
  const root = join(import.meta.dir, "..", "..");
  const files = [...new Bun.Glob("client/src/**/*.ts").scanSync(root), ...new Bun.Glob("plugin/**/*.{md,json}").scanSync(root)];
  const bare = /\b(run|see|use|try)\s+\(?`?cerebro\s+(status|retention|schedule|sync|import|reset-instance|flush)\b/i;
  for (const f of files) {
    const code = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
    for (const l of code) expect(bare.test(l), `${f}: ${l.trim()}`).toBe(false);
  }
});

test("Stop captures then schedules a flush; SessionEnd does no network I/O", async () => {
  const e = setup();
  await bind(e.repo);
  await handleHook("SessionStart", e.input(), e.deps());
  writeFileSync(e.transcript, line(e.sid, e.dir, "user", "hello") + line(e.sid, e.dir, "assistant", "hi there"));
  e.calls.length = 0;

  expect(await handleHook("Stop", e.input({ hook_event_name: "Stop" }), e.deps())).toBe("");
  expect(e.store.pendingCount()).toBe(2);
  expect(e.calls).toEqual([["flush"]]);

  appendFileSync(e.transcript, line(e.sid, e.dir, "user", "compact soon"));
  expect(await handleHook("PreCompact", e.input({ hook_event_name: "PreCompact" }), e.deps())).toBe("");
  expect(e.store.pendingCount()).toBe(3);

  let fetched = 0;
  const noNetwork = new ApiClient({ serverUrl: TEST_URL, token: h.token }, (() => { fetched++; throw new Error("no network in SessionEnd"); }) as unknown as typeof fetch);
  appendFileSync(e.transcript, line(e.sid, e.dir, "assistant", "bye"));
  e.calls.length = 0;
  const t0 = Date.now();
  expect(await handleHook("SessionEnd", e.input({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }), e.deps(noNetwork))).toBe("");
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(fetched).toBe(0);
  expect(e.store.pendingCount()).toBe(4);
  expect(e.store.getCursor(e.transcript)?.done).toBe(true);
  expect(e.calls).toHaveLength(1);
  const [cmd, flag, sid, iso] = e.calls[0];
  expect([cmd, flag, sid]).toEqual(["flush", "--end", e.sid]);
  expect(Number.isNaN(Date.parse(iso))).toBe(false);
  e.store.close();
});

test("SessionEnd after /clear keeps the cursor open", async () => {
  const e = setup();
  await bind(e.repo);
  await handleHook("SessionStart", e.input(), e.deps());
  writeFileSync(e.transcript, line(e.sid, e.dir, "user", "hello"));
  await handleHook("SessionEnd", e.input({ hook_event_name: "SessionEnd", reason: "clear" }), e.deps(null));
  expect(e.store.getCursor(e.transcript)?.done).toBe(false);
  expect(e.store.pendingCount()).toBe(1);
  e.store.close();
});

test("handlers swallow store failures", async () => {
  const e = setup();
  e.store.close(); // every store call now throws
  expect(await handleHook("Stop", e.input({ hook_event_name: "Stop" }), e.deps())).toBe("");
  expect(await handleHook("SessionStart", e.input(), e.deps())).toBe("");
});

test("the brief stays under 1500 characters whatever it is given", () => {
  const binding: Binding = { id: "b", repo: "github.com/acme/app", subpath: "web", status: "active", clientId: "c", projectId: "p" };
  const recent = Array.from({ length: 50 }, (_, i) => ({
    id: String(i), clientName: "Acme", projectName: "App", machine: "m".repeat(300), cwd: "/w",
    startedAt: "2026-11-01T09:30:00.000Z", lastEventAt: null, endedAt: null, imported: false,
  }));
  const brief = buildBrief(binding, "S".repeat(2000), recent, { pending: 12, quarantined: 3 }, Array(20).fill("p".repeat(400)));
  expect(brief.length).toBeLessThanOrEqual(1500);
  expect(brief).toContain("cerebro_search");
  expect(brief).toContain("rejected by the server");

  // Problems come before the session list, so clipping a long brief can never cut them.
  const long = "w".repeat(250);
  const crowded = buildBrief({ ...binding, repo: long }, long, recent.slice(0, 5).map((s) => ({ ...s, machine: long })),
    { pending: 1, quarantined: 2 }, ["the pinned instance does not match", "q".repeat(300), "r".repeat(300)]);
  expect(crowded.endsWith(`…\n${TOOLS_LINE}`)).toBe(true); // it really was clipped
  expect(crowded.length).toBeLessThanOrEqual(1500);
  expect(crowded).toContain("the pinned instance does not match");
  expect(crowded.indexOf("rejected by the server")).toBeLessThan(crowded.indexOf("Recent sessions"));
  expect(crowded.indexOf("the pinned instance")).toBeLessThan(crowded.indexOf("Recent sessions"));

  const plain = buildBrief(binding, "Acme / App", recent.slice(0, 2), { pending: 12, quarantined: 0 }, []);
  expect(plain).toContain("12");
  expect(plain).toContain("cerebro_sessions");
  expect(plain).toContain("cerebro_read");
});

// ---- the CLI, as Claude Code runs it ----

const NO_SPAWN = { CEREBRO_NO_SPAWN: "1" };

/** The test's own env minus anything Cerebro or Claude Code reads, as an interactive session would see it. */
function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("CLAUDE_PLUGIN_OPTION_") || k.startsWith("CEREBRO_") || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  return { ...env, CEREBRO_HOME: home, CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ATTENDED: "1", ...extra };
}

test("hook CLI never exits non-zero, even on garbage stdin", () => {
  const home = tmp();
  for (const [args, stdin] of [[["hook", "Stop"], "not json"], [["hook", "SessionEnd"], ""], [["hook", "Bogus"], "{}"], [["hook"], ""]] as const) {
    const r = Bun.spawnSync(["bun", CLI, ...args], { stdin: Buffer.from(stdin), env: cliEnv(home, NO_SPAWN) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  }
  const unknown = Bun.spawnSync(["bun", CLI, "frobnicate"], { env: cliEnv(home, NO_SPAWN) });
  expect(unknown.exitCode).toBe(0);
  expect(unknown.stdout.toString()).toContain("usage");
});

test("CEREBRO_NO_SPAWN=1 turns the detached flush off", async () => {
  const stdin = Buffer.from(JSON.stringify({ session_id: crypto.randomUUID(), transcript_path: "/nonexistent.jsonl", cwd: tmpdir(), hook_event_name: "Stop" }));
  // An unreachable server: a flush that runs leaves a backoff behind in state.
  const backoffAfter = async (extra: Record<string, string>, waitMs: number) => {
    const home = tmp();
    const r = Bun.spawnSync(["bun", CLI, "hook", "Stop"], { stdin, env: cliEnv(home, { CEREBRO_SERVER_URL: "http://127.0.0.1:1", CEREBRO_TOKEN: "t", ...extra }) });
    expect(r.exitCode).toBe(0);
    const s = new Store(join(home, "cerebro.db"));
    try {
      for (const t0 = Date.now(); Date.now() - t0 < waitMs && !s.get("backoffMs");) await Bun.sleep(50);
      return s.get("backoffMs");
    } finally { s.close(); }
  };
  expect(await backoffAfter({}, 5000)).toBe("30000");
  expect(await backoffAfter({ CEREBRO_NO_SPAWN: "1" }, 1500)).toBeUndefined();
}, 15_000);

test("hook CLI prints the SessionStart JSON when not configured", () => {
  const home = tmp();
  const { dir } = gitRepo();
  const r = Bun.spawnSync(["bun", CLI, "hook", "SessionStart"], {
    stdin: Buffer.from(JSON.stringify({ session_id: crypto.randomUUID(), transcript_path: join(dir, "t.jsonl"), cwd: dir, hook_event_name: "SessionStart", source: "startup" })),
    env: cliEnv(home, NO_SPAWN),
  });
  expect(r.exitCode).toBe(0);
  expect(contextOf(r.stdout.toString())).toContain("not configured");
});

test("end to end: hooks over HTTP, and the detached flush uploads the session", async () => {
  const db = await freshDb();
  const { token } = await createToken(db.sql, "e2e-mac");
  const app = createApp({ sql: db.sql, embedder: fakeEmbedder(), log: () => {} });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const api = new ApiClient({ serverUrl: url, token });
    const c = await api.createClient("E2E");
    const { dir, repo } = gitRepo();
    await api.putBinding({ repo, subpath: "", status: "active", clientId: c.id, projectId: null });
    const home = tmp();
    const env = cliEnv(home, { CLAUDE_PLUGIN_OPTION_SERVER_URL: url, CLAUDE_PLUGIN_OPTION_TOKEN: token });
    const sid = crypto.randomUUID();
    const transcript = join(tmp(), `${sid}.jsonl`);
    writeFileSync(transcript, "");
    const run = async (event: string) => {
      const p = Bun.spawn(["bun", CLI, "hook", event], {
        stdin: Buffer.from(JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: dir, hook_event_name: event })),
        stdout: "pipe", env,
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      return out;
    };

    expect(contextOf(await run("SessionStart"))).toContain("E2E");
    // Let SessionStart's own detached flush finish, so Stop's flush is not turned away by the lock.
    const store = new Store(join(home, "cerebro.db"));
    for (let i = 0; i < 100 && !store.get("lastFlushAt"); i++) await Bun.sleep(50);
    writeFileSync(transcript, line(sid, dir, "user", "remember the blue widget") + line(sid, dir, "assistant", "noted"));
    expect(await run("Stop")).toBe("");

    let count = 0;
    for (let i = 0; i < 100 && count < 2; i++) {
      await Bun.sleep(100);
      count = Number((await db.sql`select count(*)::int as n from events where session_id = ${sid}`)[0].n);
    }
    expect(count).toBe(2);
    expect(store.get("machine")).toBe("e2e-mac");

    // `cerebro flush` learns the machine name, but only from a verified, unblocked instance.
    const flushCli = async () => {
      const p = Bun.spawn(["bun", CLI, "flush"], { stdout: "ignore", env: { ...env, CEREBRO_NO_SPAWN: "1" } });
      expect(await p.exited).toBe(0);
    };
    store.set("machine", null);
    await flushCli();
    expect(store.get("machine")).toBe("e2e-mac");

    // A flush that never reached the server (backing off) still lets a verified instance name the machine.
    store.set("machine", null);
    store.set("backoffUntil", String(Date.now() + 60_000));
    await flushCli();
    expect(store.get("machine")).toBe("e2e-mac");
    store.set("backoffUntil", null);

    store.set("machine", null);
    store.set("blocked", "token_revoked");
    await flushCli();
    expect(store.get("machine")).toBeUndefined();

    store.set("blocked", null);
    store.set("instanceId", crypto.randomUUID()); // some other server answers now
    await flushCli();
    expect(store.get("machine")).toBeUndefined();
    expect(store.get("blocked")).toBe("instance_mismatch");
    store.close();
  } finally {
    server.stop(true);
    await db.drop();
  }
}, 20_000);

test("Stop hook latency: median under 300 ms over 20 runs on a 5,000-line transcript", () => {
  const home = tmp();
  process.env.CEREBRO_HOME = home;
  const { dir, repo } = gitRepo();
  const store = new Store(join(home, "cerebro.db"));
  store.cacheBinding(repo, "", { id: "b-latency", repo, subpath: "", status: "active", clientId: null, projectId: null });
  store.close();
  const sid = crypto.randomUUID();
  const transcript = join(tmp(), `${sid}.jsonl`);
  let body = "";
  for (let i = 0; i < 5000; i++) body += line(sid, dir, i % 2 ? "assistant" : "user", `message ${i} `.repeat(10));
  writeFileSync(transcript, body);
  const stdin = Buffer.from(JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: dir, hook_event_name: "Stop" }));
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const r = Bun.spawnSync(["bun", CLI, "hook", "Stop"], { stdin, env: cliEnv(home, NO_SPAWN) });
    times.push(performance.now() - t0);
    expect(r.exitCode).toBe(0);
  }
  times.sort((a, b) => a - b);
  const median = (times[9] + times[10]) / 2;
  expect(median).toBeLessThan(300);
  const check = new Store(join(home, "cerebro.db"));
  expect(check.pendingCount()).toBe(5000);
  check.close();
}, 60_000);
