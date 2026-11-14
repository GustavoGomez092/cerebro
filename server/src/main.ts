import { loadConfig } from "./config";
import { checkEmbedSettings, connect, migrate } from "./db";
import { ollamaEmbedder } from "./embed/ollama";
import { createApp } from "./http/app";
import { EmbedGate, newWorkerState, startEmbedWorker } from "./worker";
import { newSummariserState, startSummariser } from "./summarise/loop";

/** Validates config, connects, migrates and pins the embedding model. Throws before touching the DB on bad config. */
export async function buildServer(env: Record<string, string | undefined>) {
  const config = loadConfig(env);
  if (!config.embedUrl) throw new Error("EMBED_URL is required (Ollama base URL for embeddings)");
  const embedder = ollamaEmbedder(config.embedUrl, config.embedModel, config.embedDims);
  const sql = connect(config.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length) console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  await checkEmbedSettings(sql, config.embedModel, config.embedDims);
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
