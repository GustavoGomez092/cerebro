import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { search, ScopeError } from "../../search";
import { BindingError } from "../../bindings";
import { parseBody, uuid } from "../validate";
import { embedderFor } from "../../embed/embedder";

const iso = z.string().datetime({ offset: true });
const schema = z.object({
  query: z.string().max(2000),
  repo: z.string().max(1000).optional(),
  subpath: z.string().max(1000).optional(),
  scope: z.literal("open").optional(),
  clientId: z.string().regex(uuid).optional(),
  projectId: z.string().regex(uuid).optional(),
  from: iso.optional(),
  to: iso.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  include: z.enum(["all", "summaries", "raw"]).optional(),
}).refine((b) => !b.from || !b.to || Date.parse(b.from) <= Date.parse(b.to), { message: "from must not be after to" });

export function searchRoutes({ sql, embedder, gate }: AppDeps) {
  const r = new Hono<Env>();
  r.post("/search", async (c) => {
    const b = await parseBody(c, schema);
    if (b instanceof Response) return b;
    try {
      // The query embeds on the asking machine's own Ollama (EMBED_MACHINE_URLS), else on the Zima.
      return c.json(await search(sql, embedderFor(embedder, c.get("machine").name), b, { gate }));
    } catch (e) {
      if (e instanceof ScopeError) return c.json({ error: "scope_required", message: e.message }, 400);
      if (e instanceof BindingError) return c.json({ error: "invalid_subpath", message: e.message }, 400);
      throw e;
    }
  });
  return r;
}
