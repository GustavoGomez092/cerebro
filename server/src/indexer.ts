import type { SQL } from "bun";
import { chunkEvents, type ChunkInput } from "./chunker";
import type { Embedder } from "./embed/embedder";

export const toVector = (v: number[]) => `[${v.join(",")}]`;

/** Per-session retry state, kept by the caller (startIndexer keeps one for the process). */
export type Backoff = Map<string, { failures: number; until: number }>;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Chunks and embeds pending events, oldest sessions first, at most `maxEventsPerSession`
 * events per session per run. A session that fails is left untouched and backs off
 * exponentially so it cannot starve the others.
 */
export async function indexPending(
  sql: SQL,
  embedder: Embedder,
  opts: { maxSessions?: number; batchSize?: number; maxEventsPerSession?: number; backoff?: Backoff } = {},
): Promise<{ sessions: number; chunks: number; failed: number }> {
  const maxSessions = opts.maxSessions ?? 20;
  const batchSize = opts.batchSize ?? 8;
  const maxEvents = opts.maxEventsPerSession ?? 500;
  const backoff: Backoff = opts.backoff ?? new Map();
  const now = Date.now();
  const waiting = [...backoff].filter(([, b]) => b.until > now).map(([id]) => id);
  const pending = await sql`
    select session_id from events
    where not indexed and session_id <> all(${sql.array(waiting, "text")})
    group by session_id order by min(id) limit ${maxSessions}`;
  let chunks = 0, failed = 0;
  for (const { session_id } of pending) {
    try {
      const rows = await sql`
        select id, seq, ts, kind, text, tool_name, tool_input from events
        where session_id = ${session_id} and not indexed order by seq limit ${maxEvents}`;
      const inputs: ChunkInput[] = rows.map((r: any) => ({
        seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, text: r.text, toolName: r.tool_name, toolInput: r.tool_input,
      }));
      const pieces = chunkEvents(inputs);
      const vectors: number[][] = [];
      for (let i = 0; i < pieces.length; i += batchSize) {
        vectors.push(...(await embedder.embed(pieces.slice(i, i + batchSize).map((p) => p.text))));
      }
      const ids = rows.map((r: any) => r.id);
      await sql.begin(async (tx) => {
        for (const [i, p] of pieces.entries()) {
          const res = await tx`
            insert into chunks (session_id, first_seq, last_seq, part, ts_from, ts_to, text, embedding)
            values (${session_id}, ${p.firstSeq}, ${p.lastSeq}, ${p.part}, ${p.tsFrom}, ${p.tsTo}, ${p.text}, ${toVector(vectors[i])}::text::vector)
            on conflict (session_id, first_seq, last_seq, part) do nothing returning id`;
          chunks += res.length;
        }
        await tx`update events set indexed = true where id in ${tx(ids)}`;
      });
      backoff.delete(session_id);
    } catch (e) {
      failed++;
      const failures = (backoff.get(session_id)?.failures ?? 0) + 1;
      backoff.set(session_id, { failures, until: Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) });
      console.error(`indexer: session ${session_id} (failure ${failures}): ${(e as Error).message}`);
    }
  }
  return { sessions: pending.length, chunks, failed };
}

/** Runs indexPending forever on an interval; never throws. */
export function startIndexer(sql: SQL, embedder: Embedder, intervalMs = 5000): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backoff: Backoff = new Map();
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await indexPending(sql, embedder, { backoff });
      if (r.sessions === 20 && r.failed === 0 && !stopped) { timer = setTimeout(tick, 0); return; }
    } catch (e) {
      console.error(`indexer: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
