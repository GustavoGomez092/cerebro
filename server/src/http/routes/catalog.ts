import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { createClient, createProject, listClients, listProjects } from "../../catalog";
import { parseBody, uuid } from "../validate";

const name = z.string().trim().min(1).max(200);

export function catalogRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.get("/clients", async (c) => c.json({ clients: await listClients(sql) }));
  r.post("/clients", async (c) => {
    const b = await parseBody(c, z.object({ name }));
    if (b instanceof Response) return b;
    return c.json(await createClient(sql, b.name));
  });
  r.get("/clients/:id/projects", async (c) => {
    const id = c.req.param("id");
    if (!uuid.test(id)) return c.json({ error: "invalid_id" }, 400);
    return c.json({ projects: await listProjects(sql, id) });
  });
  r.post("/projects", async (c) => {
    const b = await parseBody(c, z.object({ clientId: z.string().regex(uuid), name }));
    if (b instanceof Response) return b;
    const [client] = await sql`select id from clients where id = ${b.clientId}`;
    if (!client) return c.json({ error: "unknown_client" }, 400);
    return c.json(await createProject(sql, b.clientId, b.name));
  });
  return r;
}
