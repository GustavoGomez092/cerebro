// A minimal MCP server (Streamable HTTP, JSON responses only) for the chat runs' CLI: initialize, ping, tools/list and
// tools/call over the read-only tools. Each request needs the secret of a run in progress; a request that came through
// a reverse proxy (Caddy adds X-Forwarded-For) is refused, so only the CLI inside the container gets here.
import { Hono } from "hono";
import type { AppDeps, Env } from "../http/app";
import type { Metrics } from "../metrics";
import type { ChatRuns } from "./runs";
import { CHAT_TOOLS, callTool } from "./tools";
import { WEB_UI_MACHINE } from "../config";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip"];

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: any };

export function mcpRoutes(deps: AppDeps & { metrics: Metrics }, runs: ChatRuns) {
  const r = new Hono<Env>();
  const ctx = { sql: deps.sql, embedder: deps.embedder, gate: deps.gate, metrics: deps.metrics, machine: WEB_UI_MACHINE };

  r.use("*", async (c, next) => {
    if (PROXY_HEADERS.some((h) => c.req.header(h) !== undefined)) return c.json({ error: "forbidden", message: "local only" }, 403);
    const m = /^Bearer\s+(\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (!m || !runs.accepts(m[1])) return c.json({ error: "unauthorized", message: "no chat run with this secret" }, 401);
    await next();
  });

  const answer = async (msg: Rpc): Promise<object | null> => {
    const id = msg?.id;
    const isRequest = id !== undefined && id !== null;
    const ok = (result: object) => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: isRequest ? id : null, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "invalid request");
    if (!isRequest) return null; // notifications (initialized, cancelled…) need no answer
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "cerebro", version: "1" },
          instructions: "Read-only access to Cerebro's recorded conversations, summaries and project states.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: CHAT_TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        if (typeof name !== "string") return err(-32602, "params.name is required");
        const res = await callTool(ctx, name, msg.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: res.text }], ...(res.isError ? { isError: true } : {}) });
      }
      default:
        return err(-32601, `method not found: ${msg.method}`);
    }
  };

  r.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
    const out = Array.isArray(body)
      ? (await Promise.all(body.map((m) => answer(m as Rpc)))).filter((x) => x !== null)
      : await answer(body as Rpc);
    if (out === null || (Array.isArray(out) && !out.length)) return c.body(null, 202);
    return c.json(out);
  });
  // No server-initiated stream and no sessions to end.
  r.on(["GET", "DELETE"], "/", (c) => c.json({ error: "method_not_allowed", message: "POST only" }, 405));
  return r;
}
