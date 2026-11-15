import { test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const sh = (...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

// Skipped when Docker is unavailable.
const dockerUp = sh("docker", "info").code === 0;
const run = dockerUp ? test : test.skip;
const suffix = crypto.randomUUID().slice(0, 8);
const IMAGE = `cerebro-server:imgtest-${suffix}`;
const NET = `cerebro-imgtest-${suffix}`;
const DB = `${NET}-db`;
const APP = `${NET}-app`;
const PINNED_CLAUDE = "2.1.311"; // npm "stable" tag; released 2026-10-26, at least 2 weeks before it was pinned

beforeAll(() => {
  if (!dockerUp) return;
  const b = sh("docker", "build", "-f", "server/Dockerfile", "-t", IMAGE, ".");
  if (b.code !== 0) throw new Error(`docker build failed:\n${b.err.slice(-2000)}`);
}, 600_000);

afterAll(() => {
  if (!dockerUp) return;
  sh("docker", "rm", "-f", APP, DB);
  sh("docker", "network", "rm", NET);
  sh("docker", "rmi", IMAGE);
});

run("image runs the pinned Claude Code CLI", () => {
  const r = sh("docker", "run", "--rm", IMAGE, "claude", "--version");
  expect(r.code).toBe(0);
  expect(r.out).toContain(PINNED_CLAUDE);
});

run("image runs as uid 10010 with the documented environment", () => {
  expect(sh("docker", "run", "--rm", IMAGE, "id", "-u").out).toBe("10010");
  expect(sh("docker", "run", "--rm", IMAGE, "sh", "-c", "echo $CLAUDE_CONFIG_DIR $SUMMARISER_CMD").out).toBe("/data/claude claude");
  // The CLI is pinned: it must never update itself inside the container.
  expect(sh("docker", "run", "--rm", IMAGE, "sh", "-c", "echo $DISABLE_AUTOUPDATER").out).toBe("1");
  expect(sh("docker", "run", "--rm", IMAGE, "sh", "-c", "touch /data/claude/w && echo ok").out).toBe("ok");
  const hc = JSON.parse(sh("docker", "inspect", IMAGE, "--format", "{{json .Config.Healthcheck}}").out);
  expect(hc.Interval).toBe(30_000_000_000);
  expect(hc.Test.join(" ")).toContain("127.0.0.1:8790/health");
});

run("migrate command and the healthcheck pass against a database", async () => {
  expect(sh("docker", "network", "create", NET).code).toBe(0);
  expect(sh("docker", "run", "-d", "--name", DB, "--network", NET, "-e", "POSTGRES_USER=cerebro", "-e", "POSTGRES_PASSWORD=cerebro",
    "-e", "POSTGRES_DB=cerebro", "pgvector/pgvector:0.8.6-pg17").code).toBe(0);
  for (let i = 0; i < 60 && sh("docker", "exec", DB, "pg_isready", "-U", "cerebro").code !== 0; i++) await Bun.sleep(1000);
  const env = ["-e", `DATABASE_URL=postgres://cerebro:cerebro@${DB}:5432/cerebro`, "-e", "EMBED_URL=http://127.0.0.1:1"];

  const m = sh("docker", "run", "--rm", "--network", NET, ...env, IMAGE, "bun", "server/src/cli.ts", "migrate");
  expect(m.err).toBe("");
  expect(m.code).toBe(0);

  expect(sh("docker", "run", "-d", "--name", APP, "--network", NET, ...env, "--health-interval", "2s", "--health-start-period", "1s", IMAGE).code).toBe(0);
  let status = "";
  for (let i = 0; i < 40; i++) {
    status = sh("docker", "inspect", APP, "--format", "{{.State.Health.Status}}").out;
    if (status === "healthy") break;
    await Bun.sleep(1000);
  }
  expect(status).toBe("healthy");
}, 180_000);

run("build context excludes worktrees, secrets, keys and env files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cerebro-ctx-"));
  try {
    copyFileSync(join(ROOT, ".dockerignore"), join(dir, ".dockerignore"));
    const plant = (rel: string) => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), "x"); };
    for (const f of [".claude/worktrees/x/.env", "server/.claude/y", ".worktrees/w/a", "worktrees/w/a", "secrets/x", "deploy/secrets/x", "tls/server.pem", "tls/server.key", "server/.env.prod", "keep/ok.txt"]) plant(f);
    writeFileSync(join(dir, "Dockerfile"), "FROM oven/bun:1.4.4-slim\nCOPY . /ctx\nRUN find /ctx -type f | sort\n");
    const b = sh("docker", "build", "--no-cache", "--progress=plain", dir);
    expect(b.code).toBe(0);
    const listing = b.out + "\n" + b.err;
    expect(listing).toContain("/ctx/keep/ok.txt");
    for (const bad of ["/.claude/", "/.worktrees/", "/worktrees/", "server.pem", "server.key"]) expect(listing).not.toContain(bad);
    expect(listing).not.toMatch(/\/ctx\/\S*\.env/);
    expect(listing).not.toMatch(/\/ctx\/\S*secrets\//);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
