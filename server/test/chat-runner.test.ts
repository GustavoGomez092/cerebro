import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildChatPrompt, CHAT_ALLOWED_TOOLS, CHAT_DENIED_TOOLS, runChat, type ChatEvent } from "../src/chat/runner";
import { CHAT_TOOLS } from "../src/chat/tools";
import { chatWorld } from "./chat-world";

const FAKE = `bun ${join(import.meta.dir, "fakes", "fake-claude-chat.ts")}`;
const env = (mode: string, extra: Record<string, string> = {}) =>
  ({ ...process.env, SUMMARISER_CMD: FAKE, FAKE_CHAT_MODE: mode, ...extra }) as Record<string, string | undefined>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function run(mode: string, o: Partial<Parameters<typeof runChat>[0]> = {}, extra: Record<string, string> = {}) {
  const events: ChatEvent[] = [];
  const r = await runChat({
    messages: [{ role: "user", content: "what did we do for cadco?" }], model: "sonnet", mcpUrl: "http://127.0.0.1:9/mcp/chat",
    secret: "s3cret-run", timeoutMs: 20_000, env: env(mode, extra), onEvent: (e) => events.push(e), ...o,
  });
  return { r, events };
}

test("the CLI gets only the six Cerebro tools, strict MCP config, no built-ins, stream-json and the chat model", async () => {
  const { events } = await run("echo", { model: "opus" });
  const echo = JSON.parse(events.filter((e) => e.type === "text").map((e: any) => e.text).join(""));
  const a: string[] = echo.argv;
  const val = (f: string) => a[a.indexOf(f) + 1];
  expect(a).toContain("-p");
  expect(val("--model")).toBe("opus");
  expect(val("--output-format")).toBe("stream-json");
  expect(a).toContain("--verbose");
  expect(a).toContain("--include-partial-messages");
  expect(a).toContain("--strict-mcp-config");
  expect(a).toContain("--no-session-persistence");
  expect(val("--tools")).toBe(""); // no built-in tool at all
  expect(val("--allowedTools").split(",").sort()).toEqual(CHAT_TOOLS.map((t) => `mcp__cerebro__${t.name}`).sort());
  expect(CHAT_ALLOWED_TOOLS.sort()).toEqual(val("--allowedTools").split(",").sort());
  const denied = val("--disallowedTools").split(",");
  for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Glob", "Grep", "Task", "NotebookEdit"]) expect(denied).toContain(t);
  expect(denied.sort()).toEqual([...CHAT_DENIED_TOOLS].sort());
  expect(val("--system-prompt")).toMatch(/cite/i);
  // The question goes on stdin, never into argv.
  expect(a.join(" ")).not.toContain("cadco");
  expect(echo.stdin).toContain("what did we do for cadco?");
});

test("subscription only: API-key variables are removed and the run is marked headless", async () => {
  const { events } = await run("echo", {}, { ANTHROPIC_API_KEY: "sk-leak", ANTHROPIC_AUTH_TOKEN: "tok-leak", ANTHROPIC_BASE_URL: "http://leak" });
  const echo = JSON.parse(events.filter((e) => e.type === "text").map((e: any) => e.text).join(""));
  expect(echo.env).toEqual({ headless: "1" });
});

test("the MCP config is a private temp file naming this server's endpoint and the run's secret, removed afterwards", async () => {
  const { events } = await run("echo");
  const echo = JSON.parse(events.filter((e) => e.type === "text").map((e: any) => e.text).join(""));
  expect(echo.mcpConfig).toEqual({
    mcpServers: { cerebro: { type: "http", url: "http://127.0.0.1:9/mcp/chat", headers: { Authorization: "Bearer s3cret-run" } } },
  });
  expect(echo.mcpConfigMode).toBe("600");
  expect(echo.argv.join(" ")).not.toContain("s3cret-run");
  expect(existsSync(echo.mcpConfigPath)).toBe(false);
  expect(echo.cwd).not.toBe(process.cwd()); // a scratch folder: no project CLAUDE.md or settings
});

test("a run relays tool steps, streamed text once, and the usage the result reports", async () => {
  const w = await chatWorld();
  try {
    const { r, events } = await run("ok", { mcpUrl: w.mcpUrl, secret: w.secret, messages: [{ role: "user", content: "wordpress checkout" }] });
    expect(events.filter((e) => e.type === "tool")).toEqual([{ type: "tool", name: "global_search", label: 'searching "wordpress checkout"' }]);
    expect(events.filter((e) => e.type === "text").map((e: any) => e.text).join("")).toBe("Found 2 hit(s) in Cadco.");
    const done = events.find((e) => e.type === "done") as any;
    expect(done).toMatchObject({ tokens: 150, model: "claude-sonnet-fake" });
    expect(r).toMatchObject({ outcome: "ok", tokens: 150, model: "claude-sonnet-fake" });
  } finally { await w.close(); }
});

test("a usage limit is reported with its reset time", async () => {
  const { r, events } = await run("limit");
  const err = events.find((e) => e.type === "error") as any;
  expect(err).toMatchObject({ kind: "usage_limit", resetAt: new Date(1_900_000_000_000).toISOString() });
  expect(r.outcome).toBe("usage_limit");
});

test("a login problem and a CLI that dies are reported, not swallowed", async () => {
  expect((await run("auth")).events.find((e) => e.type === "error")).toMatchObject({ kind: "auth" });
  const crash = await run("crash");
  expect(crash.events.find((e) => e.type === "error")).toMatchObject({ kind: "unavailable" });
  expect(crash.r.outcome).toBe("unavailable");
  expect((await run("ok", { env: { ...process.env, SUMMARISER_CMD: "/nonexistent/claude" } })).r.outcome).toBe("unavailable");
});

test("a run past its timeout is killed and reported", async () => {
  const pidfile = join(process.env.TMPDIR ?? "/tmp", `chat-pid-${crypto.randomUUID()}`);
  const { r, events } = await run("slow", { timeoutMs: 800 }, { FAKE_CHAT_PIDFILE: pidfile });
  expect(r.outcome).toBe("timeout");
  expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "timeout" });
  const pid = Number(await Bun.file(pidfile).text());
  await Bun.sleep(100);
  expect(alive(pid)).toBe(false);
});

test("aborting a run (the browser went away) kills the CLI", async () => {
  const pidfile = join(process.env.TMPDIR ?? "/tmp", `chat-pid-${crypto.randomUUID()}`);
  const ctrl = new AbortController();
  const pending = run("slow", { signal: ctrl.signal }, { FAKE_CHAT_PIDFILE: pidfile });
  for (let i = 0; i < 100 && !existsSync(pidfile); i++) await Bun.sleep(50);
  ctrl.abort();
  const { r } = await pending;
  expect(r.outcome).toBe("cancelled");
  await Bun.sleep(100);
  expect(alive(Number(await Bun.file(pidfile).text()))).toBe(false);
});

test("the prompt carries earlier turns, oldest first, capped in count and length", () => {
  const p = buildChatPrompt([
    { role: "user", content: "first question" }, { role: "assistant", content: "first answer" }, { role: "user", content: "follow-up" },
  ]);
  expect(p.indexOf("first question")).toBeLessThan(p.indexOf("first answer"));
  expect(p.trim().endsWith("follow-up")).toBe(true);
  const many = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn-${i} ${"z".repeat(9000)}` }));
  const capped = buildChatPrompt(many);
  expect(capped).not.toContain("turn-0 ");
  expect(capped).toContain("turn-39");
  expect(capped.length).toBeLessThan(60_000);
});
