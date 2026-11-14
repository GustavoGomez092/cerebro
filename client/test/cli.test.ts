import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryAfterBlock, statusText } from "../src/cli";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

let h: LiveServer;
const dirs: string[] = [];
beforeAll(async () => { h = await liveServer(); });
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cerebro-cli-"));
  dirs.push(d);
  return d;
}

/** Runs the real CLI in a child process with a throwaway HOME and CEREBRO_HOME. */
async function cli(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      PATH: process.env.PATH ?? "", HOME: home, CEREBRO_HOME: join(home, ".cerebro"), CEREBRO_NO_SPAWN: "1", ...extraEnv,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const settingsPath = (home: string) => join(home, ".claude", "settings.json");

test("retention raises cleanupPeriodDays and keeps the rest of settings.json", async () => {
  const home = tmp();
  mkdirSync(join(home, ".claude"));
  writeFileSync(settingsPath(home), JSON.stringify({ cleanupPeriodDays: 30, theme: "dark", hooks: { A: [1] } }));
  const r = await cli(["retention"], home);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("30");
  const text = readFileSync(settingsPath(home), "utf8");
  expect(JSON.parse(text)).toEqual({ cleanupPeriodDays: 36500, theme: "dark", hooks: { A: [1] } });
  expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + "\n");
  const again = await cli(["retention"], home);
  expect(again.code).toBe(0);
  expect(readFileSync(settingsPath(home), "utf8")).toBe(text);
  await cli(["retention", "--days", "90"], home);
  expect(JSON.parse(readFileSync(settingsPath(home), "utf8")).cleanupPeriodDays).toBe(90);
});

test("retention creates a missing file and leaves invalid JSON untouched", async () => {
  const home = tmp();
  expect((await cli(["retention"], home)).code).toBe(0);
  expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toEqual({ cleanupPeriodDays: 36500 });

  const bad = tmp();
  mkdirSync(join(bad, ".claude"));
  writeFileSync(settingsPath(bad), "{ not json");
  const r = await cli(["retention"], bad);
  expect(r.code).toBe(0);
  expect(r.stdout + r.stderr).toMatch(/not valid JSON/i);
  expect(readFileSync(settingsPath(bad), "utf8")).toBe("{ not json");
});

test("status shows how long Claude Code keeps transcripts", async () => {
  const configured = { CLAUDE_PLUGIN_OPTION_SERVER_URL: TEST_URL, CLAUDE_PLUGIN_OPTION_TOKEN: "t" };
  const home = tmp();
  expect((await cli(["status"], home, configured)).stdout).toContain("retention: 30 days (Claude Code's default; cleanupPeriodDays is unset)");
  mkdirSync(join(home, ".claude"));
  writeFileSync(settingsPath(home), JSON.stringify({ cleanupPeriodDays: 90 }));
  expect((await cli(["status"], home, configured)).stdout).toContain("retention: 90 days (cleanupPeriodDays)");
});

test("status says not configured and explains the plugin options", async () => {
  const r = await cli(["status"], tmp());
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("not configured");
  expect(r.stdout).toMatch(/server_url/i);
});

test("status reports a blocked uploader and --retry clears it", async () => {
  const d = tmp();
  const store = new Store(join(d, "cerebro.db"));
  store.set("instanceId", h.instanceId);
  store.set("machine", "test-mac");
  store.set("blocked", "token_revoked");
  store.set("lastError", "token was revoked");
  store.set("backoffUntil", String(Date.now() + 60_000));
  store.set("backoffMs", "30000");
  store.addPendingEnd("s1", "2026-10-20T04:00:00.000Z");
  const config = { serverUrl: TEST_URL, token: h.token };

  const before = statusText(store, config);
  expect(before).toContain(TEST_URL);
  expect(before).toContain("test-mac");
  expect(before).toContain(h.instanceId);
  expect(before).toContain("token_revoked");
  expect(before).toContain("token was revoked");
  expect(before).not.toContain(h.token);

  const r = await retryAfterBlock(store, h.clientFor(store));
  expect(r.outcome).not.toBe("blocked");
  expect(store.get("blocked")).toBeUndefined();
  expect(store.get("backoffUntil")).toBeUndefined();
  expect(store.get("backoffMs")).toBeUndefined();
  expect(statusText(store, config)).not.toContain("token_revoked");
  store.close();
});

test("reset-instance clears the pinned instanceId", async () => {
  const home = tmp();
  mkdirSync(join(home, ".cerebro"));
  const store = new Store(join(home, ".cerebro", "cerebro.db"));
  store.set("instanceId", "abc");
  store.close();
  expect((await cli(["reset-instance"], home)).code).toBe(0);
  const s2 = new Store(join(home, ".cerebro", "cerebro.db"));
  expect(s2.get("instanceId")).toBeUndefined();
  s2.close();
});

