export interface Config {
  databaseUrl: string;
  port: number;
  embedUrl: string | null;
  embedModel: string;
  embedDims: number;
  summariser: { enabled: boolean; share: number; windowTokens: number; cmd: string };
}

function shareEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) throw new Error(`${name} must be a number in (0, 1]`);
  return n;
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
    summariser: {
      enabled: !["false", "0"].includes((env.SUMMARISER_ENABLED ?? "").toLowerCase()),
      share: shareEnv(env, "SUMMARY_SHARE", 0.2),
      windowTokens: intEnv(env, "SUBSCRIPTION_TOKENS_PER_5H", 2000000),
      cmd: env.SUMMARISER_CMD || "claude",
    },
  };
}
