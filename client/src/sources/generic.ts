import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { storable, type EventKind, type IngestEvent } from "@cerebro/shared";
import { clean, cleanDeep, cleanToolInput } from "./claude-code";
import { headLines, readCompleteLines } from "./lines";
import type { HistorySource, SourceFile, SourceRead } from "./types";

/** Agent names become part of session ids and `meta.agent`. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS: readonly EventKind[] = ["user", "assistant", "tool_call", "tool_result"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (v: unknown): string | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

export interface GenericHeader { agent: string; id: string; cwd: string; repo: string | null; startedAt: string; meta: Obj }

/** Parses line 1 of a cerebro-jsonl v1 file; `agent` (from `import-file --agent`) replaces the file's own. */
export function parseHeader(line: string, agent?: string): GenericHeader | { error: string } {
  let h: unknown;
  try { h = JSON.parse(line); } catch { return { error: "line 1 is not JSON" }; }
  if (!isObj(h) || h.type !== "session") return { error: 'line 1 must be {"type":"session",…}' };
  const name = agent ?? h.agent;
  if (typeof name !== "string" || !AGENT_NAME.test(name)) return { error: "agent must be a name of letters, digits, '.', '_' or '-' (pass --agent)" };
  if (typeof h.id !== "string" || h.id === "" || h.id.length > 120) return { error: "id must be a non-empty string of at most 120 characters" };
  if (typeof h.cwd !== "string" || !isAbsolute(h.cwd)) return { error: "cwd must be an absolute path" };
  if (h.repo !== undefined && h.repo !== null && typeof h.repo !== "string") return { error: "repo must be a string" };
  const startedAt = iso(h.startedAt);
  if (!startedAt) return { error: "startedAt must be an ISO 8601 timestamp" };
  if (h.meta !== undefined && !isObj(h.meta)) return { error: "meta must be an object" };
  return { agent: name, id: h.id, cwd: h.cwd, repo: typeof h.repo === "string" && h.repo ? h.repo : null, startedAt, meta: isObj(h.meta) ? h.meta : {} };
}

const isHeader = (h: GenericHeader | { error: string }): h is GenericHeader => !("error" in h);

/** One event line, or null when it does not follow the format. */
function parseEvent(line: string, sessionId: string, seq: number): IngestEvent | null {
  let e: unknown;
  try { e = JSON.parse(line); } catch { return null; }
  if (!isObj(e) || e.type !== "event") return null;
  const ts = iso(e.ts);
  if (typeof e.key !== "string" || e.key === "" || e.key.length > 500 || !ts) return null;
  if (!KINDS.includes(e.kind as EventKind) || typeof e.text !== "string") return null;
  if (e.toolName !== undefined && (typeof e.toolName !== "string" || e.toolName.length > 200)) return null;
  if (e.meta !== undefined && !isObj(e.meta)) return null;
  return {
    key: storable(e.key), sessionId, seq, ts, kind: e.kind as EventKind, text: clean(e.text),
    ...(typeof e.toolName === "string" ? { toolName: clean(e.toolName) } : {}),
    ...(e.toolInput !== undefined ? { toolInput: cleanToolInput(e.toolInput) } : {}),
    ...(isObj(e.meta) ? { meta: cleanDeep(e.meta) as Obj } : {}),
  };
}

const sessionIdOf = (h: GenericHeader) => `${h.agent}:${storable(h.id)}`;
export const inboxDir = (home?: string) => join(home ?? homedir(), ".cerebro", "inbox");

/** A path in `dir` named like `name` that does not exist yet. */
function freePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = basename(name, ext);
  let path = join(dir, name);
  for (let i = 1; existsSync(path); i++) path = join(dir, `${stem}-${i}${ext}`);
  return path;
}

/**
 * Validates a cerebro-jsonl v1 file and copies it into the inbox for the next sync. Throws with a
 * readable reason when the file does not follow the format.
 */
export function addToInbox(src: string, opts: { home?: string; agent?: string } = {}): { path: string; sessionId: string; events: number; skipped: number } {
  const lines = readFileSync(src, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = parseHeader(lines[0] ?? "", opts.agent);
  if (!isHeader(header)) throw new Error(`${src} is not a cerebro-jsonl v1 file: ${header.error}`);
  const sessionId = sessionIdOf(header);
  let events = 0;
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    if (parseEvent(lines[i]!, sessionId, i)) events++; else skipped++;
  }
  if (events === 0) throw new Error(`${src} has no valid event lines`);
  if (opts.agent) lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), agent: opts.agent });

  const dir = inboxDir(opts.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = basename(src).endsWith(".jsonl") ? basename(src) : `${basename(src)}.jsonl`;
  const path = freePath(dir, name);
  // Written under a name sync ignores, then renamed, so a sync never sees half a file.
  const partial = `${path}.partial`;
  writeFileSync(partial, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(partial, path);
  return { path, sessionId, events, skipped };
}

/** Moves a fully read inbox file to `inbox/done/`; returns its new path. */
export function moveToDone(path: string): string {
  const done = join(dirname(path), "done");
  mkdirSync(done, { recursive: true, mode: 0o700 });
  const dest = freePath(done, basename(path));
  renameSync(path, dest);
  return dest;
}

/**
 * The documented cerebro-jsonl v1 format (docs/cerebro-jsonl.md), dropped into `~/.cerebro/inbox/` by agents
 * without an adapter. `meta.agent` comes from the file, not from this adapter's id.
 */
export const genericSource: HistorySource = {
  id: "generic",
  live: false,

  async discover(roots) {
    const dir = inboxDir(roots?.home);
    const out: SourceFile[] = [];
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile() || roots?.unchanged?.(path, st.size, st.mtimeMs)) continue;
        const header = parseHeader(headLines(path)[0] ?? "");
        if (!isHeader(header)) continue; // left in the inbox; `cerebro import-file` explains what is wrong
        out.push({
          source: "generic", path, sessionId: sessionIdOf(header), cwd: storable(header.cwd), repo: header.repo,
          modifiedMs: st.mtimeMs, endOffset: st.size, size: st.size,
        });
      } catch { /* vanished */ }
    }
    return out;
  },

  read(file, cursor): SourceRead {
    const { lines, nextOffset, nextLine } = readCompleteLines(file.path, cursor.offset, cursor.line);
    const events: IngestEvent[] = [];
    let sessionMeta: Obj = {};
    let cwd: string | null = null;
    let firstTimestamp: string | null = null;
    let skipped = 0;
    for (const { lineNo, text } of lines) {
      if (text.trim() === "") continue;
      try {
        if (lineNo === 0) {
          const header = parseHeader(text);
          if (!isHeader(header)) { skipped++; continue; }
          sessionMeta = { ...(cleanDeep(header.meta) as Obj), agent: header.agent };
          cwd = storable(header.cwd);
          firstTimestamp = header.startedAt;
          continue;
        }
        const e = parseEvent(text, file.sessionId, lineNo);
        if (!e) { skipped++; continue; }
        firstTimestamp ??= e.ts;
        events.push(e);
      } catch {
        skipped++;
      }
    }
    return { events, sessionMeta, cwd: cwd ?? file.cwd, firstTimestamp, headless: false, skipped, nextOffset, nextLine };
  },
};
