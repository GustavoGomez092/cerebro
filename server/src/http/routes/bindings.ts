import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { BindingError, repointBinding, resolveBinding, upsertBinding } from "../../bindings";
import { parseBody, uuid } from "../validate";

const identity = { repo: z.string().min(1).max(1000), subpath: z.string().max(1000).default("") };
const STATUS = { invalid: 400, conflict: 409, not_found: 404 } as const;

export function bindingRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/bindings/resolve", async (c) => {
    const repo = c.req.query("repo");
    if (!repo) return c.json({ error: "repo_required" }, 400);
    try {
      return c.json({ binding: await resolveBinding(sql, repo, c.req.query("subpath") ?? "") });
    } catch (e) {
      if (e instanceof BindingError) return c.json({ error: e.message }, STATUS[e.code]);
      throw e;
    }
  });
  r.put("/bindings", async (c) => {
    const b = await parseBody(c, z.object({
      ...identity,
      status: z.enum(["active", "declined"]),
      clientId: z.string().regex(uuid).nullish(),
      projectId: z.string().regex(uuid).nullish(),
    }));
    if (b instanceof Response) return b;
    try {
      return c.json({ binding: await upsertBinding(sql, b) });
    } catch (e) {
      if (e instanceof BindingError) return c.json({ error: e.message }, STATUS[e.code]);
      throw e;
    }
  });
  r.patch("/bindings/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!uuid.test(id)) return c.json({ error: "invalid_id" }, 400);
    const b = await parseBody(c, z.object(identity));
    if (b instanceof Response) return b;
    try {
      return c.json({ binding: await repointBinding(sql, id, b.repo, b.subpath) });
    } catch (e) {
      if (e instanceof BindingError) return c.json({ error: e.message }, STATUS[e.code]);
      throw e;
    }
  });
  return r;
}
