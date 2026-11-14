/** Postgres text/jsonb cannot hold U+0000 or lone surrogates; make any string storable. */
export function storable(s: string): string {
  return s.replaceAll("\u0000", "�").toWellFormed();
}

/** Applies `fn` to every string (keys included) inside a JSON-like value. */
export function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [fn(k), mapStrings(x, fn)]));
  return v;
}

/** Nesting depth of a JSON-like value; stops counting past `limit`. */
export function depth(v: unknown, limit = 1000): number {
  if (!v || typeof v !== "object" || limit <= 0) return 0;
  let max = 0;
  for (const x of Object.values(v)) max = Math.max(max, depth(x, limit - 1));
  return max + 1;
}
