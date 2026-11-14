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

const TRUE_WORDS = ["true", "1", "yes", "on"];
const FALSE_WORDS = ["false", "0", "no", "off"];

/** A yes/no setting: true/1/yes/on or false/0/no/off, any case; unset or empty means `fallback`; else a startup error. */
function boolEnv(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (TRUE_WORDS.includes(raw)) return true;
  if (FALSE_WORDS.includes(raw)) return false;
  throw new Error(`${name} must be one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`);
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
      enabled: boolEnv(env, "SUMMARISER_ENABLED", true),
      share: shareEnv(env, "SUMMARY_SHARE", 0.2),
      windowTokens: intEnv(env, "SUBSCRIPTION_TOKENS_PER_5H", 2000000),
      cmd: env.SUMMARISER_CMD || "claude",
    },
  };
}
