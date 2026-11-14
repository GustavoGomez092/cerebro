import type { IngestEvent } from "@cerebro/shared";

export interface SourceFile {
  source: string;
  path: string;
  sessionId: string;
  cwd: string | null;
  modifiedMs: number;
  /** Git remote recorded by the agent itself; used as the folder identity when present. */
  repo?: string | null;
  /** Cursor offset at which everything currently in the file has been read (bytes, or records for Gemini). */
  endOffset?: number;
}

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
  /** `folders`: project folders known to Cerebro (Gemini names its logs by a hash of the folder path). */
  discover(roots?: { home?: string; folders?: string[] }): Promise<SourceFile[]>;
  read(file: SourceFile, cursor: { offset: number; line: number; state?: unknown }): SourceRead;
}
