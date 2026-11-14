// deploy.sh and check.sh against fakes: `ssh` runs the remote command locally with /DATA and
// /var/lib/casaos mapped into a temp root; docker, casaos-cli, systemctl, curl, sudo, chown, bun and
// sleep are shims that record their calls. Nothing here contacts the real server.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
    const order = ["docker build", "ollama pull", "--wait db ollama", "pg_dump", "migrate", `compose-up-server cerebro-server:${s.sha()}`, "token create check", "casaos-cli app-management install -f"];
    const at = order.map((k) => calls.indexOf(k));
    expect(at.every((i) => i >= 0), `${order} in\n${calls}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    const compose = readFileSync(s.app("docker-compose.yml"), "utf8");
    expect(compose).toContain(`image: cerebro-server:${s.sha()}`);
    expect(compose).toContain("/DATA/AppData/cerebro/src/deploy/postgres.conf:/etc/postgresql/postgres.conf:ro");
    expect(compose).not.toContain("${");
    expect(compose).toContain("env_file: /DATA/AppData/cerebro/secrets/server.env");
    expect(compose).toContain("- /DATA/AppData/cerebro/data/db:/var/lib/postgresql/data");
    expect(compose).toContain('"127.0.0.1:8790:8790"');
    expect(compose).toMatch(/^ {4}cpus: 4$/m);
    expect(readFileSync(s.app("state/instance-id"), "utf8").trim()).toBe("inst-1");
    expect(readFileSync(s.app("state/migrations"), "utf8").trim()).toBe("001_init.sql");
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
    for (const [i, name] of ["old1", "old2", "old3"].entries()) {
      writeFileSync(join(dumps, `${name}.dump`), "PGDMP");
      const t = Date.now() / 1000 - 86_400 * (i + 1);
      utimesSync(join(dumps, `${name}.dump`), t, t);
    }
    s.commit("server/migrations/002_more.sql", "alter table t add y int;\n");
    const sha = s.sha();
    s.clearCalls();
    const r = s.run("deploy.sh", [], { FAKE_HEALTHY_TAGS: "prev", FAKE_MIGRATE_OUT: "migrated: 002_more.sql" });
    expect(r.code, show(r)).toBe(1);
    const dumpCall = s.calls().split("\n").find((l) => l.includes("pg_dump")) ?? "";
    for (const t of ["chunk_embeddings", "summary_embeddings", "embed_queue"]) expect(dumpCall).toContain(`--exclude-table-data=${t}`);
    expect(dumpCall).toContain("-Fc");
    expect(mode(join(dumps, `${sha}.dump`))).toBe(0o600);
    expect(readFileSync(join(dumps, `${sha}.dump`), "utf8")).toBe("PGDMP-fake");
    expect(readdirSync(dumps).filter((f) => f.endsWith(".dump")).length).toBe(3);
    expect(r.err).toContain("002_more.sql");
    expect(r.err).toContain(`/DATA/AppData/cerebro/state/pre-deploy/${sha}.dump`);
    expect(r.out).toContain("migrated: 002_more.sql");
    // The failed release doesn't record its migration list, so the next attempt dumps again.
    expect(readFileSync(s.app("state/migrations"), "utf8").trim()).toBe("001_init.sql");
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
  const status = (o: { pending?: number; dead?: number; lastSuccessMinutes?: number | null; paused?: string | null; dbBytes?: number; summariser?: boolean } = {}) =>
    JSON.stringify({
      machine: "check",
      queue: { pending: o.pending ?? 0, dead: o.dead ?? 0, oldestPendingSeconds: 0 },
      embedder: {
        lastSuccessAt: o.lastSuccessMinutes === null ? null : new Date(Date.now() - (o.lastSuccessMinutes ?? 10) * 60_000).toISOString(),
        lastError: null, pausedUntil: null,
      },
      ...(o.summariser === false ? {} : { summariser: { enabled: true, paused: o.paused ? { reason: o.paused, until: null } : null } }),
      dbBytes: o.dbBytes ?? 5e9,
    });
  const GOOD = {
    FAKE_HEALTH_LAN: healthy, FAKE_HEALTH_LOCAL: healthy, FAKE_TOKEN: TOKEN, FAKE_STATUS: status(),
    FAKE_OLLAMA_LIST: "NAME             ID              SIZE      MODIFIED\nbge-m3:latest    790764642607    1.2 GB    2 days ago",
    FAKE_STATS: "cerebro-db 12.50%\ncerebro-ollama 40.00%\ncerebro-server 20.00%",
    FAKE_TIMER_STATE: "active",
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
      FAKE_STATS: "cerebro-db 95.00%\ncerebro-ollama 40.00%",
      FAKE_TIMER_STATE: "inactive",
    });
    expect(r.code, show(r)).toBe(1);
    expect(r.out).not.toContain("ALL OK");
    for (const name of ["health-lan", "health-local", "instance-id", "queue", "embedder", "summariser", "db-size", "bge-m3", "backup-timer", "backup-age", "memory"])
      expect(r.out, show(r)).toMatch(new RegExp(`^FAIL +${name} `, "m"));
    expect(r.out).toMatch(/^FAIL +embedder +12 pending, last success 120 min ago$/m);
    expect(r.out).toMatch(/^FAIL +memory +cerebro-db at 95\.00% of its limit, cerebro-server not running$/m);
  });

  test("check warns at 120 GB and fails at 150 GB", () => {
    const s = checkSandbox();
    const warn = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ dbBytes: 130e9 }) });
    expect(warn.code, show(warn)).toBe(0);
    expect(warn.out).toMatch(/^warn +db-size /m);
    expect(warn.out).toContain("ALL OK");
  });

  test("check fails the status check without the check token", () => {
    const s = checkSandbox({ token: false });
    const r = s.run("check.sh", [], GOOD);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL +status .*check\.token/m);
  });

  test("an idle embedder with an empty queue is fine", () => {
    const s = checkSandbox();
    const r = s.run("check.sh", [], { ...GOOD, FAKE_STATUS: status({ lastSuccessMinutes: null, pending: 0 }) });
    expect(r.code, show(r)).toBe(0);
  });
});
