export interface Config {
  databaseUrl: string;
  port: number;
  embedUrl: string | null;
  embedModel: string;
  embedDims: number;
}

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    port: intEnv(env, "PORT", 8790),
    embedUrl: env.EMBED_URL || null,
    embedModel: env.EMBED_MODEL || "bge-m3",
    embedDims: intEnv(env, "EMBED_DIMS", 1024),
  };
}
