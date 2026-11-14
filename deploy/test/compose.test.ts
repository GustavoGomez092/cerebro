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
  run(["docker", "run", "--rm", "-v", `${root}:/r`, "alpine", "rm", "-rf", "/r/data"]);
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
    expect(Number(ollama.mem_limit)).toBe(3 * 1024 ** 3);
    expect(Number(ollama.cpus)).toBe(4);
    expect(ollama.environment).toMatchObject({ OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_KEEP_ALIVE: "-1" });
    expect(Number(server.cpus)).toBe(2);
    expect(Number(server.mem_limit)).toBe(1024 ** 3);
    expect(server.environment.EMBED_URL).toBe("http://cerebro-ollama:11434");
    expect(server.depends_on.db.condition).toBe("service_healthy");
    expect(server.depends_on.ollama.condition).toBe("service_started");

    for (const s of [db, ollama, server]) expect(s.restart).toBe("unless-stopped");
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

  test("postgres.conf carries the tuned settings", async () => {
    const conf = await Bun.file(join(DEPLOY, "postgres.conf")).text();
    const want = [
      "shared_buffers = 512MB", "effective_cache_size = 1536MB", "work_mem = 16MB", "maintenance_work_mem = 256MB",
      "max_parallel_maintenance_workers = 2", "max_connections = 40", "default_toast_compression = lz4",
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

  async function waitHealthy(ms = 120_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (health().out.trim() === "200") return;
      await Bun.sleep(1500);
    }
    throw new Error("server never became healthy:\n" + dc("logs", "--tail", "40").out);
  }

  test("the stack comes back after its containers are killed", async () => {
    expect(run(["docker", "build", "-q", "-t", "cerebro-server:test", "-f", "server/Dockerfile", "."]).code).toBe(0);

    expect(dc("up", "-d").code).toBe(0);
    await waitHealthy();
    expect(psql("create table if not exists survive(v text)").code).toBe(0);
    expect(psql("insert into survive values ('kept')").code).toBe(0);
    expect(psql("show shared_buffers").out.trim()).toBe("512MB");

    for (const n of ["cerebro-server", "cerebro-ollama", "cerebro-db"]) expect(run(["docker", "kill", n]).code).toBe(0);
    expect(dc("up", "-d").code).toBe(0); // what the restart policy does after a reboot
    await waitHealthy();
    expect(psql("select v from survive").out.trim()).toBe("kept");
    expect(run(["docker", "inspect", "-f", "{{.State.Running}}", "cerebro-ollama"]).out.trim()).toBe("true");
  }, 300_000);
});
