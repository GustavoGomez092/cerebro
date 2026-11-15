import { loadConfig } from "./config";
import { checkEmbedSettings, connect, migrate } from "./db";
import { createEmbedRouter } from "./embed/failover";
import { createApp } from "./http/app";
import { EmbedGate, newWorkerState, startEmbedWorker } from "./worker";
import { newSummariserState, startSummariser } from "./summarise/loop";

/** Retries `fn` with capped exponential backoff until `waitMs` has elapsed, then rethrows the last error. */
async function retryWithBackoff<T>(fn: () => Promise<T>, waitMs: number, onRetry: (e: Error, delayMs: number) => void): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
    try {
      return await fn();
    } catch (e) {
      const left = deadline - Date.now();
      if (left <= 0) throw e;
      onRetry(e as Error, Math.min(delay, left));
      await Bun.sleep(Math.min(delay, left));
    }
  }
}

/**
 * Validates config, connects, migrates and pins the embedding model. Throws before touching the DB on bad config.
 * After a host reboot the db may start later than the server, so connect+migrate is retried for up to `dbWaitMs`.
 */
export async function buildServer(env: Record<string, string | undefined>, opts: { dbWaitMs?: number } = {}) {
  const config = loadConfig(env);
  if (!config.embedUrl) throw new Error("EMBED_URL is required (Ollama base URL for embeddings)");
  // One router for the worker, search and summaries: each machine's work on its own Ollama (EMBED_MACHINE_URLS),
  // EMBED_URL for the rest and as the fallback. An empty map is EMBED_URL alone, as before.
  const embedder = createEmbedRouter({
    machineUrls: config.embedMachineUrls, fallbackUrl: config.embedUrl, digest: config.embedModelDigest,
    model: config.embedModel, dims: config.embedDims,
  });
  const sql = connect(config.databaseUrl);
  const applied = await retryWithBackoff(
    () => migrate(sql),
    opts.dbWaitMs ?? 120_000,
    (e, delayMs) => console.log(JSON.stringify({ level: "warn", msg: "database not ready, retrying", error: e.name, delayMs })),
  );
  if (applied.length) console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  await checkEmbedSettings(sql, config.embedModel, config.embedDims);
  // A mapped name with no live machine token (a typo, a revoked Mac) leaves that Mac's work on the Zima CPU.
  const mapped = Object.keys(config.embedMachineUrls);
  if (mapped.length) {
    const live = new Set((await sql`select name from machines where revoked_at is null`).map((r: any) => r.name));
    for (const name of mapped.filter((m) => !live.has(m))) {
      console.log(JSON.stringify({ level: "warn", msg: "EMBED_MACHINE_URLS names no machine with a live token; check the name", machine: name }));
    }
  }
  // Confirms the Zima's bge-m3 against EMBED_MODEL_DIGEST before any Mac is used, then probes the Macs in the background.
  await embedder.start();
  const gate = new EmbedGate();
  const workerState = newWorkerState();
  const { enabled, share, windowTokens } = config.summariser;
  const summariser = { state: newSummariserState(enabled), budget: { share, windowTokens } };
  return {
    config, sql, embedder, gate, workerState, summariserState: summariser.state,
    app: createApp({ sql, embedder, gate, workerState, summariser }),
  };
}

if (import.meta.main) {
  try {
    const { config, sql, embedder, gate, workerState, summariserState, app } = await buildServer(process.env);
    const server = Bun.serve({ port: config.port, fetch: app.fetch, maxRequestBodySize: 11 * 1024 * 1024, idleTimeout: 30 });
    const worker = startEmbedWorker(sql, embedder, { state: workerState, gate });
    const summariser = config.summariser.enabled
      ? startSummariser(sql, embedder, config.summariser, { state: summariserState })
      : null;
    console.log(JSON.stringify({ level: "info", msg: "cerebro listening", port: server.port }));
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      server.stop();
      await summariser?.stop(); // waits for the job in progress
      await worker.stop();
      embedder.stop();
      await sql.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (e) {
    console.error(JSON.stringify({ level: "fatal", msg: (e as Error).message }));
    process.exit(1);
  }
}
