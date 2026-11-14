import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { storable, type IngestEvent } from "@cerebro/shared";
import { clean } from "./claude-code";
import type { HistorySource, SourceFile, SourceRead } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * One logs.json holds every session of a project, so a Gemini "transcript path" names one session in it:
 * `<dir>/logs.json#<sessionId>`.
 */
function splitPath(path: string): { file: string; session: string } | null {
  const m = /^(.*[\\/]logs\.json)#(.+)$/s.exec(path);
  return m ? { file: m[1]!, session: m[2]! } : null;
}

function readRecords(file: string): unknown[] | null {
  try {
    const records = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(records) ? records : null;
  } catch {
    return null; // missing, unreadable, or caught mid-rewrite
  }
}

/** Gemini CLI prompt logs: `~/.gemini/tmp/<sha256(project path)>/logs.json`, a JSON array rewritten in place. */
export const geminiSource: HistorySource = {
  id: "gemini-cli",
  live: false,

  async discover(roots) {
    const byHash = new Map<string, string>();
    for (const folder of roots?.folders ?? []) {
      byHash.set(sha256(folder), folder);
      try { byHash.set(sha256(realpathSync(folder)), folder); } catch { /* folder gone */ }
    }
    const out: SourceFile[] = [];
    if (byHash.size === 0) return out;
    const tmp = join(roots?.home ?? homedir(), ".gemini", "tmp");
    let hashes: string[] = [];
    try { hashes = readdirSync(tmp); } catch { return out; }
    for (const hash of hashes) {
      const folder = byHash.get(hash);
      if (!folder) continue;
      const file = join(tmp, hash, "logs.json");
      try {
        const st = statSync(file);
        const records = readRecords(file);
        if (!records) continue;
        const sessions = new Set<string>();
        for (const r of records) if (isObj(r) && typeof r.sessionId === "string" && r.sessionId) sessions.add(r.sessionId);
        for (const session of sessions) {
          out.push({
            source: "gemini-cli", path: `${file}#${session}`, sessionId: `gemini:${storable(session)}`, cwd: folder,
            modifiedMs: st.mtimeMs, endOffset: records.length,
          });
        }
      } catch { /* vanished */ }
    }
    return out;
  },

  /** The cursor offset counts records of the file already read (the file is rewritten, so bytes mean nothing). */
  read(file, cursor): SourceRead {
    const none: SourceRead = {
      events: [], sessionMeta: {}, cwd: file.cwd, firstTimestamp: null, headless: false, skipped: 0,
      nextOffset: cursor.offset, nextLine: cursor.line,
    };
    const where = splitPath(file.path);
    const records = where ? readRecords(where.file) : null;
    if (!where || !records) return none;

    // A shorter file was replaced, not appended to: read it again from the start (keys dedupe).
    const from = cursor.offset <= records.length ? cursor.offset : 0;
    const events: IngestEvent[] = [];
    let skipped = 0;
    for (let i = from; i < records.length; i++) {
      const r = records[i];
      if (!isObj(r)) { skipped++; continue; }
      if (r.sessionId !== where.session) continue;
      const ms = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      const id = typeof r.messageId === "number" || (typeof r.messageId === "string" && r.messageId) ? String(r.messageId) : null;
      if (r.type !== "user" || typeof r.message !== "string" || Number.isNaN(ms) || id === null) { skipped++; continue; }
      events.push({
        key: storable(id), sessionId: file.sessionId, seq: i, ts: new Date(ms).toISOString(), kind: "user", text: clean(r.message),
      });
    }
    return {
      ...none, events, firstTimestamp: events[0]?.ts ?? null, skipped, nextOffset: records.length, nextLine: records.length,
    };
  },
};
