import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ZIMA = join(import.meta.dir, "..");
const DEPLOY = join(ZIMA, "..");
const REPO = join(DEPLOY, "..");
const COMPOSE_SRC = await Bun.file(join(DEPLOY, "compose.yml")).text();
const IMAGE = /image: (pgvector\/pgvector\S+)/.exec(COMPOSE_SRC)?.[1] ?? "pgvector/pgvector:0.8.1-pg17";

function run(cmd: string[], env: Record<string, string> = {}, input?: Uint8Array) {
  const p = Bun.spawnSync(cmd, { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: input });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const dockerUp = run(["docker", "info"]).code === 0;
const dockerTest = dockerUp ? test : test.skip;

// Throwaway compose project with only the database: unique name, never "cerebro", random published port.
const PROJECT = `cerebrobackuptest${process.pid}`;
const DB = `${PROJECT}-db`;
const root = mkdtempSync(join(tmpdir(), "cerebro-backup-"));
const composeFile = join(root, "compose.yml");
const PW = "testpw";
const SERVER = `${PROJECT}-server`;
const SHIM_LOG = join(root, "shim.log");
const REAL_DOCKER = Bun.which("docker") ?? "docker";
let dbUrl = "";

const psql = (sql: string, db = "cerebro") => run(["docker", "exec", DB, "psql", "-U", "cerebro", "-d", db, "-tAc", sql]);
const count = (table: string, db = "cerebro") => Number(psql(`select count(*) from ${table}`, db).out.trim());
const TABLES = ["clients", "projects", "bindings", "sessions", "events", "chunks"];

// Env for the scripts under test. The mount check points at "/" (always a mountpoint) unless a test says otherwise;
// no free-space reserve unless a test sets one ("" = the script's default), so the dev disk's free space doesn't matter.
function senv(target: string, extra: Record<string, string> = {}) {
  return { CEREBRO_DB_CONTAINER: DB, CEREBRO_BACKUP_ROOT: target, CEREBRO_BACKUP_MOUNT: "/", CEREBRO_BACKUP_RESERVE_GB: "0", ...extra };
}
const GB_KB = 1024 * 1024;
const backup = (target: string, extra: Record<string, string> = {}) => run(["bash", join(ZIMA, "backup.sh")], senv(target, extra));
const dumps = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".dump")).sort() : []);

beforeAll(async () => {
  if (!dockerUp) return;
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "bun"), `#!/bin/sh
n=$(psql "$DATABASE_URL" -tAc "with q as (insert into embed_queue (chunk_id, priority) select id, 1 from chunks c where not exists (select 1 from chunk_embeddings e where e.chunk_id = c.id) on conflict do nothing returning 1) select count(*) from q")
echo "queued $n chunk(s) for embedding"
`, { mode: 0o755 });
  mkdirSync(join(root, "shim"));
  writeFileSync(join(root, "shim", "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "${SHIM_LOG}"
exec "${REAL_DOCKER}" "$@"
`, { mode: 0o755 });
  writeFileSync(composeFile, `name: ${PROJECT}
services:
  db:
    container_name: ${DB}
    image: ${IMAGE}
    environment: { POSTGRES_USER: cerebro, POSTGRES_DB: cerebro, POSTGRES_PASSWORD: ${PW} }
    ports: ["127.0.0.1::5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U cerebro -d cerebro"], interval: 2s, timeout: 3s, retries: 40 }
  server: # stand-in for cerebro-server: same DATABASE_URL shape, and a fake bun that queues like requeue-missing-embeddings
    container_name: ${SERVER}
    image: ${IMAGE}
    entrypoint: ["sleep", "infinity"]
    environment: { DATABASE_URL: "postgres://cerebro:${PW}@db:5432/cerebro" }
    volumes: ["${root}/bin/bun:/usr/local/bin/bun:ro"]
    depends_on: { db: { condition: service_healthy } }
`);
  expect(run(["docker", "compose", "-f", composeFile, "up", "-d", "--wait"]).code).toBe(0);
  const port = run(["docker", "port", DB, "5432/tcp"]).out.trim().split("\n")[0].split(":").pop();
  dbUrl = `postgres://cerebro:${PW}@127.0.0.1:${port}/cerebro`;
  // Real schema through the real migration runner.
  const m = run(["bun", "server/src/cli.ts", "migrate"], { DATABASE_URL: dbUrl });
  expect(m.err).toBe("");
  expect(m.code).toBe(0);
  const seed = `
    insert into projects (client_id, name) select id, 'P' from clients limit 1;
    insert into machines (name, token_hash) values ('m', 'h');
    insert into bindings (repo, status, client_id) select 'r', 'active', id from clients limit 1;
    insert into sessions (id, binding_id, machine_id, cwd, repo, started_at)
      select 's1', b.id, m.id, '/x', 'r', now() from bindings b, machines m limit 1;
    insert into events (session_id, key, seq, ts, kind, text) select 's1', 'k' || g, g, now(), 'user', 'hello ' || g from generate_series(1, 25) g;
    insert into chunks (session_id, first_seq, last_seq, ts_from, ts_to, text) select 's1', g, g, now(), now(), 'chunk ' || g from generate_series(1, 40) g;
    insert into chunk_embeddings (chunk_id, embedding) select id, array_fill(0.5::real, array[1024])::halfvec from chunks where first_seq <= 3;
    insert into embed_queue (chunk_id, priority) select id, 0 from chunks where first_seq = 4;`;
  const s = psql(seed);
  expect(s.err).toBe("");
  expect(s.code).toBe(0);
}, 180_000);

