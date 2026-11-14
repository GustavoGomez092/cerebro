import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { ollamaEmbedder } from "./embed/ollama";
import { createApp } from "./http/app";
import { startIndexer } from "./indexer";

/** Validates config, connects and migrates. Throws before touching the DB when config is incomplete. */
export async function buildServer(env: Record<string, string | undefined>) {
  const config = loadConfig(env);
  if (!config.embedUrl) throw new Error("EMBED_URL is required (Ollama base URL for embeddings)");
  const embedder = ollamaEmbedder(config.embedUrl, config.embedModel, config.embedDims);
  const sql = connect(config.databaseUrl);
  const applied = await migrate(sql);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
  return { config, sql, embedder, app: createApp({ sql, embedder }) };
}

if (import.meta.main) {
  try {
    const { config, sql, embedder, app } = await buildServer(process.env);
    const server = Bun.serve({ port: config.port, fetch: app.fetch, maxRequestBodySize: 11 * 1024 * 1024 });
    const indexer = startIndexer(sql, embedder);
    console.log(`cerebro listening on :${server.port}`);
    const shutdown = async () => {
      indexer.stop();
      server.stop();
      await sql.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
