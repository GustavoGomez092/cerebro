import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { normalizeRemote } from "@cerebro/shared";
import { ApiError, type ApiClient } from "./api";
import { captureTranscript } from "./capture";
import { flush } from "./flush";
import { folderIdentity, type FolderIdentity } from "./identity";
import { checkInstance } from "./instance";
import { logError, logInfo } from "./log";
import { allSources } from "./sources";
import { genericSource, moveToDone } from "./sources/generic";
import type { HistorySource, SourceFile } from "./sources/types";
import type { Cursor, Store } from "./store";

export interface SourceStats {
  /** Files that queued new events this run. */
  files: number;
  events: number;
  /** Files left alone: no working directory, unbound, declined or headless. */
  skipped: number;
}
export interface SyncResult { bySource: Record<string, SourceStats> }

const LOCK_TTL_MS = 30 * 60_000;
const HEALTH_TIMEOUT_MS = 1500;
const RESOLVE_TIMEOUT_MS = 1500;
const MAX_RESOLVES = 50;
/** A file touched this recently may still be written to, so its cursor stays open for sweeps. */
const LIVE_WINDOW_MS = 10 * 60_000;

/**
 * The folder identity for an agent's session: the folder's own identity, unless the agent recorded a git
 * remote that differs from it (the folder was moved, deleted or is not a clone), in which case that remote wins.
 */
export function fileIdentity(cwd: string, repo: string | null, machine: string): FolderIdentity {
  const ident = folderIdentity(cwd, machine);
  const remote = repo ? normalizeRemote(repo) : "";
  if (!remote || remote === ident.repo) return ident;
  return { repo: remote, subpath: "", root: cwd, isGit: true };
}

/** Size and mtime of a file when its cursor was closed fully read, kept in the cursor state. */
interface Finished { size: number; mtimeMs: number }
const finishedOf = (state: unknown): Finished | null => {
  const f = state && typeof state === "object" ? (state as { finished?: Finished }).finished : undefined;
  return f && typeof f.size === "number" && typeof f.mtimeMs === "number" ? f : null;
};

interface Work { source: HistorySource; file: SourceFile; cwd: string; ident: FolderIdentity }

/**
 * Copies new history of every non-live agent (subagents, Codex, Gemini, inbox files) into the local queue
 * for folders that opted in, then uploads. Files of unbound or declined folders are left unread, so opting in
 * later picks up their whole history.
 */
export async function syncAllSources(
  store: Store,
  api: ApiClient | null,
  machine: string,
  opts: { home?: string; sources?: HistorySource[] } = {},
): Promise<SyncResult> {
  const out: SyncResult = { bySource: {} };
  if (!store.tryLock("sync", LOCK_TTL_MS)) return out;
  try {
    const home = opts.home ?? homedir();
    const sources = (opts.sources ?? allSources()).filter((s) => !s.live);
    for (const s of sources) out.bySource[s.id] = { files: 0, events: 0, skipped: 0 };

    let online = false;
    if (api && !store.get("blocked")) {
      try { online = (await checkInstance(store, api, { timeoutMs: HEALTH_TIMEOUT_MS })) === "ok"; } catch (e) { logError("sync health", e); }
    }

    // Many sessions share a folder; work out each folder's identity (three git calls) once per run.
    const identities = new Map<string, FolderIdentity>();
    const identityOf = (cwd: string, repo: string | null): FolderIdentity => {
      const key = JSON.stringify([cwd, repo]);
      let ident = identities.get(key);
      if (!ident) identities.set(key, (ident = fileIdentity(cwd, repo, machine)));
      return ident;
    };

    /** What is to be done with one discovered file: nothing (null), skip it, or capture it. */
    const plan = (source: HistorySource, file: SourceFile): Work | "skip" | null => {
      let cursor = store.getCursor(file.path);
      if (cursor?.done && source === genericSource) {
        // Finished inbox files are moved out, so one here again is a new drop under the same name:
        // judge it afresh (its own session, folder and binding), never by the old file's cursor.
        store.deleteCursor(file.path);
        cursor = undefined;
      }
      if (cursor && file.endOffset !== undefined && cursor.offset >= file.endOffset) {
        finish(store, source, file); // nothing new: close it once it has gone quiet
        return null;
      }
      const cwd = file.cwd ?? source.read(file, { offset: 0, line: 0 }).cwd;
      if (!cwd) return "skip";
      // A session keeps the identity it was first recorded under.
      const ident: FolderIdentity = cursor
        ? { repo: cursor.repo, subpath: cursor.subpath, root: cursor.cwd, isGit: false }
        : identityOf(cwd, file.repo ?? null);
      // A path identity names the machine; without its name we cannot tell which folder this is.
      if (!machine && ident.repo.startsWith("path:")) return "skip";
      return { source, file, cwd: cursor?.cwd ?? cwd, ident };
    };

    // Gemini names its logs by a hash of the project folder, so it is told every folder known to be bound.
    // A folder bound for the first time in this run is known only after capture, hence a second round.
    const folders = new Set(store.boundFolders());
    const seen = new Set<string>();
    let resolvesLeft = MAX_RESOLVES;
    const unchanged = (path: string, size: number, mtimeMs: number): boolean => {
      const c = store.getCursor(path);
      const f = c?.done ? finishedOf(c.state) : null;
      return !!f && f.size === size && f.mtimeMs === mtimeMs;
    };

    for (let round = 0; round < 2; round++) {
      const known = folders.size;
      const work: Work[] = [];
      for (const source of sources) {
        const stats = out.bySource[source.id]!;
        let files: SourceFile[] = [];
        try { files = await source.discover({ home, folders: [...folders], unchanged }); } catch (e) { logError(`sync discover ${source.id}`, e); continue; }
        for (const file of files) {
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          try {
            const w = plan(source, file);
            if (w === "skip") stats.skipped++;
            else if (w) work.push(w);
          } catch (e) {
            logError(`sync ${file.path}`, e);
          }
        }
      }

      if (api && online && resolvesLeft > 0) {
        const r = await refreshBindings(store, api, work.map((w) => w.ident), resolvesLeft);
        resolvesLeft -= r.asked;
        if (!r.reachable) online = false;
      }

      for (const { source, file, cwd, ident } of work) {
        const stats = out.bySource[source.id]!;
        try {
          const r = captureTranscript(store, { sessionId: file.sessionId, transcriptPath: file.path, cwd, source }, ident, { imported: true });
          if (r.status !== "recorded") { stats.skipped++; continue; }
          folders.add(cwd);
          if (r.events > 0) {
            stats.files++;
            stats.events += r.events;
          }
          finish(store, source, file);
        } catch (e) {
          logError(`sync ${file.path}`, e);
        }
      }
      if (folders.size === known) break;
    }

    store.set("lastSyncAt", new Date().toISOString());
    const f = api ? await flush(store, api) : null;
    logInfo("sync finished", { ...out, flush: f?.outcome ?? "unconfigured" });
    return out;
  } finally {
    store.unlock("sync");
  }
}

