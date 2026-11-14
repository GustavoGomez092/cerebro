import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RELEASE = join(ROOT, "scripts/release-plugin.sh");
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const target = process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64";
let bin = "";

beforeAll(() => {
  bin = join(tmp("cerebro-build-"), "cerebro");
  const r = Bun.spawnSync(["bun", "build", join(ROOT, "client/src/cli.ts"), "--compile", "--minify", `--target=${target}`, "--outfile", bin], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(`compile failed: ${r.stderr}`);
}, 120_000);

function run(args: string[], stdin = "") {
  const home = tmp("cerebro-home-");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CEREBRO_")) env[k] = v;
  return Bun.spawnSync([bin, ...args], { stdin: Buffer.from(stdin), env: { ...env, HOME: home, CEREBRO_HOME: join(home, ".cerebro"), CEREBRO_NO_SPAWN: "1" } });
}

test("compiled binary: hook Stop with empty stdin exits 0 and prints nothing", () => {
  const r = run(["hook", "Stop"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toBe("");
});

test("compiled binary: status without config exits 0 and says not configured", () => {
  const r = run(["status"]);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("not configured");
});

const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);

/** A clone of the repo's HEAD in a temp dir, so the release script never touches the real repo. */
function clone(): string {
  const dir = join(tmp("cerebro-rel-"), "repo");
  Bun.spawnSync(["git", "clone", "-q", ROOT, dir]);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  for (const p of ["node_modules", "client/node_modules", "server/node_modules"]) {
    if (existsSync(join(ROOT, p))) symlinkSync(join(ROOT, p), join(dir, p));
  }
  // Use the working-tree script (it may not be committed yet) and commit it so the clone stays clean.
  mkdirSync(join(dir, "scripts"), { recursive: true });
  if (existsSync(RELEASE)) copyFileSync(RELEASE, join(dir, "scripts/release-plugin.sh"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "test setup", "--allow-empty");
  return dir;
}
/** An empty bare repo to stand in for GitHub. */
function bare(): string {
  const dir = join(tmp("cerebro-remote-"), "origin.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", dir]);
  return dir;
}
const release = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(["sh", join(cwd, "scripts/release-plugin.sh"), ...args], { cwd, env: { ...process.env, RELEASE_TEST_CMD: "true", ...env } });
const err = (r: { stderr: Buffer }) => r.stderr.toString();

test("release script: refuses a missing version", () => {
  const r = release(ROOT, ["--dry-run"]);
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("usage");
});

test("release script: refuses a malformed version", () => {
  const r = release(clone(), ["v1", "--dry-run", "--remote", bare()]);
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("invalid version");
});

test("release script: refuses an origin that is not the cerebro GitHub repo, unless --remote is given", () => {
  const dir = clone(); // its origin is a local path
  const r = release(dir, ["9.9.9", "--dry-run"]);
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("not GitHub GustavoGomez092/cerebro");
  expect(release(dir, ["9.9.9", "--dry-run", "--remote", bare()]).exitCode).toBe(0);
});

test("release script: accepts the https and ssh forms of the real origin (dry run, guard only)", () => {
  for (const url of ["https://github.com/GustavoGomez092/cerebro.git", "git@github.com:GustavoGomez092/cerebro.git", "ssh://git@github.com/GustavoGomez092/cerebro"]) {
    const dir = clone();
    git(dir, "remote", "set-url", "origin", url);
    // The remote is unreachable from here (private repo); getting past the origin guard is the point.
    expect(err(release(dir, ["9.9.9", "--dry-run"]))).not.toContain("not GitHub");
  }
});

test("release script: refuses without an origin", () => {
  const dir = clone();
  git(dir, "remote", "remove", "origin");
  const r = release(dir, ["9.9.9", "--dry-run"]);
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("no origin");
});

test("release script: refuses a dirty tree", () => {
  const dir = clone();
  writeFileSync(join(dir, "dirty.txt"), "x");
  const r = release(dir, ["9.9.9", "--dry-run", "--remote", bare()]);
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("dirty");
});

test("release script: refuses when tests fail", () => {
  const dir = clone();
  const r = release(dir, ["9.9.9", "--dry-run", "--remote", bare()], { RELEASE_TEST_CMD: "false" });
  expect(r.exitCode).not.toBe(0);
  expect(err(r)).toContain("tests failed");
});

test("release script: refuses an existing tag, locally or on the remote", () => {
  const dir = clone();
  git(dir, "tag", "plugin-v9.9.9");
  const local = release(dir, ["9.9.9", "--dry-run", "--remote", bare()]);
  expect(local.exitCode).not.toBe(0);
  expect(err(local)).toContain("already exists locally");

  const remote = bare();
  git(dir, "push", "-q", remote, "plugin-v9.9.9");
  git(dir, "tag", "-d", "plugin-v9.9.9");
  const onRemote = release(dir, ["9.9.9", "--dry-run", "--remote", remote]);
  expect(onRemote.exitCode).not.toBe(0);
  expect(err(onRemote)).toContain("already exists on");
});

test("release script --dry-run prints the steps and changes nothing", () => {
  const dir = clone();
  const remote = bare();
  const r = release(dir, ["9.9.9", "--dry-run", "--remote", remote]);
  const out = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  for (const s of ["bun-darwin-arm64", "bun-darwin-x64", "plugin-dist", "plugin-v9.9.9", "git push --atomic"]) expect(out).toContain(s);
  expect(JSON.parse(readFileSync(join(dir, "plugin/.claude-plugin/plugin.json"), "utf8")).version).not.toBe("9.9.9");
  expect(git(dir, "status", "--porcelain").stdout.toString()).toBe("");
  expect(git(dir, "tag").stdout.toString()).toBe("");
  expect(git(remote, "branch").stdout.toString()).toBe("");
});

test("release script: a real run to a bare remote publishes branch and tag, without junk", () => {
  const dir = clone();
  const remote = bare();
  writeFileSync(join(dir, "plugin/.DS_Store"), "junk");
  const r = release(dir, ["9.9.9", "--remote", remote]);
  expect(err(r)).not.toContain("refusing");
  expect(r.exitCode).toBe(0);
  expect(git(remote, "rev-parse", "--verify", "-q", "refs/tags/plugin-v9.9.9").exitCode).toBe(0);
  expect(git(remote, "rev-list", "--count", "plugin-dist").stdout.toString().trim()).toBe("1");
  const files = git(remote, "ls-tree", "-r", "--name-only", "plugin-dist").stdout.toString().split("\n").filter(Boolean);
  expect(files).toContain("bin/cerebro-darwin-arm64");
  expect(files).toContain("bin/cerebro-darwin-x64");
  expect(files.some((f) => f.includes(".DS_Store"))).toBe(false);
  expect(JSON.parse(git(remote, "show", "plugin-dist:.claude-plugin/plugin.json").stdout.toString()).version).toBe("9.9.9");
  // Releasing the same version again is refused rather than half-published.
  expect(release(dir, ["9.9.9", "--remote", remote]).exitCode).not.toBe(0);
}, 180_000);

test("marketplace.json points at the plugin-dist branch", () => {
  const m = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  expect(m.name).toBe("cerebro");
  expect(m.owner).toEqual({ name: "Cerebro" });
  expect(m.plugins[0].source).toEqual({ source: "github", repo: "GustavoGomez092/cerebro", ref: "plugin-dist" });
});
