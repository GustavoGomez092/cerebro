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
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  // Use the working-tree script (it may not be committed yet) and commit it so the clone stays clean.
  mkdirSync(join(dir, "scripts"), { recursive: true });
  if (existsSync(RELEASE)) copyFileSync(RELEASE, join(dir, "scripts/release-plugin.sh"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "test setup", "--allow-empty");
  return dir;
}
const release = (cwd: string, ...args: string[]) => Bun.spawnSync(["sh", join(cwd, "scripts/release-plugin.sh"), ...args], { cwd });

test("release script: refuses a dirty tree", () => {
  const dir = clone();
  writeFileSync(join(dir, "dirty.txt"), "x");
  const r = release(dir, "9.9.9", "--dry-run");
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("dirty");
});

test("release script: refuses a missing version", () => {
  const r = release(ROOT, "--dry-run");
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("usage");
});

test("release script: refuses when tests fail", () => {
  const dir = clone();
  writeFileSync(join(dir, "client/test/zz-fail.test.ts"), `import {test,expect} from "bun:test"; test("x",()=>expect(1).toBe(2));`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "failing");
  // Only the failing test file matters; the script runs `bun test` in the clone (RELEASE_TEST_CMD narrows it).
  const r = Bun.spawnSync(["sh", join(dir, "scripts/release-plugin.sh"), "9.9.9", "--dry-run"], {
    cwd: dir,
    env: { ...process.env, RELEASE_TEST_CMD: "bun test client/test/zz-fail.test.ts" },
  });
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("tests failed");
}, 180_000);

test("release script --dry-run prints the steps and changes nothing", () => {
  const dir = clone();
  const r = Bun.spawnSync(["sh", join(dir, "scripts/release-plugin.sh"), "9.9.9", "--dry-run"], {
    cwd: dir,
    env: { ...process.env, RELEASE_TEST_CMD: "true" },
  });
  const out = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  for (const s of ["bun-darwin-arm64", "bun-darwin-x64", "plugin-dist", "plugin-v9.9.9", "git push"]) expect(out).toContain(s);
  expect(JSON.parse(readFileSync(join(dir, "plugin/.claude-plugin/plugin.json"), "utf8")).version).not.toBe("9.9.9");
  expect(git(dir, "status", "--porcelain").stdout.toString()).toBe("");
  expect(git(dir, "tag").stdout.toString()).toBe("");
});

test("marketplace.json points at the plugin-dist branch", () => {
  const m = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  expect(m.name).toBe("cerebro");
  expect(m.owner).toEqual({ name: "Cerebro" });
  expect(m.plugins[0].source).toEqual({ source: "github", repo: "GustavoGomez092/cerebro", ref: "plugin-dist" });
});
