import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";
import { freshDb } from "./helpers";
import { buildServer } from "../src/main";

const base = { DATABASE_URL: "postgres://x", EMBED_URL: "http://cerebro-ollama:11434", EMBED_MODEL_DIGEST: "790764642607" };

test("the web-ui token is never an embed lane: EMBED_MACHINE_URLS may not name it", () => {
  expect(() => loadConfig({ ...base, EMBED_MACHINE_URLS: "web-ui=http://192.168.4.42:11434" })).toThrow(/web-ui/);
  expect(() => loadConfig({ ...base, EMBED_MACHINE_URLS: "mac-mini=http://192.168.4.42:11434,web-ui=http://10.0.0.1:11434" })).toThrow(/web-ui/);
});

test("chat settings: CHAT_MODEL defaults to sonnet, a 5-minute timeout, one run at a time", () => {
  expect(loadConfig(base).chat).toEqual({ model: "sonnet", timeoutMs: 300_000, maxConcurrent: 1 });
  expect(loadConfig({ ...base, CHAT_MODEL: "opus", CHAT_TIMEOUT_MS: "60000", CHAT_MAX_CONCURRENT: "2" }).chat)
    .toEqual({ model: "opus", timeoutMs: 60_000, maxConcurrent: 2 });
});

test("chat settings are validated at startup", () => {
  expect(() => loadConfig({ ...base, CHAT_MAX_CONCURRENT: "3" })).toThrow(/CHAT_MAX_CONCURRENT/);
  expect(() => loadConfig({ ...base, CHAT_MAX_CONCURRENT: "0" })).toThrow(/CHAT_MAX_CONCURRENT/);
  expect(() => loadConfig({ ...base, CHAT_TIMEOUT_MS: "soon" })).toThrow(/CHAT_TIMEOUT_MS/);
  expect(() => loadConfig({ ...base, CHAT_MODEL: "sonnet --dangerously-skip-permissions" })).toThrow(/CHAT_MODEL/);
});

test("buildServer wires one Metrics and the chat agent: its model, cap and this server's own /mcp/chat", async () => {
  const db = await freshDb({ migrate: false });
  try {
    const built = await buildServer({
      DATABASE_URL: db.url, EMBED_URL: "http://127.0.0.1:9", PORT: "8799", CHAT_MODEL: "opus", CHAT_MAX_CONCURRENT: "2", SUMMARISER_ENABLED: "false",
    });
    try {
      expect(built.chat).toMatchObject({ model: "opus", mcpUrl: "http://127.0.0.1:8799/mcp/chat" });
      expect(built.chat.runs.max).toBe(2);
      expect(built.metrics.uptimeSeconds()).toBe(0);
    } finally { built.embedder.stop(); await built.sql.close(); }
  } finally { await db.drop(); }
});

test("SUMMARISER_WORKERS: 1 by default, at most 8", () => {
  const base = { DATABASE_URL: "postgres://x@y/z" };
  expect(loadConfig(base).summariser.workers).toBe(1);
  expect(loadConfig({ ...base, SUMMARISER_WORKERS: "4" }).summariser.workers).toBe(4);
  expect(() => loadConfig({ ...base, SUMMARISER_WORKERS: "9" })).toThrow(/SUMMARISER_WORKERS/);
  expect(() => loadConfig({ ...base, SUMMARISER_WORKERS: "0" })).toThrow(/SUMMARISER_WORKERS/);
});
