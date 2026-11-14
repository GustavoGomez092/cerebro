import type { SQL } from "bun";
import { chunkEvents, type ChunkInput } from "./chunker";
import type { Embedder } from "./embed/embedder";

export const toVector = (v: number[]) => `[${v.join(",")}]`;

/**
 * Chunks and embeds events not yet indexed, one session at a time. A session whose
 * embedding fails is left untouched (its events stay pending) and retried next run.
 */
export async function indexPending(
  sql: SQL,
  embedder: Embedder,
  opts: { maxSessions?: number; batchSize?: number } = {},
): Promise<{ sessions: number; chunks: number; failed: number }> {
  const maxSessions = opts.maxSessions ?? 20;
  const batchSize = opts.batchSize ?? 16;
  const pending = await sql`select distinct session_id from events where not indexed limit ${maxSessions}`;
  let chunks = 0, failed = 0;
  for (const { session_id } of pending) {
    const rows = await sql`
      select id, seq, ts, kind, text, tool_name, tool_input from events
      where session_id = ${session_id} and not indexed order by seq`;
    const inputs: ChunkInput[] = rows.map((r: any) => ({
      seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, text: r.text, toolName: r.tool_name, toolInput: r.tool_input,
    }));
    const pieces = chunkEvents(inputs);
    let vectors: number[][] = [];
    try {
      for (let i = 0; i < pieces.length; i += batchSize) {
        vectors.push(...(await embedder.embed(pieces.slice(i, i + batchSize).map((p) => p.text))));
      }
    } catch (e) {
      failed++;
      console.error(`indexer: session ${session_id}: ${(e as Error).message}`);
      continue;
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
  }
  return { sessions: pending.length, chunks, failed };
}

/** Runs indexPending forever on an interval; never throws. */
export function startIndexer(sql: SQL, embedder: Embedder, intervalMs = 5000): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await indexPending(sql, embedder);
      if (r.sessions === 20 && r.failed === 0 && !stopped) { timer = setTimeout(tick, 0); return; }
    } catch (e) {
      console.error(`indexer: ${(e as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
