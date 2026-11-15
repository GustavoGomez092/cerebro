// A served app (real port, so a fake CLI can reach /mcp/chat) with a web-ui token, chat enabled and a little data.
import { join } from "node:path";
import { freshDb } from "./helpers";
import { ev, sess } from "./fixtures";
import { createApp } from "../src/http/app";
import { createToken } from "../src/auth";
import { fakeEmbedder } from "../src/embed/fake";
import { Metrics } from "../src/metrics";
import { ChatRuns } from "../src/chat/runs";
import { embedPending, newWorkerState } from "../src/worker";

export const FAKE_CHAT = `bun ${join(import.meta.dir, "fakes", "fake-claude-chat.ts")}`;

export async function chatWorld(opts: { mode?: string; timeoutMs?: number; keepAliveMs?: number; max?: number; chat?: boolean; extraEnv?: Record<string, string> } = {}) {
  const db = await freshDb();
  const { token: mac } = await createToken(db.sql, "test-mac");
  const { token: ui } = await createToken(db.sql, "web-ui");
  const metrics = new Metrics();
  const runs = new ChatRuns(opts.max ?? 1);
  let app!: ReturnType<typeof createApp>;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => app.fetch(r) });
  const mcpUrl = `http://127.0.0.1:${server.port}/mcp/chat`;
  const env = { ...process.env, SUMMARISER_CMD: FAKE_CHAT, FAKE_CHAT_MODE: opts.mode ?? "ok", ...opts.extraEnv };
  app = createApp({
    sql: db.sql, embedder: fakeEmbedder(), metrics, log: () => {},
    ...(opts.chat === false ? {} : { chat: { runs, model: "sonnet", timeoutMs: opts.timeoutMs ?? 20_000, mcpUrl, env, keepAliveMs: opts.keepAliveMs } }),
  });
  const call = (method: string, path: string, body?: unknown, tok: string | null = mac) =>
    app.request(path, {
      method,
      headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  // Two clients with "wordpress" sessions.
  const post = async (p: string, b: any) => (await call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Cadco" });
  const B = await post("/v1/clients", { name: "Beta" });
  const bind = async (repo: string, clientId: string) =>
    (await (await call("PUT", "/v1/bindings", { repo, subpath: "", status: "active", clientId })).json()).binding;
  const b1 = await bind("github.com/cadco/site", A.id), b2 = await bind("github.com/beta/site", B.id);
  const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12)).toISOString();
  await call("POST", "/v1/ingest", {
    sessions: [{ ...sess("s1", b1.id, { repo: "github.com/cadco/site" }), startedAt: day(9) }, { ...sess("s2", b2.id, { repo: "github.com/beta/site" }), startedAt: day(1) }],
    events: [{ ...ev("s1", 1, "user", "wordpress checkout"), ts: day(9) }, { ...ev("s2", 1, "user", "wordpress theme"), ts: day(1) }],
  });
  await embedPending(db.sql, fakeEmbedder(), { state: newWorkerState() });
  const run = runs.tryBegin()!; // a run secret for tests that drive runChat directly
  return {
    sql: db.sql, app, call, mac, ui, metrics, runs, mcpUrl, secret: run.secret,
    /** Ends the standing test run so the route's own runs can begin. */
    endStandingRun: () => run.end(),
    async close() { run.end(); server.stop(true); await db.drop(); },
  };
}
