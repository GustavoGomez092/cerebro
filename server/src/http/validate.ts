import type { Context } from "hono";
import type { ZodType } from "zod";

/** Parses a JSON body with a zod schema; returns a 400 Response on failure. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "invalid_json", message: "body is not valid JSON" }, 400); }
  const r = schema.safeParse(raw);
  return r.success ? r.data : c.json({ error: "invalid_body", message: r.error.issues[0]?.message ?? "invalid body", issues: r.error.issues }, 400);
}

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
