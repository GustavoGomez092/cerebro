export interface Config {
  databaseUrl: string;
  port: number;
  embedUrl: string | null;
  /** Ollama tried first (e.g. the Mac mini's Metal GPU); embedUrl is the fallback. Null: embedUrl only. */
  embedPrimaryUrl: string | null;
  /** Expected model digest on the primary (12-hex prefix or full sha256, lower case), or null for no check. */
  embedModelDigest: string | null;
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

/** An optional http(s) base URL; anything else is a startup error. */
function urlEnv(env: Record<string, string | undefined>, name: string): string | null {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return null;
  let u: URL | null = null;
  try { u = new URL(raw); } catch { /* reported below */ }
  if (!u || !["http:", "https:"].includes(u.protocol) || !u.hostname) throw new Error(`${name} must be an http(s) URL`);
  return raw;
}

/** An Ollama model digest: the 12-hex `ollama list` ID or the full sha256 (an optional `sha256:` prefix is dropped). */
function digestEnv(env: Record<string, string | undefined>, name: string): string | null {
  const raw = (env[name] ?? "").trim().toLowerCase().replace(/^sha256:/, "");
  if (raw === "") return null;
  if (!/^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(raw)) throw new Error(`${name} must be a 12-hex digest prefix or the full sha256`);
  return raw;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl,
    port: intEnv(env, "PORT", 8790),
    embedUrl: urlEnv(env, "EMBED_URL"),
    embedPrimaryUrl: urlEnv(env, "EMBED_PRIMARY_URL"),
    embedModelDigest: digestEnv(env, "EMBED_MODEL_DIGEST"),
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
