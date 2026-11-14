import type { IngestEvent } from "@cerebro/shared";

export interface SourceFile { source: string; path: string; sessionId: string; cwd: string | null; modifiedMs: number }

export interface SourceRead {
  events: IngestEvent[];
  sessionMeta: Record<string, unknown>;
  cwd: string | null;
  firstTimestamp: string | null;
  headless: boolean;
  skipped: number;
  nextOffset: number;
  nextLine: number;
  state?: unknown;
}

/** Contract every agent adapter implements. */
export interface HistorySource {
  /** "claude-code", "codex", …; becomes meta.agent. */
  id: string;
  /** True only for claude-code (captured by hooks). */
  live: boolean;
  discover(roots?: { home?: string }): Promise<SourceFile[]>;
  read(file: SourceFile, cursor: { offset: number; line: number; state?: unknown }): SourceRead;
}
