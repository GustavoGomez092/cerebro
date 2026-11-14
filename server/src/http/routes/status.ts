import { Hono } from "hono";
import type { AppDeps, Env } from "../app";

export function statusRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/status", async (c) => {
    const [{ n }] = await sql`select count(*)::int as n from events where not indexed`;
    return c.json({ machine: c.get("machine").name, unindexedEvents: n });
  });
  return r;
}
