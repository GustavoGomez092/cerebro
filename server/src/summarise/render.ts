import type { EventKind } from "@cerebro/shared";

/** An `events` row as read for summarising (column names as in the table). */
export interface EventRow {
  seq: number;
  ts: string | Date;
  kind: EventKind;
  text: string;
  tool_name: string | null;
  tool_input: unknown;
  meta?: Record<string, unknown> | null;
}

export interface RenderedPiece {
  text: string;
  firstSeq: number;
  lastSeq: number;
  tsFrom: string;
  tsTo: string;
}

const PREVIEW = 300;
const CEREBRO_TOOL = "mcp__cerebro__";

const iso = (ts: string | Date) => new Date(ts).toISOString();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** One transcript line (without time prefix) for an event, or null when it is left out of model input. */
function line(e: EventRow, toolName: string | null): string | null {
  if (e.meta && e.meta.isMeta === true) return null;
  switch (e.kind) {
    case "user":
    case "assistant": {
      // Thinking blocks arrive as assistant events with empty text (the thinking lives in meta).
      const text = e.text.trim();
      // Continuation lines are indented, so message text can never pose as a new transcript line.
      return text ? `${e.kind === "user" ? "User" : "Assistant"}: ${text.replace(/\r\n|\r|\n/g, "\n  ")}` : null;
    }
    case "tool_call": {
      if (toolName?.startsWith(CEREBRO_TOOL)) return null;
      const input = e.tool_input == null ? "" : oneLine(JSON.stringify(e.tool_input)).slice(0, PREVIEW);
      return `Tool ${toolName ?? "unknown"}: ${input}`;
    }
    case "tool_result": {
      if (toolName?.startsWith(CEREBRO_TOOL)) return null;
      const out = oneLine(e.text).slice(0, PREVIEW);
      return out ? `Result: ${out}` : null;
    }
  }
}

/**
 * Renders events into compact model input: `[HH:MM] User: …`, `Assistant: …`, `Tool <name>: <input>`,
 * `Result: <preview>` (UTC), with a date line at the start of each piece and when the day changes.
 * Cerebro's own tool calls and results, thinking and meta events are left out. Splits at event
 * boundaries into pieces of at most `maxChars`; a single oversized event is truncated to fit.
 */
export function renderRange(events: EventRow[], maxChars = 60_000): RenderedPiece[] {
  const pieces: RenderedPiece[] = [];
  let lines: string[] = [];
  let size = 0;
  let day = "";
  let first: EventRow | null = null;
  let last: EventRow | null = null;
  let lastToolName: string | null = null;

  const flush = () => {
    if (first && last) {
      pieces.push({ text: lines.join("\n"), firstSeq: first.seq, lastSeq: last.seq, tsFrom: iso(first.ts), tsTo: iso(last.ts) });
    }
    lines = [];
    size = 0;
    day = "";
    first = last = null;
  };
  const add = (l: string) => {
    size += (lines.length ? 1 : 0) + l.length;
    lines.push(l);
  };

  for (const e of events) {
    if (e.kind === "tool_call") lastToolName = e.tool_name;
    // A result without a recorded tool name belongs to the call before it.
    const toolName = e.kind === "tool_result" ? (e.tool_name ?? lastToolName) : e.tool_name;
    const body = line(e, toolName);
    if (!body) continue;

    const at = iso(e.ts);
    const dayLine = `-- ${at.slice(0, 10)} (UTC) --`;
    let stamped = `[${at.slice(11, 16)}] ${body}`;
    const needsDay = dayLine !== day;
    const cost = (lines.length ? 1 : 0) + (needsDay ? dayLine.length + 1 : 0) + stamped.length;
    if (lines.length && size + cost > maxChars) flush();

    if (!lines.length) {
      const room = maxChars - dayLine.length - 1;
      if (stamped.length > room) stamped = stamped.slice(0, Math.max(0, room - 1)) + "…";
    }
    if (dayLine !== day) {
      add(dayLine);
      day = dayLine;
    }
    add(stamped);
    first ??= e;
    last = e;
  }
  flush();
  return pieces;
}
