import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { redactSecrets, storable, type EventKind, type IngestEvent } from "@cerebro/shared";
import { readCompleteLines } from "./lines";
import type { HistorySource, SourceFile, SourceRead } from "./types";

/** Event text over this (JSON-encoded) is truncated; with a capped tool input an event stays well under a batch (8 MB). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** A tool input whose JSON is over this is replaced by its size and a preview. */
const MAX_TOOL_INPUT_BYTES = 1024 * 1024;
const TOOL_INPUT_PREVIEW_CHARS = 2000;
const MAX_BLOCKS = 16;
const MAX_TOOL_NAMES = 5000;

export interface NormalizeResult {
  events: IngestEvent[];
  sessionMeta: Record<string, unknown>;
  firstTimestamp: string | null;
  entrypoint: string | null;
  /** First `cwd` seen on a well-formed entry. */
  cwd: string | null;
  skipped: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Bytes a string takes inside a JSON batch (escapes included, quotes not). */
const encodedBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s)) - 2;

/**
 * Makes text storable and redacts secrets FIRST, then truncates, so a secret straddling the cut
 * (e.g. a PEM key losing its END line) can never survive unredacted. The cut keeps the JSON encoding
 * (where newlines, quotes and terminal escapes grow) within 4 MB, so one event always fits a batch.
 */
export function clean(text: string): string {
  const t = redactSecrets(storable(text));
  // Each UTF-16 unit encodes to at most 6 JSON bytes, so shorter text can never be over the limit.
  if (t.length * 6 <= MAX_TEXT_BYTES || encodedBytes(t) <= MAX_TEXT_BYTES) return t;
  const raw = Buffer.from(t);
  let keep = Math.min(raw.length, MAX_TEXT_BYTES);
  for (;;) {
    const cut = storable(raw.subarray(0, keep).toString("utf8"));
    const size = encodedBytes(cut);
    if (size <= MAX_TEXT_BYTES) return cut + `\n[truncated by cerebro: ${raw.length} bytes total]`;
    keep = Math.floor((keep * MAX_TEXT_BYTES) / size) - 6; // shrink by the escape ratio seen, a little more each round
  }
}

/** Cleans every string value (keys go through `storable` only). */
export function cleanDeep(v: unknown): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [storable(k), cleanDeep(x)]));
  return v;
}

/**
 * Cleans a tool input like `cleanDeep`; when its JSON is over 1 MB it is replaced by its size and the
 * start of that JSON, so a huge input (a file written in one call) never makes its event too big to upload.
 */
export function cleanToolInput(v: unknown): unknown {
  const cleaned = cleanDeep(v);
  const json = JSON.stringify(cleaned) ?? "";
  // Each UTF-16 unit is at most 3 UTF-8 bytes, so shorter JSON can never be over the limit.
  if (json.length * 3 <= MAX_TOOL_INPUT_BYTES || Buffer.byteLength(json) <= MAX_TOOL_INPUT_BYTES) return cleaned;
  return { truncated_by_cerebro: Buffer.byteLength(json), preview: storable(json.slice(0, TOOL_INPUT_PREVIEW_CHARS)) };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!isObj(p)) return "";
      if (p.type === "text") return typeof p.text === "string" ? p.text : "";
      if (p.type === "image") return "[image]";
      return `[${typeof p.type === "string" ? p.type : "unknown"}]`;
    })
    .join("\n");
}

