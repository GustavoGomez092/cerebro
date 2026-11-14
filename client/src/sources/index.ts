import { claudeCodeSource } from "./claude-code";
import type { HistorySource } from "./types";

/** Every registered history adapter. */
export function allSources(): HistorySource[] {
  return [claudeCodeSource];
}

/** The adapter that owns a transcript path, or null when none recognises it. */
export function sourceFor(path: string): HistorySource | null {
  if (/[\\/]\.claude[\\/]projects[\\/]/.test(path)) return claudeCodeSource;
  return null;
}
