import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { search } from "../../search";
import { parseBody, uuid } from "../validate";

const iso = z.string().datetime({ offset: true });
const schema = z.object({
  query: z.string().max(2000),
  repo: z.string().max(1000).optional(),
  subpath: z.string().max(1000).optional(),
  clientId: z.string().regex(uuid).optional(),
  projectId: z.string().regex(uuid).optional(),
  from: iso.optional(),
  to: iso.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export function searchRoutes({ sql, embedder }: AppDeps) {
  const r = new Hono<Env>();
  r.post("/search", async (c) => {
    const b = await parseBody(c, schema);
    if (b instanceof Response) return b;
    const { scope, hits, degraded } = await search(sql, embedder, b);
    return c.json({ scope: scope.kind, hits, degraded });
  });
  return r;
}
