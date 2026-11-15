import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { INGEST_LIMITS } from "@cerebro/shared";
import type { AppDeps, Env } from "../app";
import { endSession, ingestBatch } from "../../ingest";
import { parseBody } from "../validate";
import { Semaphore } from "../../semaphore";

const envelope = z.object({ sessions: z.array(z.unknown()), events: z.array(z.unknown()) });
const iso = z.string().datetime({ offset: true });

export function ingestRoutes({ sql, metrics }: AppDeps) {
  const r = new Hono<Env>();
  // Keep big flushes from taking every pooled connection (search, auth and /health need some).
  const gate = new Semaphore(4);
  r.post("/ingest", bodyLimit({ maxSize: INGEST_LIMITS.maxBodyBytes, onError: (c) => c.json({ error: "too_large", message: "request body over 10 MB; split the batch" }, 413) }), async (c) => {
    const b = await parseBody(c, envelope);
    if (b instanceof Response) return b;
    if (b.events.length > INGEST_LIMITS.maxEvents || b.sessions.length > INGEST_LIMITS.maxSessions)
      return c.json({ error: "batch_too_large", message: `at most ${INGEST_LIMITS.maxEvents} events and ${INGEST_LIMITS.maxSessions} sessions per batch` }, 413);
    const result = await gate.run(() => ingestBatch(sql, c.get("machine"), b));
    metrics?.events.add(result.inserted);
    return c.json(result);
  });
  r.post("/sessions/:id/end", async (c) => {
    const b = await parseBody(c, z.object({ endedAt: iso }));
    if (b instanceof Response) return b;
    return (await endSession(sql, c.req.param("id"), b.endedAt))
      ? c.json({ ok: true })
      : c.json({ error: "unknown_session", message: "no such session" }, 404);
  });
  return r;
}
