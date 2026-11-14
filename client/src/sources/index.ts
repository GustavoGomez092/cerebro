import { claudeCodeSource } from "./claude-code";
import { claudeSubagentsSource } from "./claude-subagents";
import { codexSource } from "./codex";
import { geminiSource } from "./gemini";
import { genericSource } from "./generic";
import type { HistorySource } from "./types";

const SOURCES: readonly HistorySource[] = [claudeCodeSource, claudeSubagentsSource, codexSource, geminiSource, genericSource];

/** Every registered history adapter. */
export function allSources(): HistorySource[] {
  return [...SOURCES];
}

/** The adapter with this id (as stored in a cursor's `source`), or null. */
export function sourceById(id: string): HistorySource | null {
  return SOURCES.find((s) => s.id === id) ?? null;
}

/** The adapter that owns a transcript path, or null when none recognises it. */
export function sourceFor(path: string): HistorySource | null {
  const p = path.split("\\").join("/");
  if (p.includes("/.claude/projects/")) return /\/subagents\/[^/]+\.jsonl$/.test(p) ? claudeSubagentsSource : claudeCodeSource;
  if (p.includes("/.codex/sessions/")) return codexSource;
  if (p.includes("/.gemini/tmp/")) return geminiSource;
  if (p.includes("/.cerebro/inbox/")) return genericSource;
  return null;
}
