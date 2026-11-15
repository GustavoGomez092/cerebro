import { test, expect } from "bun:test";
import { runClaude } from "../src/summarise/claude";
import { estimateTokens } from "../src/summarise/budget";

const FAKE = "bun server/test/fakes/fake-claude.ts";
const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
const base = (mode: string, extra: Record<string, string> = {}) =>
  ({ ...process.env, SUMMARISER_CMD: FAKE, FAKE_CLAUDE_MODE: mode, ...extra }) as NodeJS.ProcessEnv;
const input = { systemPrompt: "SYS", prompt: "hello cerebro world", schema };

test("ok: parses result text, sums tokens, reads model and credential expiry", async () => {
  const r = await runClaude(input, base("ok"));
  expect(r).toEqual({
    ok: true,
    output: { summary: "fake summary: hello cerebro world" },
    tokens: 10 + 5 + 7,
    model: "claude-haiku-fake",
    credentialExpiresAt: "2030-01-01T00:00:00.000Z",
  });
});

test("ok: structured_output field is preferred when present", async () => {
  const r = await runClaude(input, base("structured"));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.output).toEqual({ summary: "fake summary: hello cerebro world" });
});

test("tokens counts cache creation", async () => {
  const r = await runClaude(input, base("ok", { FAKE_CLAUDE_CACHE_CREATION: "1000" }));
  expect(r.ok && r.tokens).toBe(10 + 5 + 1000);
});

test("the prompt is passed on stdin, never as an argument", async () => {
  const r = await runClaude({ ...input, prompt: "SECRET-PROMPT-TEXT" }, base("echo"));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const echo = r.output as { argv: string[]; stdin: string; headless: string | undefined };
  expect(echo.stdin).toBe("SECRET-PROMPT-TEXT");
  expect(echo.argv.join(" ")).not.toContain("SECRET-PROMPT-TEXT");
  expect(echo.headless).toBe("1");
  const a = echo.argv;
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence"]) expect(a).toContain(flag);
  expect(a[a.indexOf("--model") + 1]).toBe("haiku");
  expect(a[a.indexOf("--output-format") + 1]).toBe("json");
  expect(a[a.indexOf("--tools") + 1]).toBe("");
  expect(a[a.indexOf("--system-prompt") + 1]).toBe("SYS");
  expect(JSON.parse(a[a.indexOf("--json-schema") + 1])).toEqual(schema);
});

test("limit: usage_limit with resetAt from the epoch suffix", async () => {
  const r = await runClaude(input, base("limit", { FAKE_CLAUDE_RESET_EPOCH: "1900000000" }));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.kind).toBe("usage_limit");
  expect(r.resetAt).toEqual(new Date(1900000000 * 1000));
});

test("auth: classified as auth", async () => {
  const r = await runClaude(input, base("auth"));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.kind).toBe("auth");
    expect(r.resetAt).toBeNull();
  }
});

test("garbage: bad_output", async () => {
  const r = await runClaude(input, base("garbage"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("bad_output");
});

test("result text that is not JSON is bad_output", async () => {
  const r = await runClaude(input, base("notjson"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("bad_output");
});

test("slow: times out and kills the child", async () => {
  const t0 = Date.now();
  const r = await runClaude({ ...input, timeoutMs: 300 }, base("slow"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("timeout");
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("API-key env vars are stripped from the child; CLAUDE_CONFIG_DIR passes through", async () => {
  const r = await runClaude(
    input,
    base("echo", {
      ANTHROPIC_API_KEY: "sk-leak",
      ANTHROPIC_AUTH_TOKEN: "tok-leak",
      ANTHROPIC_BASE_URL: "http://leak",
      CLAUDE_CONFIG_DIR: "/tmp/cfg",
    }),
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const echo = r.output as Record<string, unknown>;
  expect(echo.apiKey).toBeUndefined();
  expect(echo.authToken).toBeUndefined();
  expect(echo.baseUrl).toBeUndefined();
  expect(echo.configDir).toBe("/tmp/cfg");
});

test("api_error_status 401 is auth even when the text is unrelated", async () => {
  const r = await runClaude(input, base("status401"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("auth");
});

test("newer limit wording is usage_limit; 'resets <time>' without an epoch gives null resetAt", async () => {
  for (const mode of ["hitlimit", "limitreached"]) {
    const r = await runClaude(input, base(mode));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("usage_limit");
      expect(r.resetAt).toBeNull();
    }
  }
});

test("missing binary is unavailable (not the job's fault), not a throw", async () => {
  const r = await runClaude(input, { ...process.env, SUMMARISER_CMD: "/nonexistent/claude-bin" } as NodeJS.ProcessEnv);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.kind).toBe("unavailable");
});

test("connection errors, 5xx, 529 overloaded and a silent crash are unavailable", async () => {
  for (const mode of ["overloaded", "server500", "connection", "crash"]) {
    const r = await runClaude(input, base(mode));
    expect(r.ok).toBe(false);
    if (!r.ok) expect([mode, r.kind]).toEqual([mode, "unavailable"]);
  }
});

// I2: a call that reached the model and then failed reports what it spent, so the caller can charge it.
test("I2: an error envelope after the model ran carries its usage as tokens", async () => {
  const r = await runClaude(input, base("schemafail"));
  expect(r).toMatchObject({ ok: false, kind: "failed", tokens: 10 + 5 + 7 });
});

test("I2: unusable output carries its usage, or an estimate from the input when the CLI reported none", async () => {
  const notjson = await runClaude(input, base("notjson"));
  expect(notjson).toMatchObject({ ok: false, kind: "bad_output", tokens: 10 + 5 + 7 });
  // A clean exit (0) whose stdout is not an envelope: the model very likely ran, so charge the estimate.
  const garbage = await runClaude(input, base("garbage"));
  expect(garbage).toMatchObject({ ok: false, kind: "bad_output", tokens: estimateTokens("SYS".length + "hello cerebro world".length) });
  // An error envelope with no usage, classified as an unknown failure: estimated too.
  const nousage = await runClaude(input, base("errnousage"));
  expect(nousage).toMatchObject({ ok: false, kind: "failed", tokens: estimateTokens("SYS".length + "hello cerebro world".length) });
});

test("I2: failures that never reached the model carry no tokens", async () => {
  for (const mode of ["auth", "limit", "connection", "overloaded", "crash"]) {
    const r = await runClaude(input, base(mode));
    expect(r.ok).toBe(false);
    if (!r.ok) expect([mode, r.tokens]).toEqual([mode, undefined]);
  }
  const missing = await runClaude(input, { ...process.env, SUMMARISER_CMD: "/nonexistent/claude-bin" } as NodeJS.ProcessEnv);
  expect(!missing.ok && missing.tokens).toBeUndefined();
});

test("an error envelope without result text keeps the CLI's own reason (subtype) in the message", async () => {
  const r = await runClaude(input, base("schemafail"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("error_max_structured_output_retries");
});
