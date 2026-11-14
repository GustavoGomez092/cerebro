import { existsSync } from "node:fs";
import type { FolderIdentity } from "./identity";
import { claudeCodeSource } from "./sources/claude-code";
import type { HistorySource } from "./sources/types";
import type { Store } from "./store";

export interface CaptureInput {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  source?: HistorySource;
}

export type CaptureStatus = "recorded" | "not_bound" | "declined" | "headless" | "missing";
export interface CaptureResult { status: CaptureStatus; events: number; skipped: number }

/** What capture keeps in the cursor's `state`, wrapping the adapter's own state. */
interface CaptureState {
  adapter?: unknown;
  /** Decided once, from the first read that yielded entries. */
  headless?: boolean;
  startedAt?: string;
  meta?: Record<string, unknown>;
}

function readState(raw: unknown): CaptureState {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CaptureState) : {};
}

const result = (status: CaptureStatus, events = 0, skipped = 0): CaptureResult => ({ status, events, skipped });

/** Copies new complete transcript lines of a bound, non-headless session into the local queue. No network. */
export function captureTranscript(
  store: Store,
  input: CaptureInput,
  ident: FolderIdentity,
  opts: { imported?: boolean; env?: Record<string, string | undefined> } = {},
): CaptureResult {
  const source = input.source ?? claudeCodeSource;
  const env = opts.env ?? process.env;
  const cursor = store.getCursor(input.transcriptPath);
  const prior = readState(cursor?.state);

  if (prior.headless || env.CEREBRO_HEADLESS === "1") return result("headless");

  const cached = store.cachedBinding(ident.repo, ident.subpath);
  const binding = cached?.binding;
  if (!binding) return result("not_bound");
  if (binding.status === "declined") return result("declined");
  if (!existsSync(input.transcriptPath)) return result("missing");

  const file = { source: source.id, path: input.transcriptPath, sessionId: input.sessionId, cwd: input.cwd, modifiedMs: Date.now() };
  const r = source.read(file, { offset: cursor?.offset ?? 0, line: cursor?.line ?? 0, state: prior.adapter });

  const next: CaptureState = { ...prior, adapter: r.state };
  if (next.startedAt === undefined && r.firstTimestamp) {
    next.headless = r.headless;
    next.startedAt = r.firstTimestamp;
  }
  const cursorRow = {
    source: source.id, sessionId: input.sessionId, offset: r.nextOffset, line: r.nextLine, bindingId: binding.id,
    cwd: input.cwd, repo: ident.repo, subpath: ident.subpath,
  };

  if (next.headless) {
    store.setCursor(input.transcriptPath, { ...cursorRow, state: next });
    store.markDone(input.transcriptPath);
    return result("headless", 0, r.skipped);
  }

  if (next.startedAt !== undefined) {
    // The first chunk's fields win, so later chunks (which lack e.g. gitBranch) never erase them.
    next.meta = { ...r.sessionMeta, ...next.meta, agent: source.id };
    store.upsertSession({
      id: input.sessionId,
      bindingId: binding.id,
      cwd: input.cwd,
      repo: ident.repo,
      subpath: ident.subpath,
      startedAt: next.startedAt,
      imported: opts.imported ?? false,
      meta: next.meta,
    });
  }
  store.enqueueEvents(r.events);
  store.setCursor(input.transcriptPath, { ...cursorRow, state: next });
  return result("recorded", r.events.length, r.skipped);
}

/** Re-runs capture for every open cursor so lines written after the last hook are still queued. */
export function sweepOpenCursors(store: Store): number {
  let queued = 0;
  for (const c of store.openCursors()) {
    if (c.source !== claudeCodeSource.id) continue;
    const ident: FolderIdentity = { repo: c.repo, subpath: c.subpath, root: c.cwd, isGit: false };
    const r = captureTranscript(store, { sessionId: c.sessionId, transcriptPath: c.transcriptPath, cwd: c.cwd }, ident);
    queued += r.events;
  }
  return queued;
}
