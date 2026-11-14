import { EmbedderError, type Embedder, type EmbedRouting, type PrimaryState } from "./embedder";
import { ollamaEmbedder } from "./ollama";

/** How long a failed or mismatched primary is skipped before the next call probes it again. */
export const PRIMARY_DOWN_MS = 60_000;

/**
 * The primary's budget (connect + response) for one call. The Mac mini answers a query in ~0.02 s and embeds
 * ~16 chunks/s (~25,000 chars/s); 2 s covers LAN jitter and a busy GPU but keeps a sleeping Mac (no ARP reply,
 * so the connect hangs instead of being refused) from stalling a search for long: the query-embed budget is
 * QUERY_EMBED_TIMEOUT_MS (6 s), which leaves the fallback ~4 s. Bulk calls add 0.4 ms per char (2,500 chars/s,
 * a tenth of the measured rate), so a 1,600-char chunk gets ~2.6 s; capped at 60 s.
 */
export const PRIMARY_BASE_MS = 2000;
const PRIMARY_MS_PER_CHAR = 0.4;
const PRIMARY_MAX_MS = 60_000;
export function primaryBudgetMs(texts: string[]): number {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return Math.min(PRIMARY_MAX_MS, PRIMARY_BASE_MS + Math.ceil(chars * PRIMARY_MS_PER_CHAR));
}

/** The URL for status and logs: credentials (if any) removed. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "(invalid url)";
  }
}

/** Rejects as soon as `signal` aborts (the shared work keeps going for the other callers). */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new EmbedderError("embedder timed out or was cancelled: aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new EmbedderError("embedder timed out or was cancelled: aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface FailoverOptions {
  /** EMBED_PRIMARY_URL: tried first; null means the fallback alone (today's behaviour). */
  primaryUrl: string | null;
  /** EMBED_URL: the Zima's own Ollama container. */
  fallbackUrl: string;
  model: string;
  dims: number;
  /** EMBED_MODEL_DIGEST (12-hex prefix or full sha256): checked on the primary before use. */
  digest?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  /** The primary's per-call budget (tests shorten it). */
  primaryBudgetMs?: (texts: string[]) => number;
  fetchFn?: typeof fetch;
}

/**
 * Embeds on the primary Ollama when it is reachable (and serves the expected model), else on the fallback.
 * A primary that fails for a reason of its own (unreachable, 5xx/404, over its budget, a malformed answer such
 * as the wrong dims) is retried on the fallback in the same call, then skipped for PRIMARY_DOWN_MS; the next
 * call after that probes it again (re-checking the digest). A bad-input answer (4xx) is surfaced, not retried.
 * The caller's signal cancels whichever request is in flight.
 */
export function failoverEmbedder(o: FailoverOptions): Embedder & { routing(): EmbedRouting } {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const budget = o.primaryBudgetMs ?? primaryBudgetMs;
  const fetchFn = o.fetchFn ?? fetch;
  const fallback = ollamaEmbedder(o.fallbackUrl, o.model, o.dims, fetchFn);
  const primary = o.primaryUrl ? ollamaEmbedder(o.primaryUrl, o.model, o.dims, fetchFn, PRIMARY_MAX_MS) : null;
  const primaryShown = o.primaryUrl ? displayUrl(o.primaryUrl) : null;
  const digest = o.digest ?? null;

  let state: PrimaryState = primary ? "unknown" : "unset";
  let lastError: string | null = null;
  let downUntil = 0;
  let verified = !digest; // the digest has been checked since the primary last came up
  let checking: Promise<boolean> | null = null;
  let lastUsed: EmbedRouting["lastUsed"] = null;

  const setDown = (next: "down" | "digest_mismatch", error: string) => {
    if (state !== next) {
      log(JSON.stringify({
        level: "warn",
        msg: next === "down"
          ? "primary embedder unavailable; embedding on the fallback"
          : "primary embedder model digest mismatch; embedding on the fallback",
        primary: primaryShown, error,
      }));
    }
    state = next;
    lastError = error;
    downUntil = now() + PRIMARY_DOWN_MS;
    verified = !digest;
  };
  const setUp = () => {
    if (state === "down" || state === "digest_mismatch") log(JSON.stringify({ level: "info", msg: "primary embedder back", primary: primaryShown }));
    state = "up";
    lastError = null;
  };

  /** GET /api/tags on the primary: true when the model is there with the expected digest. */
  const checkDigest = async (): Promise<boolean> => {
    const tagsUrl = `${o.primaryUrl!.replace(/\/+$/, "")}/api/tags`;
    let models: { name?: unknown; digest?: unknown }[];
    try {
      const res = await fetchFn(tagsUrl, { signal: AbortSignal.timeout(PRIMARY_BASE_MS) });
      if (!res.ok) throw new Error(`tags returned ${res.status}`);
      const body = (await res.json()) as { models?: unknown };
      if (!Array.isArray(body.models)) throw new Error("tags returned no model list");
      models = body.models;
    } catch (e) {
      setDown("down", `digest check failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
    const m = models.find((x) => x?.name === o.model || x?.name === `${o.model}:latest`);
    const got = typeof m?.digest === "string" ? m.digest.toLowerCase().replace(/^sha256:/, "") : null;
    if (!got) {
      setDown("digest_mismatch", `model ${o.model} not found on the primary`);
      return false;
    }
    if (!got.startsWith(digest!)) {
      setDown("digest_mismatch", `model ${o.model} digest ${got.slice(0, 12)} does not match EMBED_MODEL_DIGEST ${digest!.slice(0, 12)}`);
      return false;
    }
    verified = true;
    return true;
  };

  /** Whether this call should try the primary: not inside a down window, and its digest verified. */
  const primaryUsable = async (signal?: AbortSignal): Promise<boolean> => {
    if ((state === "down" || state === "digest_mismatch") && now() < downUntil) return false;
    if (verified) return true;
    checking ??= checkDigest().finally(() => { checking = null; });
    return abortable(checking, signal);
  };

  const useFallback = async (texts: string[], signal?: AbortSignal) => {
    const v = await fallback.embed(texts, signal);
    lastUsed = "fallback";
    return v;
  };

  return {
    dims: o.dims,
    async embed(texts, signal) {
      if (!primary || !(await primaryUsable(signal))) return useFallback(texts, signal);
      const deadline = AbortSignal.timeout(budget(texts));
      try {
        const v = await primary.embed(texts, signal ? AbortSignal.any([signal, deadline]) : deadline);
        setUp();
        lastUsed = "primary";
        return v;
      } catch (e) {
        if (signal?.aborted) throw e; // the caller gave up: says nothing about the primary
        const err = e as EmbedderError;
        // An error status other than 404/5xx is about the input: the fallback would refuse it too.
        if (!deadline.aborted && !err.transient && err.status !== undefined) {
          setUp(); // it answered
          throw e;
        }
        setDown("down", deadline.aborted ? `no answer within ${budget(texts)} ms` : err.message);
      }
      return useFallback(texts, signal);
    },
    routing: () => ({
      primary: {
        url: primaryShown, state, lastError,
        downUntil: (state === "down" || state === "digest_mismatch") ? new Date(downUntil).toISOString() : null,
      },
      fallback: { url: displayUrl(o.fallbackUrl) },
      lastUsed,
    }),
  };
}
