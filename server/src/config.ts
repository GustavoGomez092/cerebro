export interface Config {
  databaseUrl: string;
  port: number;
  embedUrl: string | null;
  /**
   * Machine-token name → that machine's own Ollama (e.g. a Mac's Metal GPU): its chunks, summaries and queries
   * embed there, with embedUrl as the fallback. Empty: embedUrl for everything.
   */
  embedMachineUrls: Record<string, string>;
  /** Expected model digest on every machine endpoint (12-hex prefix or full sha256, lower case), or null. */
  embedModelDigest: string | null;
  embedModel: string;
  embedDims: number;
  /** `workers`: summariser loops running at once (one primary, the rest job-only helpers; SUMMARISER_WORKERS). */
  summariser: { enabled: boolean; share: number; windowTokens: number; cmd: string; workers: number };
  /** The dashboard's chat agent: `claude -p` on the same subscription login as the summariser (SUMMARISER_CMD). */
  chat: { model: string; timeoutMs: number; maxConcurrent: number };
}

/**
 * The web dashboard's machine token (`token create web-ui`). It may call /v1/dashboard/* and nothing else, and no
 * other token may call those (http/app.ts). It never uploads sessions and is never an embed lane (refused in
 * EMBED_MACHINE_URLS below), so its searches embed on the Zima.
 */
export const WEB_UI_MACHINE = "web-ui";
const WEB_UI = WEB_UI_MACHINE;

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

function rangeEnv(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** A model alias or id for `claude --model` (sonnet, opus, claude-sonnet-4-5…): one word, no flags. */
function modelEnv(env: Record<string, string | undefined>, name: string, fallback: string): string {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(raw)) throw new Error(`${name} must be a model alias or id, such as sonnet`);
  return raw;
}

const isHttpUrl =(raw: string) => {
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
};

/** An optional http(s) base URL; anything else is a startup error. */
function urlEnv(env: Record<string, string | undefined>, name: string): string | null {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return null;
  if (!isHttpUrl(raw)) throw new Error(`${name} must be an http(s) URL`);
  return raw;
}

/** `name=url,name=url` (spaces and a trailing comma allowed); each name once, each URL http(s). */
function machineUrlsEnv(env: Record<string, string | undefined>, name: string): Record<string, string> {
  const out = new Map<string, string>();
  for (const pair of (env[name] ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const machine = eq > 0 ? pair.slice(0, eq).trim() : "";
    const url = eq > 0 ? pair.slice(eq + 1).trim() : "";
    if (!machine || !url) throw new Error(`${name} must be machine=url pairs separated by commas`);
    if (!isHttpUrl(url)) throw new Error(`${name}: the URL for ${machine} must be an http(s) URL`);
    if (out.has(machine)) throw new Error(`${name} names ${machine} twice`);
    if (machine === WEB_UI) throw new Error(`${name} may not name ${WEB_UI}: the dashboard's token is not a Mac and never embeds`);
    out.set(machine, url);
  }
  return Object.fromEntries(out);
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
  const embedMachineUrls = machineUrlsEnv(env, "EMBED_MACHINE_URLS");
  const embedModelDigest = digestEnv(env, "EMBED_MODEL_DIGEST");
  // Without a pinned digest a Mac serving another model under the same name would mix its vectors with the Zima's.
  if (Object.keys(embedMachineUrls).length && !embedModelDigest) {
    throw new Error("EMBED_MODEL_DIGEST is required when EMBED_MACHINE_URLS is set (bge-m3's digest, as BGE_M3_DIGEST)");
  }
  return {
    databaseUrl,
    port: intEnv(env, "PORT", 8790),
    embedUrl: urlEnv(env, "EMBED_URL"),
    embedMachineUrls,
    embedModelDigest,
    embedModel: env.EMBED_MODEL || "bge-m3",
    embedDims: intEnv(env, "EMBED_DIMS", 1024),
    summariser: {
      enabled: boolEnv(env, "SUMMARISER_ENABLED", true),
      share: shareEnv(env, "SUMMARY_SHARE", 0.2),
      windowTokens: intEnv(env, "SUBSCRIPTION_TOKENS_PER_5H", 2000000),
      cmd: env.SUMMARISER_CMD || "claude",
      workers: rangeEnv(env, "SUMMARISER_WORKERS", 1, 1, 8),
    },
    chat: {
      model: modelEnv(env, "CHAT_MODEL", "sonnet"),
      timeoutMs: intEnv(env, "CHAT_TIMEOUT_MS", 300_000),
      maxConcurrent: rangeEnv(env, "CHAT_MAX_CONCURRENT", 1, 1, 2),
    },
  };
}
