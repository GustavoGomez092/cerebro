import { Hono } from "hono";
import { z } from "zod";
import { API_VERSION, type AppDeps, type Env } from "../app";
import type { Metrics } from "../../metrics";
import { computeStatus, summaryBacklog } from "./status";
import { clientsOverview, databaseActivity, dbStats, globalSearch, sessionSummaries, throughput } from "../../dashboard";
import { parseBody } from "../validate";
import { streamSSE } from "hono/streaming";
import { runChat, type ChatEvent } from "../../chat/runner";

/** The conversation so far, the owner's new question last. The body limit (64 KB) bounds it too. */
const chatBody = z.strictObject({
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20_000) })).min(1).max(40)
    .refine((m) => m[m.length - 1]?.role === "user", { message: "the last message must be the owner's question" }),
});

const iso = z.string().datetime({ offset: true });
/** No repo, scope, client or project: the dashboard's search is always over everything. */
const searchBody = z.strictObject({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional(),
  include: z.enum(["all", "summaries", "raw"]).optional(),
  from: iso.optional(),
  to: iso.optional(),
}).refine((b) => !b.from || !b.to || Date.parse(b.from) <= Date.parse(b.to), { message: "from must not be after to" });

/** /v1/dashboard/*: the web dashboard's reads. app.ts admits the web-ui token only. */
export function dashboardRoutes(deps: AppDeps & { metrics: Metrics }) {
  const { sql, metrics } = deps;
  const r = new Hono<Env>();

  r.get("/overview", async (c) => {
    const [[settings], status, database, backlog] = await Promise.all([
      sql`select instance_id from settings`, computeStatus(deps), databaseActivity(sql), summaryBacklog(sql),
    ]);
    return c.json({
      health: {
        ok: true, db: true, apiVersion: API_VERSION, instanceId: settings.instance_id,
        startedAt: metrics.startedAt, uptimeSeconds: metrics.uptimeSeconds(),
      },
      status,
      queries: { perMinute: metrics.searchRates(), active: metrics.activeSearches(), database },
      throughput: await throughput(sql, metrics, backlog),
      chat: metrics.chat.snapshot(),
    });
  });

  r.get("/db", async (c) => c.json(await dbStats(sql)));
  r.get("/clients", async (c) => c.json(await clientsOverview(sql)));

  r.post("/search", async (c) => {
    const b = await parseBody(c, searchBody);
    if (b instanceof Response) return b;
    return c.json(await globalSearch(deps, c.get("machine").name, b));
  });

  // One chat turn, streamed as server-sent events: start, tool, text…, then done or error.
  r.post("/chat", async (c) => {
    const chat = deps.chat;
    if (!chat) return c.json({ error: "chat_unavailable", message: "chat is not configured on this server" }, 503);
    const b = await parseBody(c, chatBody);
    if (b instanceof Response) return b;
    const run = chat.runs.tryBegin();
    if (!run) return c.json({ error: "chat_busy", message: "another chat answer is in progress; try again when it ends" }, 429);
    const ctrl = new AbortController();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ctrl.abort());
      const ping = setInterval(() => {
        if (!ctrl.signal.aborted) void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }, chat.keepAliveMs ?? 8000);
      try {
        await stream.writeSSE({ event: "start", data: JSON.stringify({ type: "start", runId: run.id, model: chat.model }) });
        const send = (e: ChatEvent) => { if (!ctrl.signal.aborted) void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }); };
        const result = await runChat({
          messages: b.messages, model: chat.model, mcpUrl: chat.mcpUrl, secret: run.secret, timeoutMs: chat.timeoutMs,
          signal: ctrl.signal, env: chat.env ?? process.env, onEvent: send,
        });
        metrics.chat.recordRun(result);
      } finally {
        clearInterval(ping);
        run.end();
      }
    }, async () => { run.end(); });
  });

  r.get("/sessions/:id/summaries", async (c) => {
    const s = await sessionSummaries(sql, c.req.param("id"));
    return s ? c.json(s) : c.json({ error: "unknown_session", message: "no such session" }, 404);
  });

  return r;
}
