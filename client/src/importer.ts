import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ApiClient } from "./api";
import { captureTranscript } from "./capture";
import { flush } from "./flush";
import { folderIdentity, type FolderIdentity } from "./identity";
import { logError, logInfo } from "./log";
import { allSources } from "./sources";
import type { HistorySource, SourceFile } from "./sources/types";
import type { Store } from "./store";

export interface ImportResult {
  sessions: number;
  events: number;
  /** Files not imported: headless, declined or unbound. */
  skipped: number;
  /** Sessions imported, per source id. */
  bySource: Record<string, number>;
}

const LOCK_TTL_MS = 60 * 60 * 1000;
/** A transcript touched this recently may still be live, so its cursor stays open. */
const LIVE_WINDOW_MS = 10 * 60 * 1000;

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** The path of `dir` relative to `root`, or null when it is outside it. */
function within(root: string, dir: string): string | null {
  const rel = relative(root, dir);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/** Imports the past conversations of one folder (and its subfolders) from every registered source. */
export async function importFolder(
  store: Store,
  api: ApiClient,
  cwd: string,
  machine: string,
  opts: { home?: string; sources?: HistorySource[] } = {},
): Promise<ImportResult> {
  const out: ImportResult = { sessions: 0, events: 0, skipped: 0, bySource: {} };
  const ident = folderIdentity(cwd, machine);
  const lockName = `import:${ident.repo}|${ident.subpath}`;
  if (!store.tryLock(lockName, LOCK_TTL_MS)) return out;

  try {
    const root = real(ident.root);
    const home = opts.home ?? homedir();
    const subfolders = new Map<string, Promise<FolderIdentity | null>>();

    /** The folder identity (with its binding cached) for a subpath, resolved once per subpath. */
    const identityFor = (subpath: string): Promise<FolderIdentity | null> => {
      let p = subfolders.get(subpath);
      if (!p) {
        p = api.resolve(ident.repo, subpath).then(
          (r) => { store.cacheBinding(ident.repo, subpath, r.binding); return { ...ident, subpath }; },
          (e) => { logError(`import resolve ${subpath}`, e); return null; },
        );
        subfolders.set(subpath, p);
      }
      return p;
    };

    for (const source of opts.sources ?? allSources()) {
      let files: SourceFile[] = [];
      try { files = await source.discover({ home }); } catch (e) { logError(`import discover ${source.id}`, e); continue; }

      for (const file of files) {
        try {
          if (store.getCursor(file.path)?.done) continue;
          const fileCwd = file.cwd ?? source.read(file, { offset: 0, line: 0 }).cwd;
          if (!fileCwd) continue;
          const rel = within(root, real(fileCwd));
          if (rel === null) continue;

          const entryIdent = await identityFor(ident.isGit ? rel : "");
          if (!entryIdent) continue;

          const r = captureTranscript(
            store,
            { sessionId: file.sessionId, transcriptPath: file.path, cwd: fileCwd, source },
            entryIdent,
            { imported: true },
          );
          if (r.status === "not_bound" || r.status === "declined" || r.status === "headless") { out.skipped++; continue; }
          if (r.status !== "recorded") continue;
          if (r.events > 0) {
            out.sessions++;
            out.events += r.events;
            out.bySource[source.id] = (out.bySource[source.id] ?? 0) + 1;
          }
          if (Date.now() - file.modifiedMs > LIVE_WINDOW_MS) store.markDone(file.path);
        } catch (e) {
          logError(`import ${file.path}`, e);
        }
      }
    }

    store.set(`imported:${ident.repo}|${ident.subpath}`, new Date().toISOString());
    const f = await flush(store, api);
    logInfo("import finished", { ...out, flush: f.outcome });
    return out;
  } finally {
    store.unlock(lockName);
  }
}
