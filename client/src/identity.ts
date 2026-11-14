import { realpathSync } from "node:fs";
import { normalizeRemote, pathIdentity } from "@cerebro/shared";

export interface FolderIdentity {
  repo: string;
  subpath: string;
  root: string;
  isGit: boolean;
}

/** The environment without GIT_* variables (GIT_DIR, GIT_WORK_TREE...), which would point git at another repo. */
function gitEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

/** Runs one git command in `cwd`; returns trimmed stdout, or null on any failure or timeout. */
function git(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1000,
      env: gitEnv(),
    });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim();
  } catch {
    return null;
  }
}

/** Maps a working directory to the folder identity the server uses for bindings. Never throws. */
export function folderIdentity(cwd: string, machine: string): FolderIdentity {
  try {
    let real: string;
    try {
      real = realpathSync(cwd);
    } catch {
      return { repo: pathIdentity(machine, cwd), subpath: "", root: cwd, isGit: false };
    }
    const top = git(real, ["rev-parse", "--show-toplevel"]);
    if (!top) return { repo: pathIdentity(machine, real), subpath: "", root: real, isGit: false };
    let root = top;
    try {
      root = realpathSync(top);
    } catch {}
    const subpath = (git(real, ["rev-parse", "--show-prefix"]) ?? "").replace(/\/+$/, "");
    const remote =
      git(real, ["remote", "get-url", "origin"]) ||
      (() => {
        const first = git(real, ["remote"])?.split("\n")[0]?.trim();
        return first ? git(real, ["remote", "get-url", first]) : null;
      })();
    if (!remote) return { repo: pathIdentity(machine, root), subpath: "", root, isGit: true };
    return { repo: normalizeRemote(remote), subpath, root, isGit: true };
  } catch {
    return { repo: pathIdentity(machine, cwd), subpath: "", root: cwd, isGit: false };
  }
}
