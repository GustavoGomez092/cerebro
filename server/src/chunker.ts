import type { EventKind } from "@cerebro/shared";

export interface ChunkInput {
  seq: number;
  ts: string;
  kind: EventKind;
  text: string;
  toolName: string | null;
  toolInput: unknown;
}

export interface Chunk {
  firstSeq: number;
  lastSeq: number;
  /** Window index when one event is split; 0 otherwise. */
  part: number;
  tsFrom: string;
  tsTo: string;
  text: string;
}

const TOOL_INPUT_MAX = 300;

function render(e: ChunkInput): string | null {
  switch (e.kind) {
    case "tool_result":
      return null; // tool outputs are stored raw but never indexed
    case "tool_call": {
      const input = e.toolInput == null ? "" : JSON.stringify(e.toolInput).slice(0, TOOL_INPUT_MAX);
      return `Tool ${e.toolName ?? "unknown"}: ${input}`;
    }
    case "user":
      return e.text.trim() ? `User: ${e.text.trim()}` : null;
    case "assistant":
      return e.text.trim() ? `Assistant: ${e.text.trim()}` : null;
  }
}

/** Groups indexable events into search chunks of at most `maxChars` characters. */
export function chunkEvents(events: ChunkInput[], maxChars = 1600, overlap = 200): Chunk[] {
  const out: Chunk[] = [];
  let buf: { e: ChunkInput; text: string }[] = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push({
      firstSeq: buf[0].e.seq, lastSeq: buf[buf.length - 1].e.seq, part: 0,
      tsFrom: buf[0].e.ts, tsTo: buf[buf.length - 1].e.ts,
      text: buf.map((b) => b.text).join("\n"),
    });
    buf = [];
    size = 0;
  };
  for (const e of events) {
    const text = render(e);
    if (!text) continue;
    if (text.length > maxChars) {
      flush();
      const step = maxChars - overlap;
      for (let start = 0, part = 0; start < text.length; start += step, part++) {
        out.push({ firstSeq: e.seq, lastSeq: e.seq, part, tsFrom: e.ts, tsTo: e.ts, text: text.slice(start, start + maxChars) });
        if (start + maxChars >= text.length) break;
      }
      continue;
    }
    const added = (buf.length ? 1 : 0) + text.length;
    if (size + added > maxChars) flush();
    size += (buf.length ? 1 : 0) + text.length;
    buf.push({ e, text });
  }
  flush();
  return out;
}
