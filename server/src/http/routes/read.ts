import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { getEvents, listSessions, parseCursor } from "../../read";
import { scopeFor, ScopeError } from "../../search";
import type { Binding, SearchScope } from "@cerebro/shared";
import { BindingError } from "../../bindings";
import { uuid } from "../validate";

export const iso = z.string().datetime({ offset: true });
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
/** Query parameters that pick a read's scope (see scopeFor). */
export const scopeParams = {
  repo: z.string().max(1000).optional(),
  subpath: z.string().max(1000).optional(),
  scope: z.literal("open").optional(),
  clientId: z.string().regex(uuid).optional(),
  projectId: z.string().regex(uuid).optional(),
};
const listQuery = z.object({
  ...scopeParams,
  from: iso.optional(),
  to: iso.optional(),
  limit: int(1, 200).optional(),
  before: z.string().max(300).refine((s) => parseCursor(s) !== null, { message: "before must be a cursor from a previous page's next" }).optional(),
}).refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), { message: "from must not be after to" });
const eventsQuery = z.object({ ...scopeParams, afterSeq: int(-1, 2_147_483_647).optional(), limit: int(1, 1000).optional(), full: z.literal("1").optional() });

/** Resolves the request's scope and runs `fn` in it; a missing scope or a bad subpath is a 400. */
export async function withScope(
  sql: AppDeps["sql"], c: any, q: Parameters<typeof scopeFor>[1],
  fn: (scope: SearchScope, active: Binding | null) => Promise<Response>,
): Promise<Response> {
  try {
    const { scope, active } = await scopeFor(sql, q);
    return await fn(scope, active);
  } catch (e) {
    if (e instanceof ScopeError) return c.json({ error: "scope_required", message: e.message }, 400);
    if (e instanceof BindingError) return c.json({ error: "invalid_subpath", message: e.message }, 400);
    throw e;
  }
}

export function readRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  const scoped = (c: any, q: any, fn: (scope: SearchScope) => Promise<Response>) => withScope(sql, c, q, fn);
  r.get("/sessions", async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", message: q.error.issues[0]?.message ?? "invalid query" }, 400);
    return scoped(c, q.data, async (scope) => c.json(await listSessions(sql, scope, q.data)));
  });
  r.get("/sessions/:id/events", async (c) => {
    const q = eventsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_query", message: q.error.issues[0]?.message ?? "invalid query" }, 400);
    return scoped(c, q.data, async (scope) => {
      const page = await getEvents(sql, c.req.param("id"), scope, { afterSeq: q.data.afterSeq, limit: q.data.limit, full: q.data.full === "1" });
      return page ? c.json(page) : c.json({ error: "unknown_session", message: "no such session in this scope" }, 404);
    });
  });
  return r;
}
