import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SQL } from "bun";
import { bearerAuth, type Machine } from "../auth";
import type { Embedder } from "../embed/embedder";
import type { EmbedGate, WorkerState } from "../worker";
import { pgState } from "../db";
import { statusRoutes } from "./routes/status";
import { catalogRoutes } from "./routes/catalog";
import { bindingRoutes } from "./routes/bindings";
import { ingestRoutes } from "./routes/ingest";
import { searchRoutes } from "./routes/search";
import { readRoutes } from "./routes/read";

export const API_VERSION = 1;
const SMALL_BODY = 64 * 1024;

export interface AppDeps {
  sql: SQL;
  embedder: Embedder;
  gate?: EmbedGate;
  workerState?: WorkerState;
  /** Structured log sink (one JSON line per request); defaults to stdout. */
  log?: (line: string) => void;
}
export type Env = { Variables: { machine: Machine } };

export function createApp(deps: AppDeps): Hono<Env> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const app = new Hono<Env>();

  // One access-log line per request: who, what, outcome. Never query strings or bodies.
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    log(JSON.stringify({
      t: new Date().toISOString(), machine: c.get("machine")?.name ?? null, method: c.req.method,
      path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started),
    }));
  });
  // Only ingest carries big payloads.
  const small = bodyLimit({ maxSize: SMALL_BODY, onError: (c) => c.json({ error: "too_large", message: "request body too large" }, 413) });
  app.use("*", (c, next) => (c.req.path === "/v1/ingest" ? next() : small(c, next)));

  app.get("/health", async (c) => {
    try {
      const [s] = await deps.sql`select instance_id from settings`;
      return c.json({ ok: true, db: true, apiVersion: API_VERSION, instanceId: s.instance_id });
    } catch {
      return c.json({ ok: false, db: false, apiVersion: API_VERSION, instanceId: null }, 503);
    }
  });
  app.use("/v1/*", bearerAuth(deps.sql));
  for (const routes of [statusRoutes, catalogRoutes, bindingRoutes, ingestRoutes, searchRoutes, readRoutes]) app.route("/v1", routes(deps));

  app.notFound((c) => c.json({ error: "not_found", message: "no such route" }, 404));
  app.onError((err, c) => {
    const state = pgState(err);
    // Log only the error class and code: messages can quote stored conversation text.
    log(JSON.stringify({ level: "error", t: new Date().toISOString(), path: c.req.path, machine: c.get("machine")?.name ?? null, pg: state, error: err.name }));
    if (state?.startsWith("22")) return c.json({ error: "invalid_data", message: "the database rejected a value in this request" }, 422);
    return c.json({ error: "internal", message: "internal error" }, 500);
  });
  return app;
}