export function normalizeEntries(
  lines: { lineNo: number; text: string }[],
  sessionId: string,
  toolNames: Map<string, string>,
): NormalizeResult {
  const events: IngestEvent[] = [];
  const sessionMeta: Record<string, unknown> = {};
  let firstTimestamp: string | null = null;
  let entrypoint: string | null = null;
  let cwd: string | null = null;
  let skipped = 0;

  for (const { lineNo, text } of lines) {
    if (text.trim() === "") continue;
    try {
      let e: unknown;
      try { e = JSON.parse(text); } catch { skipped++; continue; }
      if (!isObj(e) || (e.type !== "user" && e.type !== "assistant")) { skipped++; continue; }
      const uuid = str(e.uuid);
      const tsMs = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (!uuid || Number.isNaN(tsMs) || !isObj(e.message)) { skipped++; continue; }
      const ts = new Date(tsMs).toISOString();
      const entryKind: EventKind = e.type;

      const meta: Obj = { uuid: storable(uuid) };
      const parent = str(e.parentUuid);
      if (parent) meta.parentUuid = storable(parent);
      if (typeof e.isSidechain === "boolean") meta.isSidechain = e.isSidechain;
      for (const k of ["gitBranch", "version", "entrypoint"] as const) {
        const v = str(e[k]);
        // gitBranch is free-form (can embed a token); version/entrypoint are identifiers.
        if (v) meta[k] = k === "gitBranch" ? clean(v) : storable(v);
      }
      const model = str(e.message.model);
      if (model) meta.model = storable(model);

      firstTimestamp ??= ts;
      for (const k of ["gitBranch", "version", "entrypoint"] as const) {
        if (typeof meta[k] === "string" && !(k in sessionMeta)) sessionMeta[k] = meta[k];
      }
      if (entrypoint === null && typeof meta.entrypoint === "string") entrypoint = meta.entrypoint;
      const entryCwd = str(e.cwd);
      if (cwd === null && entryCwd) cwd = storable(entryCwd);

      const push = (index: number, kind: EventKind, body: string, extra: Partial<IngestEvent> = {}, extraMeta: Obj = {}) => {
        events.push({
          key: `${storable(uuid)}:${index}`,
          sessionId,
          seq: lineNo * 16 + index,
          ts,
          kind,
          text: body,
          ...extra,
          meta: { ...meta, ...extraMeta },
        });
      };

      const content = e.message.content;
      if (typeof content === "string") {
        push(0, entryKind, clean(content));
        continue;
      }
      if (!Array.isArray(content)) { skipped++; continue; }

      content.forEach((b: unknown, index: number) => {
        if (index >= MAX_BLOCKS) { skipped++; return; }
        if (!isObj(b)) { skipped++; return; }
        switch (b.type) {
          case "text":
            push(index, entryKind, clean(typeof b.text === "string" ? b.text : ""));
            break;
          case "thinking":
            push(index, "assistant", "", {}, { thinking: clean(typeof b.thinking === "string" ? b.thinking : "") });
            break;
          case "image":
            push(index, entryKind, "[image]");
            break;
          case "tool_use": {
            const name = str(b.name);
            if (!name) { skipped++; return; }
            const id = str(b.id);
            if (id) toolNames.set(id, name);
            push(index, "tool_call", "", { toolName: storable(name), toolInput: cleanToolInput(b.input ?? {}) });
            break;
          }
          case "tool_result": {
            const id = str(b.tool_use_id);
            const name = (id && toolNames.get(id)) || null;
            push(index, "tool_result", clean(resultText(b.content)), name ? { toolName: storable(name) } : {});
            break;
          }
          default:
            skipped++;
        }
      });
    } catch {
      skipped++;
    }
  }
  return { events, sessionMeta, firstTimestamp, entrypoint, cwd, skipped };
}

function toolNameMap(state: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (isObj(state) && isObj(state.toolNames)) {
    for (const [k, v] of Object.entries(state.toolNames)) if (typeof v === "string") map.set(k, v);
  }
  return map;
}

export const claudeCodeSource: HistorySource = {
  id: "claude-code",
  live: true,

  async discover(roots) {
    const projects = join(roots?.home ?? homedir(), ".claude", "projects");
    const out: SourceFile[] = [];
    let dirs: string[] = [];
    try { dirs = readdirSync(projects); } catch { return out; }
    for (const dir of dirs) {
      let names: string[] = [];
      try { names = readdirSync(join(projects, dir)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(projects, dir, name);
        try {
          const st = statSync(path);
          if (!st.isFile()) continue;
          out.push({ source: "claude-code", path, sessionId: basename(name, ".jsonl"), cwd: null, modifiedMs: st.mtimeMs });
        } catch { /* vanished between listing and stat */ }
      }
    }
    return out;
  },

  read(file, cursor): SourceRead {
    const { lines, nextOffset, nextLine } = readCompleteLines(file.path, cursor.offset, cursor.line);
    const toolNames = toolNameMap(cursor.state);
    const r = normalizeEntries(lines, file.sessionId, toolNames);
    const recent = [...toolNames].slice(-MAX_TOOL_NAMES);
    return {
      events: r.events,
      sessionMeta: r.sessionMeta,
      cwd: r.cwd ?? file.cwd,
      firstTimestamp: r.firstTimestamp,
      // `claude -p` and SDK runs report an "sdk-*" entrypoint; "cli", "claude-desktop" and IDE ones are interactive.
      headless: r.entrypoint !== null && r.entrypoint.startsWith("sdk"),
      skipped: r.skipped,
      nextOffset,
      nextLine,
      state: { toolNames: Object.fromEntries(recent) },
    };
  },
};
