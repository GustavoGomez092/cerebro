import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChatPrompt, chatSystemPrompt, CHAT_ALLOWED_TOOLS, CHAT_DENIED_TOOLS, CHAT_ENV_ALLOWLIST, CHAT_MAX_TURNS, runChat, type ChatEvent } from "../src/chat/runner";
import { CHAT_TOOLS } from "../src/chat/tools";
import { chatWorld, fakeChatCmd } from "./chat-world";

const tmp = () => join(process.env.TMPDIR ?? "/tmp", `chat-pid-${crypto.randomUUID()}`);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function run(mode: string, o: Partial<Parameters<typeof runChat>[0]> = {}, flags: string[] = [], env: Record<string, string> = {}) {
  const events: ChatEvent[] = [];
  const r = await runChat({
    messages: [{ role: "user", content: "what did we do for cadco?" }], model: "sonnet", mcpUrl: "http://127.0.0.1:9/mcp/chat",
    secret: "s3cret-run", timeoutMs: 20_000, env: { ...process.env, SUMMARISER_CMD: fakeChatCmd(mode, flags), ...env },
    onEvent: (e) => events.push(e), ...o,
  });
  return { r, events };
}
const echoOf = (events: ChatEvent[]) => JSON.parse(events.filter((e) => e.type === "text").map((e: any) => e.text).join(""));

test("the CLI gets only the six Cerebro tools, strict MCP config, no built-ins, no settings, a turn cap, stream-json and the chat model", async () => {
  const { events } = await run("echo", { model: "opus" });
  const echo = echoOf(events);
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
  expect(val("--setting-sources")).toBe(""); // no user/project/local settings, so no hooks
  expect(val("--max-turns")).toBe(String(CHAT_MAX_TURNS));
  expect(CHAT_MAX_TURNS).toBeGreaterThanOrEqual(8);
  expect(CHAT_MAX_TURNS).toBeLessThanOrEqual(15);
  expect(val("--allowedTools").split(",").sort()).toEqual(CHAT_TOOLS.map((t) => `mcp__cerebro__${t.name}`).sort());
  expect([...CHAT_ALLOWED_TOOLS].sort()).toEqual(val("--allowedTools").split(",").sort());
  expect(val("--disallowedTools").split(",").sort()).toEqual([...CHAT_DENIED_TOOLS].sort());
  expect(val("--system-prompt")).toMatch(/cite/i);
  // The question goes on stdin, never into argv.
  expect(a.join(" ")).not.toContain("cadco");
  expect(echo.stdin).toContain("what did we do for cadco?");
});

/** `init.tools` of the pinned CLI (server/Dockerfile) with the restrictions dropped: every built-in it has. */
const CLI_2_1_311_BUILTINS = [
  "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor",
  "NotebookEdit", "PushNotification", "Read", "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskStop", "ToolSearch",
  "WebFetch", "WebSearch", "Workflow", "Write",
];

test("the deny list names every built-in of the pinned CLI and the usual others", () => {
  const pinned = /CLAUDE_CODE_VERSION=(\S+)/.exec(readFileSync(join(import.meta.dir, "../Dockerfile"), "utf8"))?.[1];
  // Bumping the CLI pin means re-listing its built-ins (see deploy/zima/README.md, "Web dashboard", the chat smoke test).
  expect(pinned).toBe("2.1.311");
  for (const t of [...CLI_2_1_311_BUILTINS, "Agent", "ToolSearch", "LSP", "TaskOutput", "Monitor", "NotebookEdit", "NotebookRead", "TodoWrite",
    "Glob", "Grep", "LS", "MultiEdit", "KillShell", "BashOutput", "SlashCommand", "ExitPlanMode", "EnterPlanMode", "AskUserQuestion",
    "ListMcpResourcesTool", "ReadMcpResourceTool", "PowerShell"]) {
    expect(CHAT_DENIED_TOOLS).toContain(t);
  }
  for (const t of CHAT_DENIED_TOOLS) expect(t.startsWith("mcp__")).toBe(false);
});