afterAll(() => {
  if (dockerUp) run(["docker", "compose", "-f", composeFile, "down", "-v", "--remove-orphans"]);
  rmSync(root, { recursive: true, force: true });
});

describe("backup.sh", () => {
  dockerTest("nightly dump excludes embedding data and restores to equal row counts", () => {
    const target = join(root, "t1");
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-11", CEREBRO_BACKUP_DOW: "3" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const file = join(target, "nightly", "2026-11-11.dump");
    expect(dumps(join(target, "nightly"))).toEqual(["2026-11-11.dump"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, "nightly")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(target, "weekly"))).toBe(false); // Wednesday: no full dump

    run(["docker", "exec", DB, "createdb", "-U", "cerebro", "t1restore"]);
    const rs = run(["docker", "exec", "-i", DB, "pg_restore", "-U", "cerebro", "-d", "t1restore", "--exit-on-error"], {}, readFileSync(file));
    expect(rs.err).toBe("");
    expect(rs.code).toBe(0);
    for (const t of TABLES) expect(count(t, "t1restore")).toBe(count(t));
    expect(count("chunks", "t1restore")).toBe(40);
    expect(count("chunk_embeddings", "t1restore")).toBe(0); // rebuildable, so not in nightlies
    expect(count("embed_queue", "t1restore")).toBe(0);
    expect(count("chunk_embeddings")).toBe(3); // and production still has them
    run(["docker", "exec", DB, "dropdb", "-U", "cerebro", "t1restore"]);
  }, 120_000);

  dockerTest("sunday adds a full weekly dump that keeps the embeddings", () => {
    const target = join(root, "t2");
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-15", CEREBRO_BACKUP_DOW: "7" }).code).toBe(0);
    expect(dumps(join(target, "nightly"))).toEqual(["2026-11-15.dump"]);
    expect(dumps(join(target, "weekly"))).toEqual(["2026-11-15.dump"]);
    const data = run(["docker", "exec", "-i", DB, "pg_restore", "-U", "cerebro", "-a", "-t", "chunk_embeddings", "-f", "-"], {}, readFileSync(join(target, "weekly", "2026-11-15.dump")));
    expect((data.out.match(/^[0-9]+\t\[/gm) ?? []).length).toBe(3);
  }, 120_000);

  dockerTest("retention keeps 14 nightly and 4 weekly", () => {
    const target = join(root, "t3");
    for (const [dir, n] of [["nightly", 20], ["weekly", 6]] as const) {
      mkdirSync(join(target, dir), { recursive: true });
      for (let i = 1; i <= n; i++) writeFileSync(join(target, dir, `2026-10-${String(i).padStart(2, "0")}.dump`), "old");
    }
    writeFileSync(join(target, "nightly", "notes.txt"), "not a dump"); // never touched
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-15", CEREBRO_BACKUP_DOW: "7" }).code).toBe(0);
    const nightly = dumps(join(target, "nightly"));
    const weekly = dumps(join(target, "weekly"));
    expect(nightly).toHaveLength(14);
    expect(nightly.at(-1)).toBe("2026-11-15.dump"); // newest kept
    expect(nightly[0]).toBe("2026-10-08.dump"); // 13 newest old ones survive
    expect(weekly).toHaveLength(4);
    expect(weekly.at(-1)).toBe("2026-11-15.dump");
    expect(weekly[0]).toBe("2026-10-04.dump");
    expect(existsSync(join(target, "nightly", "notes.txt"))).toBe(true);
  }, 120_000);

  dockerTest("backup refuses when the target lacks space", () => {
    const target = join(root, "t4");
    mkdirSync(join(target, "nightly"), { recursive: true });
    run(["truncate", "-s", "200T", join(target, "nightly", "2026-11-01.dump")]); // sparse: "last dump" far bigger than any free space
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-02", CEREBRO_BACKUP_DOW: "1" });
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/not enough free space/i);
    expect(dumps(join(target, "nightly"))).toEqual(["2026-11-01.dump"]); // nothing written, nothing pruned
    expect(readdirSync(join(target, "nightly")).some((f) => f.includes("tmp"))).toBe(false);
  }, 60_000);

  dockerTest("first run with no earlier dump still checks the database size against free space", () => {
    const target = join(root, "t4b");
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-02", CEREBRO_BACKUP_DOW: "1", CEREBRO_BACKUP_AVAIL_KB: "1" });
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/not enough free space/i);
    expect(dumps(join(target, "nightly"))).toEqual([]);
  }, 60_000);

  dockerTest("the default 20 GB reserve on the shared drive is never used", () => {
    const target = join(root, "t4r");
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-02", CEREBRO_BACKUP_DOW: "1", CEREBRO_BACKUP_RESERVE_GB: "", CEREBRO_BACKUP_AVAIL_KB: String(20 * GB_KB + 1) });
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out + r.err).toMatch(/not enough free space.*20 GB reserve/i);
    expect(dumps(join(target, "nightly"))).toEqual([]);
    const ok = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-02", CEREBRO_BACKUP_DOW: "1", CEREBRO_BACKUP_RESERVE_GB: "", CEREBRO_BACKUP_AVAIL_KB: String(21 * GB_KB) });
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(dumps(join(target, "nightly"))).toEqual(["2026-11-02.dump"]);
  }, 60_000);

  dockerTest("the estimate is the newest dump of the same kind, not the biggest of any kind", () => {
    const target = join(root, "t4e");
    mkdirSync(join(target, "nightly"), { recursive: true });
    mkdirSync(join(target, "weekly"), { recursive: true });
    run(["truncate", "-s", "200T", join(target, "nightly", "2026-10-01.dump")]); // old and huge
    writeFileSync(join(target, "nightly", "2026-10-02.dump"), "PGDMP-small"); // the newest nightly
    run(["truncate", "-s", "200T", join(target, "weekly", "2026-09-27.dump")]); // weekly: not taken on a Wednesday
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-11", CEREBRO_BACKUP_DOW: "3", CEREBRO_BACKUP_AVAIL_KB: String(GB_KB) });
    expect(r.code, r.out + r.err).toBe(0);
    expect(dumps(join(target, "nightly"))).toContain("2026-11-11.dump");
  }, 60_000);

  dockerTest("on Sundays the nightly and the full dump must both fit above the reserve", () => {
    const target = join(root, "t4s");
    mkdirSync(join(target, "weekly"), { recursive: true });
    run(["truncate", "-s", "15G", join(target, "weekly", "2026-11-08.dump")]); // last full dump: 15 GB
    const env = { CEREBRO_BACKUP_DATE: "2026-11-15", CEREBRO_BACKUP_DOW: "7", CEREBRO_BACKUP_RESERVE_GB: "20" };
    const r = backup(target, { ...env, CEREBRO_BACKUP_AVAIL_KB: String(30 * GB_KB) }); // 30 < 20 + 15 + nightly
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out + r.err).toMatch(/not enough free space/i);
    expect(dumps(join(target, "nightly"))).toEqual([]);
    const ok = backup(target, { ...env, CEREBRO_BACKUP_AVAIL_KB: String(36 * GB_KB) });
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(dumps(join(target, "weekly"))).toContain("2026-11-15.dump");
  }, 60_000);

  // pg_isready fails FLAKY_FAILS times (as right after a power loss, when Persistent=true fires the timer at boot).
  function flakyDocker() {
    const dir = join(root, "flaky");
    if (!existsSync(dir)) {
      mkdirSync(dir);
      writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$*" in *pg_isready*)
  n=$(cat "$FLAKY_COUNT" 2>/dev/null || echo 0); echo $((n + 1)) > "$FLAKY_COUNT"
  [ "$n" -ge "$FLAKY_FAILS" ] || exit 2 ;;
esac
exec "${REAL_DOCKER}" "$@"
`, { mode: 0o755 });
    }
    return { PATH: `${dir}:${process.env.PATH}`, FLAKY_COUNT: join(root, `flaky-count-${Math.random()}`) };
  }

  dockerTest("backup waits for the database to accept connections before dumping", () => {
    const target = join(root, "t4w");
    const env = flakyDocker();
    const r = backup(target, { ...env, FLAKY_FAILS: "2", CEREBRO_BACKUP_DATE: "2026-11-11", CEREBRO_BACKUP_DOW: "3" });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/waiting for the database/i);
    expect(Number(readFileSync(env.FLAKY_COUNT, "utf8"))).toBe(3);
    expect(dumps(join(target, "nightly"))).toEqual(["2026-11-11.dump"]);
  }, 60_000);

  dockerTest("backup gives up when the database never becomes ready", () => {
    const target = join(root, "t4x");
    const r = backup(target, { ...flakyDocker(), FLAKY_FAILS: "1000", CEREBRO_BACKUP_DB_WAIT: "3", CEREBRO_BACKUP_DATE: "2026-11-11", CEREBRO_BACKUP_DOW: "3" });
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/database not ready after 3 s/);
    expect(dumps(join(target, "nightly"))).toEqual([]);
  }, 60_000);

  dockerTest("an empty weekly directory does not fail the run, and stale tmp files are removed", () => {
    const target = join(root, "t4c");
    mkdirSync(join(target, "weekly"), { recursive: true });
    mkdirSync(join(target, "nightly"), { recursive: true });
    writeFileSync(join(target, "weekly", ".2026-01-04.dump.tmp"), "partial");
    writeFileSync(join(target, "nightly", ".2026-01-05.dump.tmp"), "partial");
    const r = backup(target, { CEREBRO_BACKUP_DATE: "2026-11-11", CEREBRO_BACKUP_DOW: "3" });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readdirSync(join(target, "weekly"))).toEqual([]);
    expect(readdirSync(join(target, "nightly"))).toEqual(["2026-11-11.dump"]);
  }, 60_000);

  dockerTest("backup skips with a logged reason when the drive is not mounted", () => {
    const target = join(root, "t5");
    const notMounted = join(root, "plain-dir");
    mkdirSync(notMounted);
    const r = backup(target, { CEREBRO_BACKUP_MOUNT: notMounted });
    expect(r.code).toBe(0);
    expect(r.out + r.err).toMatch(/not mounted/i);
    expect(existsSync(target)).toBe(false);
  }, 60_000);
});

describe("restore-test.sh", () => {
  // Local stand-in for `docker exec cerebro-server bun … requeue-missing-embeddings` on the scratch database.
  const requeue = () => `DATABASE_URL="${dbUrl.replace(/\/cerebro$/, "")}/$SCRATCH_DB" bun server/src/cli.ts requeue-missing-embeddings`;
  const restoreTest = (target: string) => run(["bash", join(ZIMA, "restore-test.sh")], senv(target, { CEREBRO_REQUEUE_CMD: requeue() }));
  // The default requeue path (docker exec into the server container), with docker wrapped to record host-side args.
  const restoreTestViaServer = (target: string, extra: Record<string, string> = {}) =>
    run(["bash", join(ZIMA, "restore-test.sh")], senv(target, { CEREBRO_SERVER_CONTAINER: SERVER, PATH: `${join(root, "shim")}:${process.env.PATH}`, SHIM_LOG, REAL_DOCKER, ...extra }));
  const scratchDbs = () => psql("select datname from pg_database where datname like 'cerebro_restoretest%'").out.trim();

  dockerTest("restore-test rebuilds embeddings via requeue", () => {
    const target = join(root, "t6");
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-12", CEREBRO_BACKUP_DOW: "4" }).code).toBe(0);
    const r = restoreTestViaServer(target);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("chunks: production 40, restored 40");
    const hostArgs = readFileSync(SHIM_LOG, "utf8");
    // The restore shares production's 2 GB container: index builds get a small, serial maintenance budget.
    const restoreCall = hostArgs.split("\n").find((l) => l.includes("pg_restore -U")) ?? "<no pg_restore>";
    expect(restoreCall).toContain("PGOPTIONS=-c maintenance_work_mem=64MB -c max_parallel_maintenance_workers=0");
    expect(hostArgs).toContain("requeue-missing-embeddings"); // the shim did see the server call...
    expect(hostArgs).not.toContain(PW); // ...and the production URL (with its password) never reached host args
    expect(hostArgs).not.toContain("postgres://");
    expect(r.out).toMatch(/queued 40 chunk/); // nightlies carry no vectors, so every chunk is re-queued
    expect(r.out).toMatch(/restore test passed/i);
    expect(scratchDbs()).toBe(""); // scratch database dropped
    expect(count("chunk_embeddings")).toBe(3); // production untouched
  }, 180_000);

  dockerTest("restore-test fails when the dump is far from production, and still drops the scratch db", () => {
    const target = join(root, "t7");
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-12", CEREBRO_BACKUP_DOW: "4" }).code).toBe(0);
    psql("delete from chunks where first_seq > 10"); // 30 rows gone since the dump: beyond tolerance
    try {
      const r = restoreTest(target);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toMatch(/chunks.*differ/i);
      expect(scratchDbs()).toBe("");
    } finally {
      psql("insert into chunks (session_id, first_seq, last_seq, ts_from, ts_to, text) select 's1', g, g, now(), now(), 'chunk ' || g from generate_series(11, 40) g");
    }
  }, 180_000);

  dockerTest("restore-test sweeps day-old scratch databases but leaves recent ones, and refuses a scratch name equal to production", () => {
    const target = join(root, "t9");
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-12", CEREBRO_BACKUP_DOW: "4" }).code).toBe(0);
    const fresh = `cerebro_restoretest_${Math.floor(Date.now() / 1000)}_1`;
    run(["docker", "exec", DB, "createdb", "-U", "cerebro", "cerebro_restoretest_1000_1"]);
    run(["docker", "exec", DB, "createdb", "-U", "cerebro", fresh]);
    try {
      const r = restoreTest(target);
      expect(r.code).toBe(0);
      expect(r.out).toContain("dropping leftover scratch database cerebro_restoretest_1000_1");
      expect(scratchDbs().split("\n")).toEqual([fresh]);
    } finally {
      run(["docker", "exec", DB, "dropdb", "-U", "cerebro", "--if-exists", fresh]);
    }
    const same = run(["bash", join(ZIMA, "restore-test.sh")], senv(target, { CEREBRO_SCRATCH_DB: "cerebro" }));
    expect(same.code).toBe(1);
    expect(same.out + same.err).toMatch(/equals the production database/);
  }, 180_000);

  dockerTest("restore-test restores the newest nightly", () => {
    const target = join(root, "t10");
    expect(backup(target, { CEREBRO_BACKUP_DATE: "2026-11-12", CEREBRO_BACKUP_DOW: "4" }).code).toBe(0);
    writeFileSync(join(target, "nightly", "2026-11-01.dump"), "not an archive"); // older: never picked
    const r = restoreTest(target);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain("nightly/2026-11-12.dump");
  }, 180_000);

  dockerTest("restore-test refuses when there is no nightly dump", () => {
    const r = restoreTest(join(root, "t8"));
    expect(r.code).toBe(1);
    expect(r.out + r.err).toMatch(/no nightly dump/i);
  }, 60_000);
});

describe("systemd units", () => {
  const unit = (f: string) => readFileSync(join(ZIMA, "systemd", f), "utf8");
  test("timer runs daily at 03:20, between postgres-backup (03:10) and zima-backup (03:30)", () => {
    const t = unit("cerebro-backup.timer");
    expect(t).toContain("OnCalendar=*-*-* 03:20:00");
    expect(t).toContain("Persistent=true");
    expect(t).toContain("WantedBy=timers.target");
  });
  test("service is a root oneshot running backup.sh", () => {
    const s = unit("cerebro-backup.service");
    expect(s).toContain("Type=oneshot");
    expect(s).toMatch(/ExecStart=\/DATA\/AppData\/cerebro\/zima\/backup\.sh/);
    expect(s).toContain("RequiresMountsFor=/DATA/Backup");
  });
});

describe("exclude-from-zima-backup.sh", () => {
  const SAMPLE = `#!/bin/bash
set -euo pipefail
DEST=/DATA/Backup/snapshots/$(date +%F)
rsync -aH --delete --link-dest="$LAST" \\
    --exclude '/DATA/AppData/jellyfin/cache' \\
    --exclude '/DATA/AppData/postgres/data/' \\
    --exclude '/DATA/AppData/hermes/tmp' \\
    /DATA/AppData /var/lib/casaos/apps "$DEST/"
echo done
`;
  const exclude = (file: string) => run(["bash", join(ZIMA, "exclude-from-zima-backup.sh"), file]);
  const backups = (f: string) => readdirSync(root).filter((n) => n.startsWith(`${f}.bak-cerebro-`));
  const occurrences = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  // The data dir as deploy/zima/lib.sh defines it (db, ollama models and the Claude login all live under it).
  const DATA = run(["bash", "-c", `source ${join(ZIMA, "lib.sh")}; printf %s "$DATA"`]).out;
  const LINE = `    --exclude '${DATA}/' \\\n`;
  const PG_LINE = "    --exclude '/DATA/AppData/postgres/data/' \\\n";

  test("lib.sh's data dir is the one the exclusion covers", () => {
    expect(DATA).toBe("/DATA/AppData/cerebro/data");
  });

  test("adds the cerebro data exclude once, next to the postgres one, and keeps the script valid", () => {
    const f = join(root, "zima-backup.sh");
    writeFileSync(f, SAMPLE);
    expect(exclude(f).code).toBe(0);
    const once = readFileSync(f, "utf8");
    expect(exclude(f).code).toBe(0); // idempotent
    expect(readFileSync(f, "utf8")).toBe(once);
    expect(once).toContain(PG_LINE + LINE);
    expect(occurrences(once, /cerebro/g)).toBe(1);
    expect(once.replace(LINE, "")).toBe(SAMPLE); // nothing else changed
    expect(run(["bash", "-n", f]).code).toBe(0);
    const [bak, ...rest] = backups("zima-backup.sh");
    expect(rest).toEqual([]); // the idempotent second run made no second backup
    expect(readFileSync(join(root, bak), "utf8")).toBe(SAMPLE);
  });

  test("an earlier wrong pair (cerebro/db, cerebro/ollama) is replaced by the data exclude", () => {
    const f = join(root, "old-pair.sh");
    const old = SAMPLE.replace(PG_LINE, PG_LINE + "    --exclude '/DATA/AppData/cerebro/db/' \\\n    --exclude '/DATA/AppData/cerebro/ollama/' \\\n");
    writeFileSync(f, old);
    const r = exclude(f);
    expect(r.code, r.out + r.err).toBe(0);
    const out = readFileSync(f, "utf8");
    expect(out).toBe(SAMPLE.replace(PG_LINE, PG_LINE + LINE));
    expect(run(["bash", "-n", f]).code).toBe(0);
    expect(readFileSync(join(root, backups("old-pair.sh")[0]), "utf8")).toBe(old);
    expect(exclude(f).code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(out);
  });

  test("a half-applied wrong pair is replaced too, and comments do not count", () => {
    const f = join(root, "half.sh");
    const half = SAMPLE.replace(PG_LINE, PG_LINE + "    --exclude '/DATA/AppData/cerebro/db/' \\\n")
      .replace("#!/bin/bash\n", "#!/bin/bash\n# TODO exclude /DATA/AppData/cerebro/data/ someday\n");
    writeFileSync(f, half);
    expect(exclude(f).code).toBe(0);
    const out = readFileSync(f, "utf8");
    expect(occurrences(out, /--exclude '\/DATA\/AppData\/cerebro\/data\/'/g)).toBe(1);
    expect(out).not.toContain("cerebro/db");
    expect(out).toContain("# TODO exclude /DATA/AppData/cerebro/data/ someday");
    expect(run(["bash", "-n", f]).code).toBe(0);
  });

  test("a commented-out postgres exclude is not mirrored", () => {
    const f = join(root, "commented.sh");
    writeFileSync(f, "#!/bin/bash\n# --exclude '/DATA/AppData/postgres/data'\necho hi\n");
    expect(exclude(f).code).toBe(1);
  });

  test("never overwrites the script with a result that does not parse", () => {
    const f = join(root, "broken.sh");
    const broken = SAMPLE + "if true; then\n"; // already invalid bash
    writeFileSync(f, broken);
    const r = exclude(f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/would not parse/);
    expect(readFileSync(f, "utf8")).toBe(broken);
    expect(backups("broken.sh")).toEqual([]);
  });

  test("refuses to guess when the script has no postgres exclude to mirror", () => {
    const f = join(root, "other.sh");
    writeFileSync(f, "#!/bin/bash\necho hi\n");
    const r = exclude(f);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/postgres/);
    expect(readFileSync(f, "utf8")).toBe("#!/bin/bash\necho hi\n");
  });
});
