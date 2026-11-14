import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEPLOY = join(import.meta.dir, "..");
const REPO = join(DEPLOY, "..");
const COMPOSE = join(DEPLOY, "compose.yml");
const ENV_EXAMPLE = join(DEPLOY, ".env.example");

function run(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const PGVECTOR_IMAGE = /image: (pgvector\/pgvector\S+)/.exec(await Bun.file(COMPOSE).text().catch(() => ""))?.[1] ?? "pgvector/pgvector:0.8.1-pg17";

// The Docker tests need a daemon and a free host port 8790.
const dockerUp = run(["docker", "info"]).code === 0;
const portFree = (() => {
  try {
    Bun.listen({ hostname: "127.0.0.1", port: 8790, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
})();
const dockerTest = dockerUp && portFree ? test : test.skip;

// Temp data and secrets dirs, so `config` can resolve env_file and the stack never touches real data.
const root = mkdtempSync(join(tmpdir(), "cerebro-compose-"));
const data = join(root, "data");
const secrets = join(root, "secrets");
const PW = "testpw";
const PROJECT = `cerebrozimatest${process.pid}`; // never "cerebro": that is the dev stack
const env = { CEREBRO_DATA: data, CEREBRO_SECRETS: secrets, CEREBRO_TAG: "test", COMPOSE_PROJECT_NAME: PROJECT };

beforeAll(() => {
  for (const d of ["db", "ollama", "claude"]) mkdirSync(join(data, d), { recursive: true });
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "server.env"), `DATABASE_URL=postgres://cerebro:${PW}@cerebro-db:5432/cerebro\n`);
  writeFileSync(join(secrets, "db.env"), `POSTGRES_PASSWORD=${PW}\n`);
});

afterAll(() => {
  run(["docker", "compose", "-p", PROJECT, "-f", COMPOSE, "down", "-v", "--remove-orphans"], env);
  // Postgres writes its data dir as another uid; remove it through a container.
  run(["docker", "run", "--rm", "-v", `${root}:/r`, PGVECTOR_IMAGE, "rm", "-rf", "/r/data"]);
  rmSync(root, { recursive: true, force: true });
});

describe("compose config", () => {
  test("compose config is valid and only the server publishes a port, on 127.0.0.1", () => {
    const r = run(["docker", "compose", "-f", COMPOSE, "--env-file", ENV_EXAMPLE, "config", "--format", "json"], env);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out);
    expect(Object.keys(c.services).sort()).toEqual(["db", "ollama", "server"]);
    const { db, ollama, server } = c.services;

    expect(db.ports ?? []).toEqual([]);
    expect(ollama.ports ?? []).toEqual([]);
    expect(server.ports).toHaveLength(1);
    expect(server.ports[0]).toMatchObject({ host_ip: "127.0.0.1", published: "8790", target: 8790 });

    expect(db.image).toMatch(/^pgvector\/pgvector:0\.8\.1-pg17@sha256:[0-9a-f]{64}$/);
    expect(ollama.image).toMatch(/^ollama\/ollama:[\w.-]+@sha256:[0-9a-f]{64}$/);
    expect(server.image).toBe("cerebro-server:test");

    expect(Number(db.shm_size)).toBe(1024 ** 3);
    expect(Number(db.mem_limit)).toBe(2 * 1024 ** 3);
    expect(db.command).toEqual(["postgres", "-c", "config_file=/etc/postgresql/postgres.conf"]);
    expect(db.labels["cerebro.postgres-conf-sha256"]).toBe("unset"); // deploy.sh renders the conf's hash here
    expect(Number(ollama.mem_limit)).toBe(3 * 1024 ** 3);
    expect(Number(ollama.cpus)).toBe(4);
    expect(ollama.environment).toMatchObject({ OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_KEEP_ALIVE: "-1" });
    expect(Number(server.cpus)).toBe(2);
    expect(Number(server.mem_limit)).toBe(1024 ** 3);
    expect(server.environment.EMBED_URL).toBe("http://cerebro-ollama:11434");
    expect(server.depends_on.db.condition).toBe("service_healthy");
    expect(server.depends_on.ollama.condition).toBe("service_started");

    for (const s of [db, ollama, server]) {
      expect(s.restart).toBe("unless-stopped");
      expect(s.memswap_limit).toBe(s.mem_limit); // no swap: the cap is hard
      expect(s.oom_score_adj).toBe(500); // kernel kills Cerebro before AdGuard or the media stack
    }
    expect(Number(db.cpus)).toBe(2);
    expect(db.healthcheck.test.join(" ")).toContain("-h 127.0.0.1"); // TCP, not the first-boot temp server's socket
    expect(db.healthcheck.test.join(" ")).toContain("pg_isready");
    expect(Object.keys(db.networks)).toEqual(["cerebro-net"]);
    expect(Object.keys(ollama.networks)).toEqual(["cerebro-net"]);
    expect(Object.keys(server.networks).sort()).toEqual(["cerebro-net", "default"]);
    expect(c.networks["cerebro-net"].internal).toBe(true);

    const casa = c["x-casaos"];
    expect(casa.hostname).toBe("cerebro.home.lab");
    expect(casa.port_map).toBe("80");
    expect(casa.index).toBe("/health");
    expect(casa.title.en_us).toBe("Cerebro");
  });

  test("the server's stop grace period outlasts the summariser's stop deadline (M5)", async () => {
    const r = run(["docker", "compose", "-f", COMPOSE, "--env-file", ENV_EXAMPLE, "config", "--format", "json"], env);
    expect(r.code).toBe(0);
    const { server } = JSON.parse(r.out).services;
    // stop() lets a Claude call finish for 20 s, then kills it and waits 2 s more (server/src/summarise/loop.ts);
    // Docker's default 10 s would SIGKILL the server mid-shutdown, before the worker and database close.
    const src = await Bun.file(join(REPO, "server/src/summarise/loop.ts")).text();
    const deadline = Number(/const STOP_DEADLINE_MS = ([\d_]+)/.exec(src)?.[1].replaceAll("_", ""));
    const settle = Number(/const STOP_SETTLE_MS = ([\d_]+)/.exec(src)?.[1].replaceAll("_", ""));
    expect(deadline + settle).toBe(22_000);
    expect(server.stop_grace_period).toBe("30s");
    expect(30_000).toBeGreaterThan(deadline + settle + 5_000); // room for the worker stop and sql.close()
  });

  test("postgres.conf carries the tuned settings", async () => {
    const conf = await Bun.file(join(DEPLOY, "postgres.conf")).text();
    const want = [
      "shared_buffers = 512MB", "effective_cache_size = 1536MB", "work_mem = 8MB", "maintenance_work_mem = 256MB",
      "max_parallel_maintenance_workers = 2", "autovacuum_work_mem = 64MB", "autovacuum_max_workers = 2", "max_parallel_workers_per_gather = 1", "max_connections = 40", "default_toast_compression = lz4",
      "wal_compression = lz4", "checkpoint_timeout = 15min", "listen_addresses = '*'",
    ];
    for (const line of want) expect(conf).toContain(line);
  });
});

describe("compose stack (Docker)", () => {
  const dc = (...a: string[]) => run(["docker", "compose", "-p", PROJECT, "-f", COMPOSE, ...a], env);
  const health = () =>
    run(["docker", "exec", "cerebro-server", "bun", "-e", "const r=await fetch('http://127.0.0.1:8790/health');console.log(r.status)"]);
  const psql = (sql: string) => run(["docker", "exec", "cerebro-db", "psql", "-U", "cerebro", "-tAc", sql]);

  // `docker kill` counts as a manual stop and suppresses the restart policy. SIGKILL the container's init
  // from outside instead (like the OOM killer or a crash would); the daemon then restarts it per policy.
  function crash(name: string) {
    const pid = run(["docker", "inspect", "-f", "{{.State.Pid}}", name]).out.trim();
    expect(Number(pid)).toBeGreaterThan(0);
    expect(run(["docker", "run", "--rm", "--privileged", "--pid=host", "--entrypoint", "sh", PGVECTOR_IMAGE, "-c", `kill -9 ${pid}`]).code).toBe(0);
  }

  async function waitHealthy(ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (health().out.trim() === "200") return;
      await Bun.sleep(1500);
    }
    throw new Error("server never became healthy:\n" + dc("logs", "--tail", "40").out);
  }

  dockerTest("the stack comes back after its containers are killed", async () => {
    expect(run(["docker", "build", "-q", "-t", "cerebro-server:test", "-f", "server/Dockerfile", "."]).code).toBe(0);

    expect(dc("up", "-d").code).toBe(0);
    await waitHealthy();
    expect(psql("create table if not exists survive(v text)").code).toBe(0);
    expect(psql("insert into survive values ('kept')").code).toBe(0);
    expect(psql("show shared_buffers").out.trim()).toBe("512MB");

    for (const n of ["cerebro-server", "cerebro-ollama", "cerebro-db"]) expect(run(["docker", "kill", n]).code).toBe(0);
    expect(dc("up", "-d").code).toBe(0); // re-applies depends_on ordering
    await waitHealthy();
    expect(psql("select v from survive").out.trim()).toBe("kept");
    expect(run(["docker", "inspect", "-f", "{{.State.Running}}", "cerebro-ollama"]).out.trim()).toBe("true");
  }, 300_000);

  // A real reboot has no `compose up`: Docker's restart policy starts all three at once.
  dockerTest("the restart policy alone brings the stack back, with the db coming up late", async () => {
    for (const n of ["cerebro-server", "cerebro-ollama", "cerebro-db"]) crash(n);
    // No `compose up`: wait for the restart policy alone.
    await waitHealthy(180_000);
    expect(psql("select v from survive").out.trim()).toBe("kept");
    expect(run(["docker", "inspect", "-f", "{{.State.Running}}", "cerebro-ollama"]).out.trim()).toBe("true");
  }, 300_000);
});
