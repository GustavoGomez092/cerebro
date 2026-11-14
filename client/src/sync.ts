import { statSync } from "node:fs";
import { homedir } from "node:os";
import { normalizeRemote } from "@cerebro/shared";
import { ApiError, type ApiClient } from "./api";
import { captureTranscript } from "./capture";
import { flush } from "./flush";
import { folderIdentity, type FolderIdentity } from "./identity";
import { logError, logInfo } from "./log";
import { allSources } from "./sources";
import { genericSource, moveToDone } from "./sources/generic";
import type { HistorySource, SourceFile } from "./sources/types";
import type { Store } from "./store";

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

/** True when /health answers as the pinned instance, so the token may be sent. */
async function instanceVerified(store: Store, api: ApiClient): Promise<boolean> {
  if (store.get("blocked")) return false;
  try {
    const h = await api.health({ timeoutMs: HEALTH_TIMEOUT_MS });
    if (!h.ok || !h.instanceId) return false;
    const pinned = store.get("instanceId");
    if (pinned === undefined) store.set("instanceId", h.instanceId);
    return pinned === undefined || pinned === h.instanceId;
  } catch {
    return false;
  }
}

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
    let online = api ? await instanceVerified(store, api) : false;
    let resolves = 0;
    const refreshed = new Set<string>();
    // Many sessions share a folder; work out each folder's identity (three git calls) once per run.
    const identities = new Map<string, FolderIdentity>();
    const identityOf = (cwd: string, repo: string | null): FolderIdentity => {
      const key = JSON.stringify([cwd, repo]);
      let ident = identities.get(key);
      if (!ident) identities.set(key, (ident = fileIdentity(cwd, repo, machine)));
      return ident;
    };

    /** Asks the server once per run about a folder not known to be bound or declined (opting in happens elsewhere). */
    const refresh = async (ident: FolderIdentity): Promise<void> => {
      const key = `${ident.repo}|${ident.subpath}`;
      if (!api || !online || refreshed.has(key) || resolves >= MAX_RESOLVES) return;
      refreshed.add(key);
      if (store.cachedBinding(ident.repo, ident.subpath)?.binding) return;
      resolves++;
      try {
        const { binding } = await api.resolve(ident.repo, ident.subpath, { timeoutMs: RESOLVE_TIMEOUT_MS });
        store.cacheBinding(ident.repo, ident.subpath, binding);
      } catch (e) {
        logError(`sync resolve ${ident.repo}`, e);
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) online = false;
      }
    };

    // Gemini names its logs by a hash of the project folder, so it is told every folder known to be bound.
    const folders = new Set(store.boundFolders());

    for (const source of opts.sources ?? allSources()) {
      if (source.live) continue;
      const stats = (out.bySource[source.id] ??= { files: 0, events: 0, skipped: 0 });
      let files: SourceFile[] = [];
      try { files = await source.discover({ home, folders: [...folders] }); } catch (e) { logError(`sync discover ${source.id}`, e); continue; }

      for (const file of files) {
        try {
          let cursor = store.getCursor(file.path);
          if (cursor?.done && source === genericSource) {
            // Finished inbox files are moved out, so one here again is a new drop under the same name.
            store.setCursor(file.path, { ...cursor, offset: 0, line: 0, state: null });
            cursor = store.getCursor(file.path);
          }
          if (cursor && file.endOffset !== undefined && cursor.offset >= file.endOffset) {
            if (!cursor.done) finish(store, source, file); // nothing new: close it once it has gone quiet
            continue;
          }

          const cwd = file.cwd ?? source.read(file, { offset: 0, line: 0 }).cwd;
          if (!cwd) { stats.skipped++; continue; }
          // A session keeps the identity it was first recorded under.
          const ident: FolderIdentity = cursor
            ? { repo: cursor.repo, subpath: cursor.subpath, root: cursor.cwd, isGit: false }
            : identityOf(cwd, file.repo ?? null);
          // A path identity names the machine; without its name we cannot tell which folder this is.
          if (!machine && ident.repo.startsWith("path:")) { stats.skipped++; continue; }
          await refresh(ident);

          const r = captureTranscript(
            store,
            { sessionId: file.sessionId, transcriptPath: file.path, cwd: cursor?.cwd ?? cwd, source },
            ident,
            { imported: true },
          );
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
    }

    store.set("lastSyncAt", new Date().toISOString());
    const f = api ? await flush(store, api) : null;
    logInfo("sync finished", { ...out, flush: f?.outcome ?? "unconfigured" });
    return out;
  } finally {
    store.unlock("sync");
  }
}

/** Closes the cursor of a file that is fully read and no longer being written. */
function finish(store: Store, source: HistorySource, file: SourceFile): void {
  if (source === genericSource) {
    const cursor = store.getCursor(file.path);
    if (cursor && cursor.offset >= statSync(file.path).size) {
      moveToDone(file.path);
      store.markDone(file.path);
    }
    return;
  }
  // Still open files keep being swept by every flush; a done one is reopened by sync when it grows.
  if (Date.now() - file.modifiedMs > LIVE_WINDOW_MS) store.markDone(file.path);
}