/**
 * Asks the server about folders not known to be bound or declined (opting in happens elsewhere), at most
 * `limit` of them, those checked longest ago first, so over several runs every folder gets its turn.
 */
async function refreshBindings(
  store: Store, api: ApiClient, idents: FolderIdentity[], limit: number,
): Promise<{ asked: number; reachable: boolean }> {
  const due = new Map<string, { ident: FolderIdentity; at: string }>();
  for (const ident of idents) {
    const key = `${ident.repo}|${ident.subpath}`;
    if (due.has(key)) continue;
    const cached = store.cachedBinding(ident.repo, ident.subpath);
    if (cached?.binding) continue;
    due.set(key, { ident, at: cached?.at ?? "" }); // never asked sorts first
  }
  const order = [...due.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, limit);
  let asked = 0;
  for (const { ident } of order) {
    asked++;
    try {
      const { binding } = await api.resolve(ident.repo, ident.subpath, { timeoutMs: RESOLVE_TIMEOUT_MS });
      store.cacheBinding(ident.repo, ident.subpath, binding);
    } catch (e) {
      logError(`sync resolve ${ident.repo}`, e);
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) return { asked, reachable: false };
      // Refused (4xx): note it as not bound as of now, so never-asked folders go ahead of it next run.
      // Only identities with no binding reach here, so nothing bound or declined is overwritten.
      store.cacheBinding(ident.repo, ident.subpath, null);
    }
  }
  return { asked, reachable: true };
}

/** Closes the cursor of a file that is fully read and no longer being written. */
function finish(store: Store, source: HistorySource, file: SourceFile): void {
  const cursor = store.getCursor(file.path);
  if (!cursor) return;
  if (source === genericSource) {
    const onDisk = existsSync(file.path) ? statSync(file.path).size : -1;
    if (cursor.offset >= onDisk) {
      moveToDone(file.path);
      store.markDone(file.path);
    }
    return;
  }
  // Still open files keep being swept by every flush; a closed one is reopened by sync when it changes.
  if (Date.now() - file.modifiedMs <= LIVE_WINDOW_MS) return;
  const fullyRead = file.endOffset !== undefined && cursor.offset >= file.endOffset;
  if (fullyRead && file.size !== undefined) rememberFinished(store, cursor, { size: file.size, mtimeMs: file.modifiedMs });
  store.markDone(file.path);
}

/** Records the file's size and mtime as seen when it was read to the end, so discover can skip it unread. */
function rememberFinished(store: Store, cursor: Cursor, finished: Finished): void {
  const prev = finishedOf(cursor.state);
  if (cursor.done && prev?.size === finished.size && prev.mtimeMs === finished.mtimeMs) return;
  const state = cursor.state && typeof cursor.state === "object" ? cursor.state : {};
  store.setCursor(cursor.transcriptPath, { ...cursor, state: { ...state, finished } });
}
