import { Hono } from "hono";
import type { AppDeps, Env } from "../app";
import { getEvents, listSessions } from "../../read";
import { uuid } from "../validate";

const isoOk = (s?: string) => !s || !Number.isNaN(Date.parse(s));
const intOrUndef = (s?: string) => (s === undefined ? undefined : Number.parseInt(s, 10));

export function readRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/sessions", async (c) => {
    const q = c.req.query();
    if ((q.clientId && !uuid.test(q.clientId)) || (q.projectId && !uuid.test(q.projectId)) || !isoOk(q.from) || !isoOk(q.to))
      return c.json({ error: "invalid_query" }, 400);
    const limit = intOrUndef(q.limit);
    if (limit !== undefined && !(limit > 0)) return c.json({ error: "invalid_query" }, 400);
    return c.json({ sessions: await listSessions(sql, { ...q, limit }) });
  });
  r.get("/sessions/:id/events", async (c) => {
    const fromSeq = intOrUndef(c.req.query("fromSeq")), toSeq = intOrUndef(c.req.query("toSeq"));
    if ([fromSeq, toSeq].some((n) => n !== undefined && Number.isNaN(n))) return c.json({ error: "invalid_query" }, 400);
    const events = await getEvents(sql, c.req.param("id"), { fromSeq, toSeq, full: c.req.query("full") === "1" });
    return events ? c.json({ events }) : c.json({ error: "unknown_session" }, 404);
  });
  return r;
}
