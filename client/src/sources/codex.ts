import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { storable, type EventKind, type IngestEvent } from "@cerebro/shared";
import { clean, cleanDeep } from "./claude-code";
import { headLines, readCompleteLines } from "./lines";
import type { HistorySource, SourceFile, SourceRead } from "./types";

const MAX_TOOL_NAMES = 5000;
const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const iso = (v: unknown): string | null => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

interface CodexMeta {
  id: string;
  cwd: string | null;
  /** Raw git remote as Codex recorded it (normalised into an identity by sync). */
  repo: string | null;
  sessionMeta: Obj;
  timestamp: string | null;
  headless: boolean;
}

/** The `session_meta` record that opens every rollout, or null when `line` is not one. */
function parseMeta(line: string): CodexMeta | null {
  let e: unknown;
  try { e = JSON.parse(line); } catch { return null; }
  if (!isObj(e) || e.type !== "session_meta" || !isObj(e.payload)) return null;
  const p = e.payload;
  const id = str(p.id);
  if (!id) return null;
  const git = isObj(p.git) ? p.git : {};
  const originator = str(p.originator);
  const launchedBy = str(p.source);
  const sessionMeta: Obj = {};
  if (originator) sessionMeta.originator = clean(originator);
  const cliVersion = str(p.cli_version);
  if (cliVersion) sessionMeta.cliVersion = clean(cliVersion);
  if (launchedBy) sessionMeta.launchedBy = clean(launchedBy);
  const branch = str(git.branch);
  // Branch names are free-form and can embed a token.
  if (branch) sessionMeta.gitBranch = clean(branch);
  const cwd = str(p.cwd);
  return {
    id: storable(id),
    cwd: cwd ? storable(cwd) : null,
    repo: str(git.repository_url) ?? null,
    sessionMeta,
    timestamp: iso(e.timestamp) ?? iso(p.timestamp),
    // `codex exec` and SDK-driven runs are scripted, like `claude -p`.
    headless: launchedBy === "exec" || /sdk|exec/.test(originator ?? ""),
  };
}

/** Text of a message's content parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!isObj(p)) return "";
      if (p.type === "input_text" || p.type === "output_text" || p.type === "text") return typeof p.text === "string" ? p.text : "";
      if (p.type === "input_image") return "[image]";
      return "";
    })
    .filter((t) => t !== "")
    .join("\n");
}

/** Context Codex injects as a "user" message (environment, AGENTS.md instructions); not something the user typed. */
const INJECTED = /^\s*<(environment_context|user_instructions)>/;

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  if (Array.isArray(output)) return messageText(output);
  return JSON.stringify(output);
}

function toolInputOf(p: Obj): unknown {
  if (p.type === "custom_tool_call") return p.input ?? "";
  if (typeof p.arguments !== "string") return p.arguments ?? {};
  try { return JSON.parse(p.arguments); } catch { return p.arguments; }
}

function toolNameMap(state: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (isObj(state) && isObj(state.toolNames)) {
    for (const [k, v] of Object.entries(state.toolNames)) if (typeof v === "string") map.set(k, v);
  }
  return map;
}

/** Codex CLI rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, one session per file, append-only. */
export const codexSource: HistorySource = {
  id: "codex",
  live: false,

  async discover(roots) {
    const dir = join(roots?.home ?? homedir(), ".codex", "sessions");
    const out: SourceFile[] = [];
    let names: string[] = [];
    try { names = readdirSync(dir, { recursive: true }) as string[]; } catch { return out; }
    for (const rel of names) {
      const name = basename(rel);
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, rel);
      try {
        const st = statSync(path);
        if (!st.isFile() || roots?.unchanged?.(path, st.size, st.mtimeMs)) continue;
        const meta = parseMeta(headLines(path)[0] ?? "");
        const id = meta?.id ?? UUID_IN_NAME.exec(name)?.[1];
        if (!id) continue;
        out.push({
          source: "codex", path, sessionId: `codex:${id}`, cwd: meta?.cwd ?? null, repo: meta?.repo ?? null,
          modifiedMs: st.mtimeMs, endOffset: st.size, size: st.size,
        });
      } catch { /* vanished between listing and stat */ }
    }
    return out;
  },

  read(file, cursor): SourceRead {
    const { lines, nextOffset, nextLine } = readCompleteLines(file.path, cursor.offset, cursor.line);
    const toolNames = toolNameMap(cursor.state);
    const events: IngestEvent[] = [];
    let sessionMeta: Obj = {};
    let cwd: string | null = null;
    let firstTimestamp: string | null = null;
    let headless = false;
    let skipped = 0;

    for (const { lineNo, text } of lines) {
      if (text.trim() === "") continue;
      try {
        let e: unknown;
        try { e = JSON.parse(text); } catch { skipped++; continue; }
        if (!isObj(e)) { skipped++; continue; }
        if (e.type === "session_meta") {
          const meta = parseMeta(text);
          if (!meta) { skipped++; continue; }
          sessionMeta = meta.sessionMeta;
          cwd = meta.cwd;
          firstTimestamp ??= meta.timestamp;
          headless = meta.headless;
          continue;
        }
        const p = e.payload;
        const ts = iso(e.timestamp);
        if (e.type !== "response_item" || !isObj(p) || !ts) { skipped++; continue; }

        const push = (kind: EventKind, body: string, extra: Partial<IngestEvent> = {}) => {
          firstTimestamp ??= ts;
          events.push({ key: `${lineNo}:0`, sessionId: file.sessionId, seq: lineNo * 16, ts, kind, text: body, ...extra });
        };
        switch (p.type) {
          case "message": {
            if (p.role !== "user" && p.role !== "assistant") { skipped++; break; }
            const body = messageText(p.content);
            if (p.role === "user" && INJECTED.test(body)) { skipped++; break; }
            push(p.role, clean(body));
            break;
          }
          case "function_call":
          case "custom_tool_call": {
            const name = str(p.name);
            if (!name) { skipped++; break; }
            const callId = str(p.call_id);
            if (callId) toolNames.set(callId, name);
            push("tool_call", "", { toolName: storable(name), toolInput: cleanDeep(toolInputOf(p)), ...(callId ? { meta: { callId: clean(callId) } } : {}) });
            break;
          }
          case "function_call_output":
          case "custom_tool_call_output": {
            const callId = str(p.call_id);
            const name = callId ? toolNames.get(callId) : undefined;
            push("tool_result", clean(outputText(p.output)), {
              ...(name ? { toolName: storable(name) } : {}),
              ...(callId ? { meta: { callId: clean(callId) } } : {}),
            });
            break;
          }
          case "reasoning": {
            const summary = Array.isArray(p.summary)
              ? p.summary.map((s) => (isObj(s) && typeof s.text === "string" ? s.text : "")).filter((t) => t !== "").join("\n")
              : "";
            if (!summary) { skipped++; break; }
            push("assistant", "", { meta: { reasoning: clean(summary) } });
            break;
          }
          default:
            skipped++;
        }
      } catch {
        skipped++;
      }
    }

    const recent = [...toolNames].slice(-MAX_TOOL_NAMES);
    return {
      events, sessionMeta, cwd: cwd ?? file.cwd, firstTimestamp, headless, skipped, nextOffset, nextLine,
      state: { toolNames: Object.fromEntries(recent) },
    };
  },
};
