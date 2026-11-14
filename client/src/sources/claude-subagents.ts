import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { storable } from "@cerebro/shared";
import { claudeCodeSource } from "./claude-code";
import { headLines } from "./lines";
import type { HistorySource, SourceFile, SourceRead } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The `cwd` of the first transcript entry that has one, read from the head of the file. */
function firstCwd(path: string): string | null {
  for (const line of headLines(path)) {
    try {
      const e = JSON.parse(line);
      if (isObj(e) && typeof e.cwd === "string" && e.cwd) return storable(e.cwd);
    } catch { /* not an entry */ }
  }
  return null;
}

/** `<project>/<parent session>/subagents/<file>.jsonl` → the parent session id. */
const parentOf = (path: string): string => basename(dirname(dirname(path)));
/** `<project>/<parent>.jsonl`, the parent session's own transcript. */
const parentTranscript = (path: string): string => join(dirname(dirname(dirname(path))), `${parentOf(path)}.jsonl`);

/** `agentType` from the `<stem>.meta.json` Claude Code writes next to a subagent transcript, if any. */
function agentType(path: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return isObj(meta) && typeof meta.agentType === "string" && meta.agentType ? storable(meta.agentType) : null;
  } catch {
    return null;
  }
}

/** Claude Code subagent transcripts: `~/.claude/projects/<dir>/<session>/subagents/*.jsonl`, each its own session. */
export const claudeSubagentsSource: HistorySource = {
  id: "claude-code-subagent",
  live: false,

  async discover(roots) {
    const projects = join(roots?.home ?? homedir(), ".claude", "projects");
    const out: SourceFile[] = [];
    let dirs: string[] = [];
    try { dirs = readdirSync(projects); } catch { return out; }
    for (const dir of dirs) {
      let sessions: string[] = [];
      try { sessions = readdirSync(join(projects, dir)); } catch { continue; }
      for (const parent of sessions) {
        const subagents = join(projects, dir, parent, "subagents");
        let names: string[] = [];
        try { names = readdirSync(subagents); } catch { continue; }
        let parentCwd: string | null | undefined;
        for (const name of names) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(subagents, name);
          try {
            const st = statSync(path);
            if (!st.isFile()) continue;
            const stem = basename(name, ".jsonl").replace(/^agent-/, "");
            let cwd = firstCwd(path);
            if (!cwd) {
              if (parentCwd === undefined) parentCwd = firstCwd(parentTranscript(path));
              cwd = parentCwd;
            }
            out.push({
              source: "claude-code-subagent", path, sessionId: `${parent}/agent-${stem}`, cwd,
              modifiedMs: st.mtimeMs, endOffset: st.size,
            });
          } catch { /* vanished between listing and stat */ }
        }
      }
    }
    return out;
  },

  read(file, cursor): SourceRead {
    // Same transcript format as a main session; only the session's links differ.
    const r = claudeCodeSource.read(file, cursor);
    const sessionMeta: Record<string, unknown> = { ...r.sessionMeta, parentSessionId: storable(parentOf(file.path)) };
    const type = agentType(file.path);
    if (type) sessionMeta.agentType = type;
    return { ...r, sessionMeta, cwd: r.cwd ?? firstCwd(parentTranscript(file.path)) };
  },
};
