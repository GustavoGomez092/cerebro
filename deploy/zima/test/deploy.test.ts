// deploy.sh and check.sh against fakes: `ssh` runs the remote command locally with /DATA and
// /var/lib/casaos mapped into a temp root; docker, casaos-cli, systemctl, curl, sudo, chown, bun and
// sleep are shims that record their calls. Nothing here contacts the real server.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadConfig } from "../../../server/src/config";
import { newSummariserState } from "../../../server/src/summarise/loop";
import { authedApp } from "../../../server/test/helpers";
import { createEmbedRouter, PRIMARY_DOWN_MS } from "../../../server/src/embed/failover";
import { fakeOllama } from "../../../server/test/fakes/ollama";
import { boundFolder, ingest, sess } from "../../../server/test/fixtures";

const DEPLOY = join(import.meta.dir, "..", "..");

const FAKES = join(import.meta.dir, "fakes");

const MANIFEST = '{"schemaVersion":2,"layers":[{"digest":"sha256:feed"}]}';
const MANIFEST_DIGEST = new Bun.CryptoHasher("sha256").update(MANIFEST).digest("hex");
const APP = "DATA/AppData/cerebro";
const CHECK_TOKEN = "cbr_FAKE-check-token-xyz";

type Run = { code: number; out: string; err: string };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(envFile = `BGE_M3_DIGEST=${MANIFEST_DIGEST}\nOLLAMA_CPUS=4\n`) {
  const tmp = mkdtempSync(join(tmpdir(), "cerebro-zima-"));
  dirs.push(tmp);
  const bin = join(tmp, "bin"), root = join(tmp, "root"), state = join(tmp, "state"), repo = join(tmp, "repo"), log = join(tmp, "calls.log");
  for (const d of [bin, root, state, repo]) mkdirSync(d, { recursive: true });
  writeFileSync(log, "");
  cpSync(FAKES, bin, { recursive: true });
  cpSync(DEPLOY, join(repo, "deploy"), { recursive: true, filter: (src) => !relative(DEPLOY, src).split("/").includes("test") });
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "deploy/.env"), envFile);
  mkdirSync(join(repo, "server/migrations"), { recursive: true });
  writeFileSync(join(repo, "server/migrations/001_init.sql"), "create table t(x int);\n");

  const baseEnv = {
    PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? tmp, TMPDIR: tmpdir(),
    FAKE_ROOT: root, FAKE_STATE: state, FAKE_LOG: log, FAKE_MANIFEST: MANIFEST, FAKE_CHECK_TOKEN: CHECK_TOKEN,
    CEREBRO_HEALTH_TIMEOUT: "1",
  };
  const git = (...a: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: baseEnv });
    if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");

  return {
    root, repo, state, log,
    app: (p = "") => join(root, APP, p),
    git,
    sha: () => git("rev-parse", "--short=7", "HEAD"),
    commit(file: string, text: string) {
      writeFileSync(join(repo, file), text);
      git("add", "-A");
      git("commit", "-qm", `change ${file}`);
    },
    calls: () => readFileSync(log, "utf8"),
    clearCalls: () => writeFileSync(log, ""),
    script: (name: string) => join(repo, "deploy/zima", name),
    images: () => readFileSync(join(state, "images"), "utf8").split("\n").filter(Boolean),
    running: () => readFileSync(join(state, "running"), "utf8").trim(),
    locked: () => existsSync(join(root, APP, "state/deploy.lock")),
    run(script: string, args: string[] = [], env: Record<string, string> = {}): Run {
      const p = Bun.spawnSync(["bash", join(repo, "deploy/zima", script), ...args], { cwd: repo, env: { ...baseEnv, ...env }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
    },
  };
}

const mode = (p: string) => statSync(p).mode & 0o777;
type Sandbox = ReturnType<typeof sandbox>;
const dumpFiles = (s: Sandbox) => readdirSync(s.app("state/pre-deploy")).filter((f) => f.endsWith(".dump")).sort();
const dumpFor = (s: Sandbox, sha: string) => dumpFiles(s).find((f) => f.endsWith(`-${sha}.dump`)) ?? `<no dump for ${sha}>`;
const show = (r: Run) => `exit ${r.code}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`;

describe("deploy.sh", () => {
  test("deploy refuses a dirty tree", () => {
    const s = sandbox();
    writeFileSync(join(s.repo, "stray.txt"), "uncommitted\n");
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("dirty");
    expect(s.calls()).not.toContain("ssh ");
    expect(s.calls()).not.toContain("bun test");
  });

  test("deploy refuses when bun test fails", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_BUN_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("bun test");
    expect(s.calls()).toContain("bun test");
    expect(s.calls()).not.toContain("ssh ");
  });

  test("the first-run server.env, and an older one without the summariser settings, both load at startup", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code, show(r)).toBe(0);
    const env = (lines: string[]) =>
      Object.fromEntries(lines.filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const written = env(readFileSync(join(s.app("secrets"), "server.env"), "utf8").split("\n"));
    // Every value deploy.sh writes must be one loadConfig accepts (SUMMARISER_ENABLED rejects unknown words).
    expect(loadConfig(written).summariser).toEqual({ enabled: true, share: 0.2, windowTokens: 2000000, cmd: "claude" });
    // The Mac mini failover is off until the owner fills in the two commented lines (deploy/zima/README.md).
    const raw = readFileSync(join(s.app("secrets"), "server.env"), "utf8").split("\n");
    expect(raw.some((l) => /^# EMBED_MACHINE_URLS=/.test(l))).toBe(true);
    expect(raw.some((l) => /^# EMBED_MODEL_DIGEST=/.test(l))).toBe(true);
    expect(loadConfig(written)).toMatchObject({ embedMachineUrls: {}, embedModelDigest: null });
    // Uncommented as the README says (drop the "# "), they load as they are.
    const enabled = env(raw.map((l) => l.replace(/^# (EMBED_MACHINE_URLS|EMBED_MODEL_DIGEST)=/, "$1=")));
    expect(loadConfig(enabled)).toMatchObject({
      embedMachineUrls: { "mac-mini": "http://192.168.4.42:11434", "macbook-pro": "http://192.168.4.45:11434" },
      // The digest line is filled in from deploy/.env's BGE_M3_DIGEST: the one deploy.sh gates the Zima on.
      embedModelDigest: MANIFEST_DIGEST.slice(0, 12),
    });
    // server.env is written only on the first deploy: one from before plan 3 has DATABASE_URL alone.
    expect(loadConfig({ DATABASE_URL: written.DATABASE_URL }).summariser).toEqual({ enabled: true, share: 0.2, windowTokens: 2000000, cmd: "claude" });
  });

  test("a later run without secrets on the server asks for --first-run", () => {
    const s = sandbox();
    const r = s.run("deploy.sh");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--first-run");
    expect(s.calls()).not.toContain("docker build");
  });

  test("first run creates secrets with 600 perms and never prints them", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code, show(r)).toBe(0);

    const secrets = s.app("secrets");
    expect(mode(s.app())).toBe(0o755); // the app dir stays traversable: src/ is synced as the ssh user
    expect(mode(secrets)).toBe(0o700);
    expect(existsSync(s.app("src/deploy/.env"))).toBe(false); // ignored files never leave the Mac
    expect(existsSync(s.app("src/.git"))).toBe(false);
    expect(mode(join(secrets, "db.env"))).toBe(0o600);
    expect(mode(join(secrets, "server.env"))).toBe(0o600);
    const db = readFileSync(join(secrets, "db.env"), "utf8");
    const pw = /^POSTGRES_PASSWORD=([A-Za-z0-9]+)$/m.exec(db)?.[1] ?? "";
    expect(pw.length).toBeGreaterThanOrEqual(32);
    const server = readFileSync(join(secrets, "server.env"), "utf8").split("\n");
    expect(server).toContain(`DATABASE_URL=postgres://cerebro:${pw}@cerebro-db:5432/cerebro`);
    expect(server).toContain("SUMMARY_SHARE=0.2");
    expect(server).toContain("SUBSCRIPTION_TOKENS_PER_5H=2000000");
    expect(server).toContain("SUMMARISER_ENABLED=true");
    expect(r.out + r.err).not.toContain(pw);
    expect(s.calls()).not.toContain(pw);

    // Root-owned secrets; data dirs owned by the db (999) and server (10010) users.
    const calls = s.calls();
    expect(calls).toContain(`chown root:root ${secrets}`);
    expect(calls).toContain(`chown 999:999 ${s.app("data/db")}`);
    expect(calls).toContain(`chown 10010:10010 ${s.app("data/claude")}`);
    for (const d of ["data/db", "data/ollama", "data/claude", "src/deploy/compose.yml"]) expect(existsSync(s.app(d))).toBe(true);

    // Model pulled with a one-off container (cerebro-net is internal), then the stack, migrate, server, registration.
    const order = ["docker build", "ollama pull", "up -d --wait --wait-timeout 300 db ollama", "pg_dump", "migrate", `compose-up-server cerebro-server:${s.sha()}`, "token create check", "casaos-cli app-management install -f"];
    const at = order.map((k) => calls.indexOf(k));
    expect(at.every((i) => i >= 0), `${order} in\n${calls}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    const compose = readFileSync(s.app("docker-compose.yml"), "utf8");
    expect(compose).toContain(`image: cerebro-server:${s.sha()}`);
    const confHash = new Bun.CryptoHasher("sha256").update(readFileSync(join(s.repo, "deploy/postgres.conf"))).digest("hex");
    expect(compose).toContain(`/DATA/AppData/cerebro/conf/postgres-${confHash}.conf:/etc/postgresql/postgres.conf:ro`);
    expect(compose).not.toContain("${");
    expect(compose).toContain("env_file: /DATA/AppData/cerebro/secrets/server.env");
    expect(compose).toContain("- /DATA/AppData/cerebro/data/db:/var/lib/postgresql/data");
    expect(compose).toContain('"127.0.0.1:8790:8790"');
    expect(compose).toMatch(/^ {4}cpus: 4$/m);
    expect(readFileSync(s.app("state/instance-id"), "utf8").trim()).toBe("inst-1");
    expect(readFileSync(s.app("state/schema-migrations"), "utf8").trim()).toBe("001_init.sql");
    expect(readFileSync(s.app("state/deployed"), "utf8")).toStartWith(`${s.sha()} `);
    expect(s.locked()).toBe(false);

    // The check machine token is created on the server after the gate, stored 600, never shown.
    expect(readFileSync(join(secrets, "check.token"), "utf8")).toBe(`${CHECK_TOKEN}\n`);
    expect(mode(join(secrets, "check.token"))).toBe(0o600);
    expect(r.out + r.err).not.toContain(CHECK_TOKEN);
    expect(calls).not.toContain(CHECK_TOKEN);

    // Every connection goes through the one multiplexed master, never prompting.
    const sshLines = calls.split("\n").filter((l) => l.startsWith("ssh "));
    expect(sshLines.length).toBeGreaterThan(5);
    for (const l of sshLines) {
      expect(l).toContain("ControlPath=/tmp/led-notify-ssh-");
      expect(l).toContain("BatchMode=yes");
    }

    // Re-running keeps the existing secrets and token, and takes no dump (migration list unchanged).
    s.clearCalls();
    const again = s.run("deploy.sh", ["--first-run"]);
    expect(again.code, show(again)).toBe(0);
    expect(readFileSync(join(secrets, "db.env"), "utf8")).toBe(db);
    expect(readFileSync(join(secrets, "check.token"), "utf8")).toBe(`${CHECK_TOKEN}\n`);
    expect(s.calls()).not.toContain("token create");
    expect(s.calls()).not.toContain("pg_dump");
  });

  test("deploy installs root-owned copies of the ops scripts and units where the backup unit runs them", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code, show(r)).toBe(0);
    const zima = s.app("zima");
    for (const f of ["backup.sh", "restore-test.sh", "exclude-from-zima-backup.sh"]) {
      expect(readFileSync(join(zima, f), "utf8")).toBe(readFileSync(s.script(f), "utf8"));
      expect(mode(join(zima, f))).toBe(0o700);
    }
    for (const f of ["cerebro-backup.service", "cerebro-backup.timer"]) {
      expect(readFileSync(join(zima, "systemd", f), "utf8")).toBe(readFileSync(s.script(`systemd/${f}`), "utf8"));
      expect(mode(join(zima, "systemd", f))).toBe(0o644);
    }
    expect(mode(zima)).toBe(0o755);
    expect(s.calls()).toContain(`chown -R root:root ${zima}`);
    // The unit's ExecStart is a file deploy put there (the repo itself is synced to src/, not zima/).
    const exec = /^ExecStart=(\S+)/m.exec(readFileSync(join(zima, "systemd/cerebro-backup.service"), "utf8"))?.[1] ?? "<none>";
    expect(exec).toStartWith("/DATA/");
    const target = join(s.root, exec.slice(1));
    expect(existsSync(target), exec).toBe(true);
    expect(mode(target) & 0o100).toBe(0o100);

    // A later deploy refreshes them.
    s.commit("deploy/zima/backup.sh", readFileSync(s.script("backup.sh"), "utf8") + "# changed\n");
    expect(s.run("deploy.sh").code).toBe(0);
    expect(readFileSync(join(zima, "backup.sh"), "utf8")).toEndWith("# changed\n");
  });

  test("a failing health gate rolls back to :prev", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const good = s.sha();
    s.commit("README.md", "broken release\n");
    const bad = s.sha();
    s.clearCalls();

    const r = s.run("deploy.sh", [], { FAKE_HEALTHY_TAGS: "prev", FAKE_INSTANCE: "inst-new" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("rolled back");
    const calls = s.calls();
    expect(calls).toContain(`docker tag cerebro-server:${good} cerebro-server:prev`);
    const up = calls.indexOf(`compose-up-server cerebro-server:${bad}`);
    const back = calls.indexOf("compose-up-server cerebro-server:prev");
    expect(up).toBeGreaterThan(-1);
    expect(back).toBeGreaterThan(up);
    expect(readFileSync(join(s.state, "running"), "utf8").trim()).toBe("cerebro-server:prev");
    // The failed release is not registered and the recorded instance is untouched.
    expect(readFileSync(join(s.root, "var/lib/casaos/apps/cerebro/docker-compose.yml"), "utf8")).toContain(`cerebro-server:${good}`);
    expect(calls).not.toContain("zimaos-app-management");
    expect(readFileSync(s.app("state/instance-id"), "utf8").trim()).toBe("inst-1");
    expect(s.locked()).toBe(false);
  });

  test("a failed server start rolls back to :prev", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "won't start\n");
    const r = s.run("deploy.sh", [], { FAKE_UP_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("failed to start");
    expect(r.err).toContain("rolled back to cerebro-server:prev (healthy)");
    expect(s.running()).toBe("cerebro-server:prev");
    expect(s.locked()).toBe(false);
  });

  test("a rollback that cannot start :prev says so and points at the logs", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "won't start\n");
    const r = s.run("deploy.sh", [], { FAKE_UP_RC: "1", FAKE_UP_PREV_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("starting cerebro-server:prev failed too");
    expect(r.err).toContain("docker logs");
    expect(s.locked()).toBe(false);
  });

  test("an interrupt while the new server is gated rolls back to :prev", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "interrupted\n");
    const r = s.run("deploy.sh", [], { FAKE_TERM_PATTERN: s.script("deploy.sh") });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("interrupted");
    expect(r.err).toContain("rolled back to cerebro-server:prev");
    expect(s.running()).toBe("cerebro-server:prev");
    expect(s.locked()).toBe(false);
  });

  test("the health gate waits for its deadline, not a number of tries", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "slow\n");
    const t0 = Date.now();
    const r = s.run("deploy.sh", [], { FAKE_HEALTHY_TAGS: "prev", CEREBRO_HEALTH_TIMEOUT: "5" });
    expect(r.code, show(r)).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000); // SECONDS ticks whole seconds
  }, 30_000);

  test("a second deploy fails while another holds the lock; the lock is released after success and failure", () => {
    const s = sandbox();
    mkdirSync(s.app("state/deploy.lock"), { recursive: true });
    writeFileSync(s.app("state/deploy.lock/owner"), "abc1234 from other-mac at 2026-11-14T10:00:00Z\n");
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("abc1234 from other-mac");
    expect(s.calls()).not.toContain("docker build");
    expect(existsSync(s.app("secrets"))).toBe(false); // no mutation before the lock
    expect(s.locked()).toBe(true); // someone else's lock is left alone

    rmSync(s.app("state/deploy.lock"), { recursive: true });
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    expect(s.locked()).toBe(false);
    expect(s.run("deploy.sh", [], { FAKE_BUILD_RC: "1" }).code).toBe(1);
    expect(s.locked()).toBe(false);
  });

  test("a changed migration list takes a pre-deploy dump, and a rollback names the migrations and the dump", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const dumps = s.app("state/pre-deploy");
    // Older dumps beyond the newest three are removed.
    for (const i of [1, 2, 3]) writeFileSync(join(dumps, `20000101T00000${i}Z-seed${i}.dump`), "PGDMP");
    s.commit("server/migrations/002_more.sql", "alter table t add y int;\n");
    const sha = s.sha();
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_HEALTHY_TAGS: "prev", FAKE_MIGRATE_OUT: "migrated: 002_more.sql" });
    expect(r.code, show(r)).toBe(1);
    const dumpCall = s.calls().split("\n").find((l) => l.includes("pg_dump")) ?? "";
    for (const t of ["chunk_embeddings", "summary_embeddings", "embed_queue"]) expect(dumpCall).toContain(`--exclude-table-data=${t}`);
    expect(dumpCall).toContain("-Fc");
    const dump = dumpFor(s, sha);
    expect(dump).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{7}\.dump$/);
    expect(mode(join(dumps, dump))).toBe(0o600);
    expect(readFileSync(join(dumps, dump), "utf8")).toBe("PGDMP-fake");
    expect(dumpFiles(s).length).toBe(3);
    expect(r.err).toContain("002_more.sql");
    expect(r.err).toContain(`/DATA/AppData/cerebro/state/pre-deploy/${dump}`);
    expect(r.out).toContain("migrated: 002_more.sql");
    // The schema list is recorded once migrate succeeds, whatever the gate says.
    expect(readFileSync(s.app("state/schema-migrations"), "utf8").trim()).toBe("001_init.sql\n002_more.sql");
  });

  test("retrying after a rolled-back migration keeps the original dump and takes no new one", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("server/migrations/002_more.sql", "alter table t add y int;\n");
    const sha = s.sha();
    const failing = { FAKE_HEALTHY_TAGS: "prev" };
    let r = s.run("deploy.sh", [], { ...failing, FAKE_MIGRATE_OUT: "migrated: 002_more.sql", FAKE_DUMP_CONTENT: "PGDMP-before" });
    expect(r.code, show(r)).toBe(1);
    const dump = dumpFor(s, sha);
    const before = dumpFiles(s);

    // Same sha again: the schema already has 002, so no dump (it would capture the migrated schema).
    s.clearCalls();
    r = s.run("deploy.sh", [], { ...failing, FAKE_DUMP_CONTENT: "PGDMP-after" });
    expect(r.code, show(r)).toBe(1);
    expect(s.calls()).not.toContain("pg_dump");
    expect(readFileSync(s.app(`state/pre-deploy/${dump}`), "utf8")).toBe("PGDMP-before");
    expect(dumpFiles(s)).toEqual(before);

    // Three retries with new shas and no new migrations: still no dump, the original stays.
    for (const n of [1, 2, 3]) {
      s.commit("README.md", `retry ${n}\n`);
      expect(s.run("deploy.sh", [], { ...failing, FAKE_DUMP_CONTENT: "PGDMP-after" }).code).toBe(1);
    }
    expect(readFileSync(s.app(`state/pre-deploy/${dump}`), "utf8")).toBe("PGDMP-before");

    // Pruning never removes the dump taken before an applied migration, nor this run's dump.
    for (const i of [1, 2, 3]) writeFileSync(s.app(`state/pre-deploy/29990101T00000${i}Z-later${i}.dump`), "PGDMP");
    s.commit("server/migrations/003_again.sql", "alter table t add z int;\n");
    r = s.run("deploy.sh", [], { FAKE_MIGRATE_OUT: "migrated: 003_again.sql" });
    expect(r.code, show(r)).toBe(0);
    expect(dumpFiles(s)).toContain(dump);
    expect(dumpFiles(s)).toContain(dumpFor(s, s.sha()));
  }, 30_000);

  test(":prev is the last release that passed the gate, not whatever is running", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const good = s.sha();
    // A failed rollback left a never-gated image running.
    writeFileSync(join(s.state, "running"), "cerebro-server:bad9999\n");
    writeFileSync(join(s.state, "images"), readFileSync(join(s.state, "images"), "utf8") + "cerebro-server:bad9999\n");
    s.commit("README.md", "next\n");
    s.clearCalls();
    const r = s.run("deploy.sh");
    expect(r.code, show(r)).toBe(0);
    expect(s.calls()).toContain(`docker tag cerebro-server:${good} cerebro-server:prev`);
    expect(s.calls()).not.toContain("docker tag cerebro-server:bad9999");
  });

  test("an ssh failure while locking is reported as unreachable, with no second connection", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_SSH_RC: "255" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot reach zima");
    expect(r.err).not.toContain("another deploy");
    expect(s.calls().split("\n").filter((l) => l.startsWith("ssh ")).length).toBe(1);
  });

  test("the lock is only released while it is still this run's", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_STEAL_LOCK: "1" });
    expect(r.code, show(r)).toBe(0);
    expect(s.locked()).toBe(true);
    expect(readFileSync(s.app("state/deploy.lock/owner"), "utf8")).toContain("thief");
  });

  test("an interrupt during migrate says the schema may be partly migrated and names the dump", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("server/migrations/002_more.sql", "alter table t add y int;\n");
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_TERM_PATTERN: s.script("deploy.sh"), FAKE_TERM_AT: "migrate" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("partly migrated");
    expect(r.err).toContain(`/DATA/AppData/cerebro/state/pre-deploy/${dumpFor(s, s.sha())}`);
    expect(r.err).not.toContain("the running server is unchanged");
    expect(s.calls()).not.toContain("compose-up-server");
    expect(s.locked()).toBe(false);
  });

  test("a rollback is not cut short by further interrupts", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "interrupted twice\n");
    const r = s.run("deploy.sh", [], { FAKE_TERM_PATTERN: s.script("deploy.sh"), FAKE_TERM_REPEAT: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("rolled back to cerebro-server:prev (healthy)");
    expect(s.running()).toBe("cerebro-server:prev");
    expect(s.locked()).toBe(false);
  });

  test("a failed migration starts no server and leaves :prev alone", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("README.md", "b\n");
    expect(s.run("deploy.sh").code).toBe(0);
    const live = s.running();
    s.commit("README.md", "c\n");
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_MIGRATE_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("migration failed");
    expect(s.calls()).not.toContain("compose-up-server");
    expect(s.calls()).not.toContain("docker tag");
    expect(s.running()).toBe(live);
  });

  test("a failed build touches nothing", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const live = s.running();
    s.commit("README.md", "b\n");
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_BUILD_RC: "1" });
    expect(r.code).toBe(1);
    for (const k of ["docker compose", "docker tag", "docker run", "docker rmi", "casaos-cli", "systemctl"]) expect(s.calls()).not.toContain(k);
    expect(s.running()).toBe(live);
  });

  test("a successful deploy untags old server images and prunes the build cache", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const a = s.sha();
    s.commit("README.md", "b\n");
    const b = s.sha();
    writeFileSync(join(s.state, "images"), readFileSync(join(s.state, "images"), "utf8") + "cerebro-server:old1111\ncerebro-server:old2222\n");
    s.clearCalls();
    const r = s.run("deploy.sh");
    expect(r.code, show(r)).toBe(0);
    const rmi = s.calls().split("\n").find((l) => l.startsWith("docker rmi")) ?? "";
    for (const t of ["old1111", "old2222", a]) expect(rmi).toContain(`cerebro-server:${t}`);
    expect(rmi).not.toContain(b);
    expect(rmi).not.toContain("prev");
    expect([...new Set(s.images())].sort()).toEqual([`cerebro-server:${b}`, "cerebro-server:prev"]);
    expect(s.calls()).toContain("docker builder prune -f --filter until=168h");
  });

  test("later runs refresh the stored ZimaOS compose and restart app management only when metadata changed", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const stored = join(s.root, "var/lib/casaos/apps/cerebro/docker-compose.yml");

    s.commit("README.md", "next\n");
    s.clearCalls();
    let r = s.run("deploy.sh");
    expect(r.code, show(r)).toBe(0);
    expect(readFileSync(stored, "utf8")).toContain(`image: cerebro-server:${s.sha()}`);
    expect(s.calls()).not.toContain("casaos-cli app-management install");
    expect(s.calls()).not.toContain("systemctl restart zimaos-app-management");

    const compose = readFileSync(join(s.repo, "deploy/compose.yml"), "utf8");
    s.commit("deploy/compose.yml", compose.replace("en_us: Private memory server", "en_us: Private memory"));
    s.clearCalls();
    r = s.run("deploy.sh");
    expect(r.code, show(r)).toBe(0);
    expect(readFileSync(stored, "utf8")).toContain("en_us: Private memory\n");
    expect(s.calls()).toContain("systemctl restart zimaos-app-management");
  });

  test("the db carries postgres.conf's sha256 as a label, so a changed conf recreates it on deploy", () => {
    const s = sandbox();
    const sha256 = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(join(s.repo, f))).digest("hex");
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const label = (h: string) => `cerebro.postgres-conf-sha256: "${h}"`;
    const before = sha256("deploy/postgres.conf");
    const compose = readFileSync(s.app("docker-compose.yml"), "utf8");
    expect(compose).toContain(label(before));
    expect(compose.indexOf(label(before))).toBeLessThan(compose.indexOf("  ollama:")); // on the db service

    s.commit("deploy/postgres.conf", readFileSync(join(s.repo, "deploy/postgres.conf"), "utf8") + "work_mem = 4MB\n");
    const after = sha256("deploy/postgres.conf");
    expect(after).not.toBe(before);
    s.clearCalls();
    const r = s.run("deploy.sh");
    expect(r.code, show(r)).toBe(0);
    expect(readFileSync(s.app("docker-compose.yml"), "utf8")).toContain(label(after));
    // db and ollama come up from the new definitions (compose recreates db when its labels change).
    expect(s.calls()).toMatch(/docker compose -f \S+docker-compose\.next\.yml up -d --wait --wait-timeout \d+ db ollama/);
  });

  test("db/ollama failing to come up puts the last good definitions back and stops before migrating", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const live = s.running();
    s.commit("README.md", "b\n");
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_UP_DEPS_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("db/ollama did not come up healthy");
    expect(r.err).toContain("restarted them from the last good compose");
    const calls = s.calls();
    const failed = calls.indexOf("docker-compose.next.yml up -d --wait");
    const restore = calls.indexOf(`docker compose -f ${s.app("docker-compose.yml")} up -d db ollama`);
    expect(failed).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(failed);
    expect(calls).not.toContain("migrate");
    expect(calls).not.toContain("compose-up-server");
    expect(existsSync(s.app("docker-compose.next.yml"))).toBe(false);
    expect(s.running()).toBe(live);
    expect(s.locked()).toBe(false);
  });

  test("a postgres.conf the db can't start with: the last good compose still mounts the previous conf", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    const good = readFileSync(join(s.repo, "deploy/postgres.conf"), "utf8");
    s.commit("deploy/postgres.conf", good + "shared_buffers = 64GB\n");
    const r = s.run("deploy.sh", [], { FAKE_UP_DEPS_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    const mount = /- (\S+):\/etc\/postgresql\/postgres\.conf:ro/.exec(readFileSync(s.app("docker-compose.yml"), "utf8"))?.[1] ?? "<none>";
    expect(mount).toStartWith("/DATA/AppData/cerebro/conf/");
    expect(readFileSync(join(s.root, mount.slice(1)), "utf8")).toBe(good);
    expect(mode(join(s.root, mount.slice(1)))).toBe(0o644); // read by postgres (uid 999)

    // Once a release with a new conf is live, copies no compose refers to are removed.
    s.commit("deploy/postgres.conf", good + "work_mem = 4MB\n");
    expect(s.run("deploy.sh").code).toBe(0);
    const confs = readdirSync(s.app("conf"));
    expect(confs).toHaveLength(1);
    expect(readFileSync(s.app(`conf/${confs[0]}`), "utf8")).toBe(good + "work_mem = 4MB\n");
  });

  test("db/ollama failing on the first deploy says there is nothing to go back to", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_UP_DEPS_RC: "1" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("db/ollama did not come up healthy");
    expect(r.err).toContain("no earlier release");
    expect(s.calls()).not.toContain("migrate");
    expect(s.locked()).toBe(false);
  });

  test("a failed ZimaOS registration is a warning with the manual route; the release stays live and old images are pruned", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_CASAOS_RC: "1" });
    expect(r.code, show(r)).toBe(0);
    expect(r.out + r.err).toMatch(/warning: could not register the ZimaOS app/);
    expect(r.out + r.err).toContain("ssh zima sudo casaos-cli app-management install -f /DATA/AppData/cerebro/docker-compose.yml");
    expect(r.out).toContain("is live");
    expect(s.calls()).toContain("docker builder prune");
    // The live compose's postgres.conf copy survives the prune although ZimaOS stored no compose.
    const mount = /- (\S+):\/etc\/postgresql\/postgres\.conf:ro/.exec(readFileSync(s.app("docker-compose.yml"), "utf8"))?.[1] ?? "<none>";
    expect(existsSync(join(s.root, mount.slice(1))), mount).toBe(true);
    expect(s.locked()).toBe(false);
  });

  test("a migration that fails part-way keeps its pre-deploy dump as the recovery point across retries", () => {
    const s = sandbox();
    expect(s.run("deploy.sh", ["--first-run"]).code).toBe(0);
    s.commit("server/migrations/002_more.sql", "alter table t add y int;\n");
    s.commit("server/migrations/003_again.sql", "alter table t add z int;\n");
    const sha = s.sha();
    // migrate applies 002, then fails on 003.
    const failing = { FAKE_MIGRATE_RC: "1", FAKE_MIGRATE_OUT: "migrated: 002_more.sql\nerror in 003_again.sql" };
    let r = s.run("deploy.sh", [], { ...failing, FAKE_DUMP_CONTENT: "PGDMP-before" });
    expect(r.code, show(r)).toBe(1);
    const dump = dumpFor(s, sha);
    expect(readFileSync(s.app("state/pre-deploy/pending"), "utf8").trim()).toBe(dump);
    const afterFirstFailure = dumpFiles(s); // the first deploy's dump and this one

    for (const n of [1, 2, 3]) {
      s.commit("README.md", `retry ${n}\n`);
      s.clearCalls();
      r = s.run("deploy.sh", [], { ...failing, FAKE_DUMP_CONTENT: "PGDMP-after" });
      expect(r.code, show(r)).toBe(1);
      expect(s.calls()).not.toContain("pg_dump"); // the schema is partly migrated: a dump now is no recovery point
      expect(r.err).toContain(`/DATA/AppData/cerebro/state/pre-deploy/${dump}`);
    }
    expect(dumpFiles(s)).toEqual(afterFirstFailure); // no new dumps, none pruned
    expect(readFileSync(s.app(`state/pre-deploy/${dump}`), "utf8")).toBe("PGDMP-before");

    // The fixed release migrates: the marked dump becomes the applied recovery point and the marker is cleared.
    s.commit("README.md", "fixed\n");
    s.clearCalls();
    r = s.run("deploy.sh", [], { FAKE_MIGRATE_OUT: "migrated: 003_again.sql" });
    expect(r.code, show(r)).toBe(0);
    expect(s.calls()).not.toContain("pg_dump");
    expect(existsSync(s.app("state/pre-deploy/pending"))).toBe(false);
    expect(readFileSync(s.app("state/pre-deploy/applied"), "utf8").trim()).toBe(dump);
    expect(readFileSync(s.app("state/schema-migrations"), "utf8").trim()).toBe("001_init.sql\n002_more.sql\n003_again.sql");
  }, 30_000);

  test("a lock whose owner line cannot be written is removed and the deploy stops", () => {
    const s = sandbox();
    const r = s.run("deploy.sh", ["--first-run"], { FAKE_TEE_FAIL: "deploy.lock/owner" });
    expect(r.code, show(r)).toBe(1);
    expect(r.err).toContain("could not record the deploy lock's owner");
    expect(s.locked()).toBe(false);
    expect(s.calls()).not.toContain("docker build");
  });

  test("a bge-m3 digest mismatch stops the deploy before migrating", () => {
    const s = sandbox("BGE_M3_DIGEST=0123456789abcdef\n");
    const r = s.run("deploy.sh", ["--first-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("BGE_M3_DIGEST");
    expect(s.calls()).not.toContain("migrate");
    expect(s.calls()).not.toContain("compose-up-server");
  });
});

describe("check.sh", () => {
  const TOKEN = "tok-check-secret-123";
  const healthy = '{"ok":true,"db":true,"apiVersion":1,"instanceId":"inst-1"}';
  const status = (o: {
    pending?: number; dead?: number; lastSuccessMinutes?: number | null; paused?: string | null; dbBytes?: number; summariser?: boolean;
    summaryDead?: number; lastError?: string | null; lastRunAt?: string | null;
    endpoints?: { machine: string; state: string; url?: string; lastError?: string | null; known?: boolean }[];
    fallbackState?: string; waitLiveHours?: number; waitImportedHours?: number; pausedMinutes?: number; embedderError?: string;
  } = {}) =>
    JSON.stringify({
      machine: "check",
      queue: {
        pending: o.pending ?? 0, dead: o.dead ?? 0, oldestPendingSeconds: 0,
        oldestWaitSeconds: { live: (o.waitLiveHours ?? 0) * 3600, imported: (o.waitImportedHours ?? 0) * 3600 },
      },
      embedder: {
        lastSuccessAt: o.lastSuccessMinutes === null ? null : new Date(Date.now() - (o.lastSuccessMinutes ?? 10) * 60_000).toISOString(),
        lastError: o.embedderError ?? null,
        pausedUntil: o.pausedMinutes ? new Date(Date.now() + o.pausedMinutes * 60_000).toISOString() : null,
        ...(o.endpoints ? {
          endpoints: o.endpoints.map((e) => ({
            machine: e.machine, known: e.known ?? true, url: e.url ?? "http://192.168.4.42:11434", state: e.state,
            lastError: e.lastError ?? null, downUntil: null, lastUsedAt: null,
          })),
          fallback: { url: "http://cerebro-ollama:11434", lastUsedAt: null, state: o.fallbackState ?? "ok", lastError: null },
        } : {}),
      },
      ...(o.summariser === false ? {} : {
        summariser: {
          enabled: true, paused: o.paused ? { reason: o.paused, until: null } : null,
          lastRunAt: o.lastRunAt === undefined ? new Date(Date.now() - 5 * 60_000).toISOString() : o.lastRunAt,
          lastError: o.lastError ?? null, credentialExpiresAt: null,
          backlog: { live: 0, imported: 0, dead: o.summaryDead ?? 0 },
          budget: { used: 0, limit: 400000, resumesAt: null },
        },
      }),
      dbBytes: o.dbBytes ?? 5e9,
    });
  const GOOD = {
    FAKE_HEALTH_LAN: healthy, FAKE_HEALTH_LOCAL: healthy, FAKE_TOKEN: TOKEN, FAKE_STATUS: status(),
    FAKE_OLLAMA_LIST: "NAME             ID              SIZE      MODIFIED\nbge-m3:latest    790764642607    1.2 GB    2 days ago",
    // <container> <anon> <shmem> <file (page cache)> <limit> <oom_kill>
    FAKE_MEM: [
      "cerebro-db 200000000 100000000 1700000000 2147483648 0",
      "cerebro-ollama 1500000000 0 100000000 3221225472 0",
      "cerebro-server 150000000 0 10000000 1073741824 0",
    ].join("\n"),
    FAKE_TIMER_STATE: "active",
    FAKE_DF_PCT: "40%",
  };

  function checkSandbox(opts: { token?: boolean; backupHoursAgo?: number } = {}) {
    const s = sandbox();
    mkdirSync(s.app("state"), { recursive: true });
    writeFileSync(s.app("state/instance-id"), "inst-1\n");
    mkdirSync(s.app("secrets"), { recursive: true });
    if (opts.token !== false) writeFileSync(s.app("secrets/check.token"), `${TOKEN}\n`);
    const nightly = join(s.root, "DATA/Backup/cerebro/nightly");
    mkdirSync(nightly, { recursive: true });
    const dump = join(nightly, "2026-11-12.dump");
    writeFileSync(dump, "PGDMP");
    const t = (Date.now() - (opts.backupHoursAgo ?? 1) * 3_600_000) / 1000;
    utimesSync(dump, t, t);
    return s;
  }

  test("check prints ALL OK when everything is healthy and never prints the token", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], GOOD);
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toContain("ALL OK");
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(s.calls()).not.toContain(TOKEN);
  });

  test("check reports each failing condition by name", () => {
    const s = checkSandbox({ backupHoursAgo: 30 });
    const r = s.run("check.sh", [], {
      ...GOOD,
      FAKE_HEALTH_LAN: "",
      FAKE_HEALTH_LOCAL: '{"ok":false,"db":false,"apiVersion":1,"instanceId":"inst-2"}',
      FAKE_STATUS: status({ pending: 12, dead: 3, lastSuccessMinutes: 120, paused: "login", dbBytes: 160e9 }),
      FAKE_OLLAMA_LIST: "NAME    ID    SIZE    MODIFIED",
      FAKE_MEM: "cerebro-db 1800000000 300000000 0 2147483648 0\ncerebro-ollama 1500000000 0 100000000 3221225472 0",
      FAKE_TIMER_STATE: "inactive",
    });
    expect(r.code, show(r)).toBe(1);
    expect(r.out).not.toContain("ALL OK");
    for (const name of ["health-lan", "health-local", "instance-id", "queue", "embedder", "summariser", "db-size", "bge-m3", "backup-timer", "backup-age", "memory"])
      expect(r.out, show(r)).toMatch(new RegExp(`^FAIL +${name} `, "m"));
    expect(r.out).toMatch(/^FAIL +embedder +12 pending, last success 120 min ago$/m);
    expect(r.out).toMatch(/^FAIL +memory +cerebro-db at 97% of its limit \(anon\+shmem\), cerebro-server not running$/m);
  });

  test("check warns at 120 GB and fails at 150 GB", () => {
    const s = checkSandbox();
    const warn = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ dbBytes: 130e9 }) });
    expect(warn.code, show(warn)).toBe(0);
    expect(warn.out).toMatch(/^warn +db-size /m);
    expect(warn.out).toContain("ALL OK");
  });

  test("memory counts anon+shmem against each limit, not the page cache", () => {
    const s = checkSandbox();
    // docker stats would say 95% for the db: 1.7 GB of it is reclaimable page cache.
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATS: "cerebro-db 95.00%\ncerebro-ollama 40.00%\ncerebro-server 20.00%" });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^ok +memory +cerebro-db 13% cerebro-ollama 46% cerebro-server 13% \(anon\+shmem of each limit\)$/m);
  });

  test("memory warns about OOM kills inside a container that is still running", () => {
    const s = checkSandbox();
    const mem = GOOD.FAKE_MEM.replace("cerebro-db 200000000 100000000 1700000000 2147483648 0", "cerebro-db 200000000 100000000 1700000000 2147483648 2");
    const r = s.run("check.sh", [], { ...GOOD, FAKE_MEM: mem });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +memory +cerebro-db: 2 OOM kill\(s\) since the container started/m);
    expect(r.out).toContain("ALL OK (1 warning(s))");
  });

  test("check warns when the shared backup drive is over 80% full", () => {
    const s = checkSandbox();
    const ok = s.run("check.sh", [], GOOD);
    expect(ok.out).toMatch(/^ok +backup-disk +\/DATA\/Backup 40% used$/m);
    const r = s.run("check.sh", [], { ...GOOD, FAKE_DF_PCT: "85%" });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +backup-disk +\/DATA\/Backup 85% used/m);
    expect(r.out).toContain("ALL OK (1 warning(s))");
  });

  test("check fails the status check without the check token", () => {
    const s = checkSandbox({ token: false });
    const r = s.run("check.sh", [], GOOD);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL +status .*check\.token/m);
  });

  test("summariser: an expired login and an outage fail the check", () => {
    const s = checkSandbox();
    const login = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ paused: "login" }) });
    expect(login.code, show(login)).toBe(1);
    expect(login.out).toMatch(/^FAIL +summariser +paused: Claude login expired /m);
    expect(login.out).toContain("FAILED: summariser");
    const down = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ paused: "unavailable" }) });
    expect(down.code, show(down)).toBe(1);
    expect(down.out).toMatch(/^FAIL +summariser +paused: Claude CLI unavailable \/ outage/m);
    expect(down.out).toContain("FAILED: summariser");
  });

  test("summariser: budget and usage-limit pauses are normal deferral, reported without failing", () => {
    const s = checkSandbox();
    for (const reason of ["budget", "usage_limit"]) {
      const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ paused: reason }) });
      expect(r.code, show(r)).toBe(0);
      expect(r.out).toMatch(new RegExp(`^(ok|warn) +summariser +paused: ${reason} `, "m"));
      expect(r.out).toContain("ALL OK");
    }
  });

  test("summariser: disabled by config is reported, and a missing block warns", () => {
    const s = checkSandbox();
    const off = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ paused: "disabled" }) });
    expect(off.code, show(off)).toBe(0);
    expect(off.out).toMatch(/^ok +summariser +disabled \(SUMMARISER_ENABLED\)/m);
    const running = s.run("check.sh", [], GOOD);
    expect(running.out).toMatch(/^ok +summariser +running$/m);
    const missing = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ summariser: false }) });
    expect(missing.code, show(missing)).toBe(0);
    expect(missing.out).toMatch(/^warn +summariser +not reported by \/v1\/status/m);
    const nul = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: JSON.stringify({ ...JSON.parse(status()), summariser: null }) });
    expect(nul.code, show(nul)).toBe(0);
    expect(nul.out).toMatch(/^warn +summariser +not reported by \/v1\/status/m);
  });

  test("I1: dead summary jobs fail the check, naming the server-side requeue command", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ summaryDead: 2, lastError: "summary: bad_output" }) });
    expect(r.code, show(r)).toBe(1);
    expect(r.out).toMatch(
      /^FAIL +summariser-jobs +dead 2 \(last error: summary: bad_output; fix the cause, then: ssh zima sudo docker exec cerebro-server bun --no-install server\/src\/cli\.ts requeue-dead-summaries\)$/m);
    expect(r.out).toContain("FAILED: summariser-jobs");
    const ok = s.run("check.sh", [], GOOD);
    expect(ok.out).toMatch(/^ok +summariser-jobs +dead 0$/m);
  });

  test("I1: a running summariser shows its last error", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ lastError: "summary: bad_output" }) });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^ok +summariser +running \(last error: summary: bad_output\)$/m);
  });

  test("M9: a running summariser that no Claude call has answered since start warns", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ lastRunAt: null }) });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +summariser +running, but no Claude call has answered since the server started \(logged in\?/m);
    expect(r.out).toContain("ALL OK (1 warning(s))");
  });

  test("I1: check.sh reads the server's real /v1/status: dead summary jobs and lastError", async () => {
    const state = newSummariserState(true);
    const t = await authedApp({ deps: { summariser: { state, budget: { share: 0.2, windowTokens: 2_000_000 } } } });
    let real: string;
    try {
      const { binding } = await boundFolder(t, { project: "Web" });
      await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
      await t.sql`insert into summary_jobs (session_id, attempts, dead, last_error) values ('s1', 5, true, 'bad_output: x')`;
      state.lastRunAt = new Date().toISOString();
      state.lastError = "summary: bad_output";
      real = await (await t.call("GET", "/v1/status")).text();
    } finally { await t.drop(); }
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: real });
    expect(r.code, show(r)).toBe(1);
    expect(r.out).toMatch(/^ok +summariser +running \(last error: summary: bad_output\)$/m);
    expect(r.out).toMatch(/^FAIL +summariser-jobs +dead 1 /m);
  });

  test("M6: the dead-chunk hint is the server-side docker exec form", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ dead: 3 }) });
    expect(r.code, show(r)).toBe(1);
    expect(r.out).toMatch(
      /^FAIL +queue +pending 0, dead 3 \(retry them: ssh zima sudo docker exec cerebro-server bun --no-install server\/src\/cli\.ts requeue-dead\)$/m);
  });

  const MBP = "http://192.168.4.45:11434";

  test("embed-route: each machine endpoint that is down or digest-mismatched warns by name, never fails", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], {
      ...GOOD,
      FAKE_STATUS: status({
        endpoints: [
          { machine: "mac-mini", state: "down", lastError: "embedder unavailable: Unable to connect" },
          { machine: "macbook-pro", url: MBP, state: "digest_mismatch", lastError: "model bge-m3 digest 0123456789ab does not match" },
        ],
      }),
    });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(
      /^warn +embed-route +mac-mini: embedding on the Zima CPU \(slow\): its Ollama is unreachable at http:\/\/192\.168\.4\.42:11434 \(embedder unavailable: Unable to connect\)$/m);
    expect(r.out).toMatch(
      /^warn +embed-route +macbook-pro: embedding on the Zima CPU \(slow\): its Ollama has a different bge-m3 \(mismatch\) at http:\/\/192\.168\.4\.45:11434 \(model bge-m3 digest 0123456789ab does not match\)$/m);
    expect(r.out).toContain("ALL OK (2 warning(s))");
  });

  test("embed-route: up and untried endpoints, and no endpoints at all, are fine", () => {
    const s = checkSandbox();
    const up = s.run("check.sh", [], {
      ...GOOD, FAKE_STATUS: status({ endpoints: [{ machine: "mac-mini", state: "up" }, { machine: "macbook-pro", url: MBP, state: "unknown" }] }),
    });
    expect(up.code, show(up)).toBe(0);
    expect(up.out).toMatch(/^ok +embed-route +mac-mini up, macbook-pro not tried yet \(each Mac embeds its own work\)$/m);
    expect(up.out).toMatch(/^ALL OK$/m);
    const none = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ endpoints: [] }) });
    expect(none.out).toMatch(/^ok +embed-route +Zima Ollama only \(EMBED_MACHINE_URLS unset\)$/m);
    const older = s.run("check.sh", [], GOOD); // a server from before the routing: no endpoints list
    expect(older.out).toMatch(/^ok +embed-route +Zima Ollama only \(EMBED_MACHINE_URLS unset\)$/m);
    expect(older.out).toMatch(/^ALL OK$/m);
  });

  test("embed-route: a mapped name with no live machine token warns (a typo leaves that Mac on the Zima)", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ endpoints: [{ machine: "macmini", state: "unknown", known: false }] }) });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +embed-route +macmini: no machine token by this name \(a typo in EMBED_MACHINE_URLS\? see token list\); that Mac's work embeds on the Zima CPU$/m);
    expect(r.out).toContain("ALL OK (1 warning(s))");
  });

  test("embed-route: the Zima's own digest not confirmed warns that no Mac is used", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ endpoints: [{ machine: "mac-mini", state: "up" }], fallbackState: "digest_mismatch" }) });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +embed-route +no Mac is used: the Zima's bge-m3 is not confirmed against EMBED_MODEL_DIGEST \(digest_mismatch\)/m);
  });

  test("queue-wait: warns when the oldest live chunk waited over 6 h or the oldest imported one over 48 h", () => {
    const s = checkSandbox();
    const ok = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ pending: 3, waitLiveHours: 5, waitImportedHours: 47 }) });
    expect(ok.out).toMatch(/^ok +queue-wait +oldest live 5 h, imported 47 h$/m);
    const live = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ pending: 3, waitLiveHours: 7 }) });
    expect(live.code, show(live)).toBe(0);
    expect(live.out).toMatch(/^warn +queue-wait +a live chunk has waited 7 h to be embedded/m);
    const imported = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ pending: 3, waitImportedHours: 50 }) });
    expect(imported.out).toMatch(/^warn +queue-wait +an imported chunk has waited 50 h to be embedded/m);
    const legacy = JSON.parse(status());
    delete legacy.queue.oldestWaitSeconds; // a server from before migration 007
    const older = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: JSON.stringify(legacy) });
    expect(older.out).not.toMatch(/queue-wait/);
  });

  test("embedder: a paused Zima embedder warns with its last error", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ pausedMinutes: 3, embedderError: "embedder unavailable: Unable to connect" }) });
    expect(r.code, show(r)).toBe(0);
    expect(r.out).toMatch(/^warn +embed-paused +the Zima embedder is paused until \S+ \(last error: embedder unavailable: Unable to connect\)$/m);
  });

  test("embed-route: check.sh reads the server's real /v1/status: down warns, and a recovered Mac stops warning (M2)", async () => {
    const mac = fakeOllama(1), zima = fakeOllama(2);
    let clock = 1_000_000;
    const embedder = createEmbedRouter({
      machineUrls: { "test-mac": mac.url, "macmini": "http://127.0.0.1:1" }, fallbackUrl: zima.url, model: "bge-m3", dims: 1024,
      digest: "790764642607", log: () => {}, now: () => clock,
    });
    const t = await authedApp({ embedder });
    const real: string[] = [];
    try {
      mac.mode = "503";
      await embedder.probeNow();
      real.push(await (await t.call("GET", "/v1/status")).text());
      mac.mode = "ok";
      clock += PRIMARY_DOWN_MS;
      await embedder.probeNow();
      real.push(await (await t.call("GET", "/v1/status")).text());
    } finally { await t.drop(); mac.stop(); zima.stop(); embedder.stop(); }
    const s = checkSandbox();
    const down = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: real[0] });
    expect(down.code, show(down)).toBe(0);
    expect(down.out).toMatch(/^warn +embed-route +test-mac: embedding on the Zima CPU \(slow\): its Ollama is unreachable at http:\/\/127\.0\.0\.1:\d+ \(embedder returned 503\)$/m);
    expect(down.out).toMatch(/^warn +embed-route +macmini: no machine token by this name/m);
    const up = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: real[1] });
    expect(up.out).not.toMatch(/^warn +embed-route +test-mac/m);
    expect(up.out).toMatch(/^ok +embed-route +test-mac up/m);
  });

  test("an idle embedder with an empty queue is fine", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ lastSuccessMinutes: null, pending: 0 }) });
    expect(r.code, show(r)).toBe(0);
  });
});
