import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderIdentity } from "../src/identity";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "cerebro-id-")));
}
function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
function repo(remotes: Record<string, string> = {}): string {
  const root = tmp();
  git(root, "init", "-q");
  for (const [name, url] of Object.entries(remotes)) git(root, "remote", "add", name, url);
  return root;
}

test("git repo with origin: normalised remote and repo-relative subpath", () => {
  const root = repo({ origin: "git@github.com:Acme/App.git" });
  mkdirSync(join(root, "apps/web"), { recursive: true });
  const id = folderIdentity(join(root, "apps/web"), "mac-a");
  expect(id).toEqual({ repo: "github.com/acme/app", subpath: "apps/web", root, isGit: true });
  expect(folderIdentity(root, "mac-a").subpath).toBe("");
});

test("subpath comes from the real path, not a differently-cased or symlinked cwd", () => {
  const root = repo({ origin: "https://github.com/Acme/App.git" });
  mkdirSync(join(root, "apps/web"), { recursive: true });
  const x = tmp();
  symlinkSync(join(root, "apps"), join(x, "link"));
  const id = folderIdentity(join(x, "link/web"), "m");
  expect(id.repo).toBe("github.com/acme/app");
  expect(id.subpath).toBe("apps/web");
});

test("no origin falls back to the first remote; no remote falls back to a path identity", () => {
  const up = repo({ upstream: "git@github.com:Acme/Other.git" });
  expect(folderIdentity(up, "m").repo).toBe("github.com/acme/other");
  const bare = repo();
  const id = folderIdentity(bare, "m");
  expect(id).toEqual({ repo: `path:m:${bare}`, subpath: "", root: bare, isGit: true });
});

test("non-git folder is a machine-specific path identity", () => {
  const dir = tmp();
  const id = folderIdentity(dir, "mac-a");
  expect(id.repo).toBe(`path:mac-a:${realpathSync(dir)}`);
  expect(id.subpath).toBe("");
  expect(id.isGit).toBe(false);
});

test("a missing cwd never throws", () => {
  expect(folderIdentity("/nope/x", "m").repo).toBe("path:m:/nope/x");
});
