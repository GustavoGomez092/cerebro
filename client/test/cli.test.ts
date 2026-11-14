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

  const r = await retryAfterBlock(store, h.api);
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

test("the skill file has the required frontmatter and names every MCP tool it uses", () => {
  const text = readFileSync(join(import.meta.dir, "../../plugin/skills/cerebro/SKILL.md"), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(m).not.toBeNull();
  expect(m![1]).toContain("name: cerebro");
  expect(m![1]).toContain("description: Use when Cerebro says this folder is not set up, or when the user wants to change which client/project this folder belongs to, stop recording here, or check Cerebro's status.");
  const body = m![2];
  expect(m![1]).toContain("this folder is not set up");
  for (const t of ["cerebro_folder", "cerebro_bind", "cerebro_decline", "cerebro_adopt", "rebind", "AskUserQuestion", "Codex", "Gemini"]) {
    expect(body).toContain(t);
  }
  // the CLI is run through the stable link, which exists wherever the plugin has started once
  for (const cmd of ["status", "retention", "schedule"]) expect(body).toContain(`~/.cerebro/bin/cerebro ${cmd}`);
  expect(body).not.toMatch(/(^|[^/])`cerebro (status|retention|schedule)/m);
  expect(existsSync(join(import.meta.dir, "../../plugin/skills/cerebro"))).toBe(true);
});
