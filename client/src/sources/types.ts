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
  /** Size in bytes of the file on disk when discovered (for Gemini: the shared logs.json). */
  size?: number;
}

export interface DiscoverRoots {
  home?: string;
  /** Project folders known to Cerebro (Gemini names its logs by a hash of the folder path). */
  folders?: string[];
  /** True when `path` was finished at exactly this size and mtime, so discover can leave it out unread. */
  unchanged?: (path: string, size: number, mtimeMs: number) => boolean;
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
  discover(roots?: DiscoverRoots): Promise<SourceFile[]>;
  read(file: SourceFile, cursor: { offset: number; line: number; state?: unknown }): SourceRead;
}
