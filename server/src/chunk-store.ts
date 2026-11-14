import type { SQL } from "bun";
import { chunkEvents, searchTerms, type ChunkInput } from "./chunker";

/**
 * Chunks a session's events and stores the chunks, queueing each for embedding.
 * `priority` 0 = live, 1 = imported/backfill. Returns the number of chunks created.
 */
export async function storeChunks(tx: SQL, sessionId: string, events: ChunkInput[], priority: number): Promise<number> {
  const rows = chunkEvents([...events].sort((a, b) => a.seq - b.seq)).map((c) => ({
    first_seq: c.firstSeq, last_seq: c.lastSeq, part: c.part, ts_from: c.tsFrom, ts_to: c.tsTo, text: c.text, extra_terms: searchTerms(c.text),
  }));
  if (!rows.length) return 0;
  const created = await tx`
    with ins as (
      insert into chunks (session_id, first_seq, last_seq, part, ts_from, ts_to, text, extra_terms)
      select ${sessionId}, x.first_seq, x.last_seq, x.part, x.ts_from, x.ts_to, x.text, x.extra_terms
      from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as x(
        first_seq integer, last_seq integer, part integer, ts_from timestamptz, ts_to timestamptz, text text, extra_terms text)
      on conflict (session_id, first_seq, last_seq, part) do nothing
      returning id)
    insert into embed_queue (chunk_id, priority) select id, ${priority} from ins returning chunk_id`;
  return created.length;
}
