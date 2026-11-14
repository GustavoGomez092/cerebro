import { Hono } from "hono";
import type { SQL } from "bun";
import { bearerAuth, type Machine } from "../auth";
import type { Embedder } from "../embed/embedder";
import { statusRoutes } from "./routes/status";
import { catalogRoutes } from "./routes/catalog";
import { bindingRoutes } from "./routes/bindings";
import { ingestRoutes } from "./routes/ingest";
import { searchRoutes } from "./routes/search";
import { readRoutes } from "./routes/read";

export interface AppDeps { sql: SQL; embedder: Embedder }
export type Env = { Variables: { machine: Machine } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.get("/health", async (c) => {
    let db = false;
    try { await deps.sql`select 1`; db = true; } catch {}
    return c.json({ ok: true, db }, db ? 200 : 503);
  });
  app.use("/v1/*", bearerAuth(deps.sql));
  app.route("/v1", statusRoutes(deps));
  app.route("/v1", catalogRoutes(deps));
  app.route("/v1", bindingRoutes(deps));
  app.route("/v1", ingestRoutes(deps));
  app.route("/v1", searchRoutes(deps));
  app.route("/v1", readRoutes(deps));
  return app;
}