test("the CLI's environment is an allowlist: no database URL, no secrets, no API keys; headless", async () => {
  const { events } = await run("echo", {}, [], {
    DATABASE_URL: "postgres://cerebro:superpw@cerebro-db/cerebro", BETTER_AUTH_SECRET: "x", CEREBRO_WEB_TOKEN: "cbr_x", SOME_SECRET: "y",
    ANTHROPIC_API_KEY: "sk-leak", ANTHROPIC_AUTH_TOKEN: "tok-leak", ANTHROPIC_BASE_URL: "http://leak", CLAUDE_CONFIG_DIR: "/data/claude",
  });
  const env: Record<string, string> = echoOf(events).env;
  for (const k of Object.keys(env)) expect([...CHAT_ENV_ALLOWLIST, "CEREBRO_HEADLESS"]).toContain(k);
  expect(env.CEREBRO_HEADLESS).toBe("1");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude"); // the subscription login lives there
  expect(env.PATH).toBeTruthy();
  expect(JSON.stringify(env)).not.toContain("superpw");
  for (const k of ["DATABASE_URL", "BETTER_AUTH_SECRET", "CEREBRO_WEB_TOKEN", "SOME_SECRET", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"])
    expect(env[k]).toBeUndefined();
});

test("the run is refused, and the CLI killed, when its init lists any tool other than the Cerebro ones", async () => {
  const pidfile = tmp();
  const { r, events } = await run("ok", {}, ["--fake-init-tools=mcp__cerebro__global_search,Bash", `--fake-pidfile=${pidfile}`]);
  expect(r.outcome).toBe("failed");
  expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "failed", message: expect.stringMatching(/locked down/) });
  expect(events.filter((e) => e.type === "text" || e.type === "tool")).toEqual([]);
  await Bun.sleep(100);
  expect(alive(Number(readFileSync(pidfile, "utf8")))).toBe(false);
});

test("the run is refused when the Cerebro MCP server is not connected", async () => {
  const { r, events } = await run("ok", {}, ["--fake-mcp-status=failed"]);
  expect(r.outcome).toBe("failed");
  expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringMatching(/locked down/) });
});

test("output before the init message is refused, never relayed", async () => {
  const { r, events } = await run("noinit");
  expect(r.outcome).toBe("failed");
  expect(events.filter((e) => e.type === "text")).toEqual([]);
});

test("the MCP config is a private temp file naming this server's endpoint and the run's secret, removed afterwards", async () => {
  const { events } = await run("echo");
  const echo = echoOf(events);
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

test("hitting the turn cap is reported as too many steps, with its spend", async () => {
  const { r, events } = await run("maxturns");
  expect(r).toMatchObject({ outcome: "failed", tokens: 550 });
  expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "failed", message: expect.stringMatching(/too many steps/) });
});

test("a login problem and a CLI that dies are reported, not swallowed", async () => {
  expect((await run("auth")).events.find((e) => e.type === "error")).toMatchObject({ kind: "auth" });
  const crash = await run("crash");
  expect(crash.events.find((e) => e.type === "error")).toMatchObject({ kind: "unavailable" });
  expect(crash.r.outcome).toBe("unavailable");
  expect((await run("ok", {}, [], { SUMMARISER_CMD: "/nonexistent/claude" })).r.outcome).toBe("unavailable");
});

test("a run past its timeout is killed and reported", async () => {
  const pidfile = tmp();
  const { r, events } = await run("slow", { timeoutMs: 800 }, [`--fake-pidfile=${pidfile}`]);
  expect(r.outcome).toBe("timeout");
  expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "timeout" });
  await Bun.sleep(100);
  expect(alive(Number(readFileSync(pidfile, "utf8")))).toBe(false);
});

test("a timeout kills the CLI's whole process group, even behind a shell wrapper", async () => {
  const pidfile = tmp();
  const wrapper = `sh ${join(import.meta.dir, "fakes", "fake-claude-wrapper.sh")} --fake-mode=slow --fake-pidfile=${pidfile}`;
  const started = Date.now();
  const { r } = await run("slow", { timeoutMs: 800 }, [], { SUMMARISER_CMD: wrapper });
  expect(r.outcome).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(5000);
  await Bun.sleep(100);
  expect(alive(Number(readFileSync(pidfile, "utf8")))).toBe(false);
}, 15_000);

test("aborting a run (the browser went away) kills the CLI", async () => {
  const pidfile = tmp();
  const ctrl = new AbortController();
  const pending = run("slow", { signal: ctrl.signal }, [`--fake-pidfile=${pidfile}`]);
  for (let i = 0; i < 100 && !existsSync(pidfile); i++) await Bun.sleep(50);
  ctrl.abort();
  const { r } = await pending;
  expect(r.outcome).toBe("cancelled");
  await Bun.sleep(100);
  expect(alive(Number(readFileSync(pidfile, "utf8")))).toBe(false);
});

test("an abort that lands while the run is still starting cancels it at once", async () => {
  const pidfile = tmp();
  const ctrl = new AbortController();
  const started = Date.now();
  const pending = run("slow", { signal: ctrl.signal }, [`--fake-pidfile=${pidfile}`]);
  ctrl.abort(); // before the temp dir and the spawn
  const { r } = await pending;
  expect(r.outcome).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(3000);
  await Bun.sleep(300);
  if (existsSync(pidfile)) expect(alive(Number(readFileSync(pidfile, "utf8")))).toBe(false);
}, 15_000);

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

test("the system prompt says missing states and summaries mean 'not summarised yet', to be read from the sessions", () => {
  const p = chatSystemPrompt(new Date("2026-11-14T12:00:00Z"));
  expect(p).toContain("not summarised yet");
  expect(p).toContain("get_session_events");
  expect(p).toContain("Today is 2026-11-14");
});
