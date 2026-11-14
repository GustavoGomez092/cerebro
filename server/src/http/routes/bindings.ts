import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { adoptSessions, BindingError, moveSession, repointBinding, resolveBinding, upsertBinding } from "../../bindings";
import { parseBody, uuid } from "../validate";

const identity = { repo: z.string().min(1).max(1000), subpath: z.string().max(1000).default("") };
const STATUS = { invalid: 400, conflict: 409, not_found: 404, forbidden: 403, rebind_required: 409 } as const;

/** Runs a binding operation, mapping BindingError to its HTTP status. */
async function guarded(c: Context<Env>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BindingError) {
      const code = e.code === "forbidden" ? "foreign_path_identity" : e.code;
      return c.json({ error: code, message: e.message }, STATUS[e.code]);
    }
    throw e;
  }
}

export function bindingRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/bindings/resolve", (c) => guarded(c, async () => {
    const repo = c.req.query("repo");
    if (!repo) return c.json({ error: "repo_required", message: "repo query parameter is required" }, 400);
    return c.json({ binding: await resolveBinding(sql, repo, c.req.query("subpath") ?? "") });
  }));
  r.put("/bindings", async (c) => {
    const b = await parseBody(c, z.object({
      ...identity,
      status: z.enum(["active", "declined"]),
      clientId: z.string().regex(uuid).nullish(),
      projectId: z.string().regex(uuid).nullish(),
      rebind: z.boolean().optional(),
    }));
    if (b instanceof Response) return b;
    return guarded(c, async () => c.json({ binding: await upsertBinding(sql, b, { machine: c.get("machine"), rebind: b.rebind }) }));
  });
  r.patch("/bindings/:id/identity", async (c) => {
    const id = c.req.param("id");
    if (!uuid.test(id)) return c.json({ error: "invalid_id", message: "binding id must be a uuid" }, 400);
    const b = await parseBody(c, z.object(identity));
    if (b instanceof Response) return b;
    return guarded(c, async () => c.json({ binding: await repointBinding(sql, id, b.repo, b.subpath, c.get("machine")) }));
  });
  r.post("/bindings/:id/adopt", (c) => guarded(c, async () => {
    const id = c.req.param("id");
    if (!uuid.test(id)) return c.json({ error: "invalid_id", message: "binding id must be a uuid" }, 400);
    return c.json({ moved: await adoptSessions(sql, id, c.get("machine")) });
  }));
  r.patch("/sessions/:id", async (c) => {
    const b = await parseBody(c, z.object({ bindingId: z.string().regex(uuid) }));
    if (b instanceof Response) return b;
    return guarded(c, async () => (await moveSession(sql, c.req.param("id"), b.bindingId, c.get("machine")))
      ? c.json({ ok: true })
      : c.json({ error: "unknown_session", message: "no such session" }, 404));
  });
  return r;
}