test("reset-instance also forgets what the old server said: machine name, verification, bindings, import markers", async () => {
  const home = tmp();
  mkdirSync(join(home, ".cerebro"));
  const store = new Store(join(home, ".cerebro", "cerebro.db"));
  store.set("instanceId", "abc");
  store.set("instanceVerified", JSON.stringify({ serverUrl: TEST_URL, instanceId: "abc", at: Date.now() }));
  store.set("machine", "old-mac");
  store.set("imported:github.com/acme/a|", "2026-11-01T00:00:00.000Z");
  store.set("imported:github.com/acme/b|pkg", "2026-11-01T00:00:00.000Z");
  store.set("lastSyncAt", "2026-11-01T00:00:00.000Z");
  store.set("projectState:github.com/acme/a|", JSON.stringify({ clientId: "c", projectId: null, state: { doc: {}, updatedAt: "" } }));
  store.set("recent:github.com/acme/a|", "[]");
  store.set("scopeName:b1", "Old Client");
  store.cacheBinding("github.com/acme/a", "", { id: "b1", repo: "github.com/acme/a", subpath: "", status: "active", clientId: "c", projectId: null });
  store.cacheBinding("github.com/acme/b", "pkg", null);
  store.close();
  expect((await cli(["reset-instance"], home)).code).toBe(0);
  const s2 = new Store(join(home, ".cerebro", "cerebro.db"));
  for (const k of ["instanceId", "instanceVerified", "machine", "imported:github.com/acme/a|", "imported:github.com/acme/b|pkg",
    "projectState:github.com/acme/a|", "recent:github.com/acme/a|", "scopeName:b1"]) {
    expect({ k, v: s2.get(k) }).toEqual({ k, v: undefined });
  }
  expect(s2.cachedBinding("github.com/acme/a", "")).toBeUndefined();
  expect(s2.cachedBinding("github.com/acme/b", "pkg")).toBeUndefined();
  expect(s2.get("lastSyncAt")).toBe("2026-11-01T00:00:00.000Z");
  s2.close();
});

test("the skill file has the required frontmatter and names every MCP tool it uses", () => {
  const text = readFileSync(join(import.meta.dir, "../../plugin/skills/cerebro/SKILL.md"), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(m).not.toBeNull();
  expect(m![1]).toContain("name: cerebro");
  expect(m![1]).toContain("description: Use when Cerebro says this folder is not set up, or when the user wants to change which client/project this folder belongs to, stop recording here, or check Cerebro's status.");
  const body = m![2];
  expect(m![1]).toContain("this folder is not set up");
  for (const t of ["cerebro_folder", "cerebro_bind", "cerebro_decline", "cerebro_adopt", "cerebro_save_history", "rebind", "AskUserQuestion", "Codex", "Gemini"]) {
    expect(body).toContain(t);
  }
  // the CLI is run through the stable link, which exists wherever the plugin has started once
  for (const cmd of ["status", "retention", "schedule"]) expect(body).toContain(`~/.cerebro/bin/cerebro ${cmd}`);
  expect(body).not.toMatch(/(^|[^/])`cerebro (status|retention|schedule)/m);
  // after a bind: raise a short transcript retention, but only once the user agreed
  const setUp = body.slice(body.indexOf("## Setting up"), body.indexOf("## Changing"));
  expect(setUp).toContain("run `~/.cerebro/bin/cerebro status`; if its `retention:` line shows fewer than 36500 days, ask with AskUserQuestion");
  expect(setUp).toContain("If they agree, run `~/.cerebro/bin/cerebro retention`.");
  expect(body).not.toMatch(/retention` keeps Claude Code from deleting old transcripts before they are uploaded/);
  expect(existsSync(join(import.meta.dir, "../../plugin/skills/cerebro"))).toBe(true);
});

test("the skill names cerebro_save_history after binding", () => {
  const body = readFileSync(join(import.meta.dir, "../../plugin/skills/cerebro/SKILL.md"), "utf8");
  const setUp = body.slice(body.indexOf("## Setting up"), body.indexOf("## Changing"));
  const step = setUp.slice(setUp.indexOf("Build an initial project history"));
  expect(setUp.indexOf("Build an initial project history")).toBeGreaterThan(setUp.indexOf("Call `cerebro_bind`"));
  expect(step).toContain("git log --since=\"12 months ago\" --date=short --pretty='%ad %s' | head -400");
  expect(step).toContain("1500 words");
  for (const part of ["what the project is", "how it got here", "key decisions with dates", "current state", "open questions"]) expect(step).toContain(part);
  expect(step).toContain("`cerebro_save_history`");
  for (const arg of ["`title`", "`text`", "`from`", "`to`"]) expect(step).toContain(arg);
  // git log lists newest first: the period starts at its last line
  expect(step).toContain("`from` (the oldest date covered: the last line of the `git log` output");
  expect(step).toMatch(/tell the user/i);
  // a folder without git history still gets a history, from its docs alone
  expect(step).toMatch(/not a git repo[^.]*skip `git log`/i);
  // skimming docs never opens secrets
  expect(step).toContain(".env");
  expect(step).toMatch(/never (read|open)/i);
  // it runs only once the bind succeeded
  expect(step).toMatch(/after a successful bind/i);
});
