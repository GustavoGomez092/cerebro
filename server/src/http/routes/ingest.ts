import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDeps, Env } from "../app";
import { endSession, IngestError, ingestBatch } from "../../ingest";
import { parseBody, uuid } from "../validate";

const iso = z.string().datetime({ offset: true });
const batchSchema = z.object({
  sessions: z.array(z.object({
    id: z.string().min(1).max(200),
    bindingId: z.string().regex(uuid),
    cwd: z.string().max(4000),
    startedAt: iso,
    imported: z.boolean().optional(),
  })),
  events: z.array(z.object({
    key: z.string().min(1).max(500),
    sessionId: z.string().min(1).max(200),
    seq: z.number().int().nonnegative(),
    ts: iso,
    kind: z.enum(["user", "assistant", "tool_call", "tool_result"]),
    text: z.string(),
    toolName: z.string().max(200).optional(),
    toolInput: z.unknown().optional(),
  })),
});

export function ingestRoutes({ sql }: AppDeps) {
  const r = new Hono<Env>();
  r.post("/ingest", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    const b = await parseBody(c, batchSchema);
    if (b instanceof Response) return b;
    try {
      return c.json(await ingestBatch(sql, c.get("machine").id, b));
    } catch (e) {
      if (e instanceof IngestError) return c.json({ error: e.code, ...e.detail }, 422);
      throw e;
    }
  });
  r.post("/sessions/:id/end", async (c) => {
    const b = await parseBody(c, z.object({ endedAt: iso }));
    if (b instanceof Response) return b;
    return (await endSession(sql, c.req.param("id"), b.endedAt)) ? c.json({ ok: true }) : c.json({ error: "unknown_session" }, 404);
  });
  return r;
}
