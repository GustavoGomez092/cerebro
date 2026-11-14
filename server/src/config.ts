export interface Config {
  databaseUrl: string;
  port: number;
  embedUrl: string | null;
  embedModel: string;
  embedDims: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    port: Number(env.PORT ?? 8790),
    embedUrl: env.EMBED_URL || null,
    embedModel: env.EMBED_MODEL || "bge-m3",
    embedDims: Number(env.EMBED_DIMS ?? 1024),
  };
}
