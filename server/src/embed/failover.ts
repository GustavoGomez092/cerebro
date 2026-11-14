import {
  EmbedderError, type Embedder, type EmbedLane, type EmbedStatus, type EndpointState, type EndpointStatus,
} from "./embedder";
import { ollamaEmbedder } from "./ollama";

/** How long a failed or mismatched endpoint is skipped before the next call probes it again. */
export const PRIMARY_DOWN_MS = 60_000;

/**
 * A machine endpoint's budget (connect + response) for one call. A Mac mini (M4 Pro, Metal) answers a query in
 * ~0.02 s and embeds ~16 chunks/s (~25,000 chars/s); 2 s covers LAN jitter and a busy GPU but keeps a sleeping
 * Mac (no ARP reply, so the connect hangs instead of being refused) from stalling a search for long: the
 * query-embed budget is QUERY_EMBED_TIMEOUT_MS (6 s), which leaves the fallback ~4 s. Bulk calls add 0.4 ms
 * per char (2,500 chars/s, a tenth of the measured rate), so a 1,600-char chunk gets ~2.6 s; capped at 60 s.
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

const cancelled = () => new EmbedderError("embedder timed out or was cancelled: aborted");

/** Rejects as soon as `signal` aborts (the shared work keeps going for the other callers). */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface EndpointOptions {
  url: string;
  /** The machine-token name this endpoint belongs to (null: a single primary). */
  machine?: string | null;
  model: string;
  dims: number;
  /** EMBED_MODEL_DIGEST (12-hex prefix or full sha256): checked before use. */
  digest?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  /** The per-call budget (tests shorten it). */
  primaryBudgetMs?: (texts: string[]) => number;
  fetchFn?: typeof fetch;
}

/**
 * One Ollama that is tried before the fallback, with its own state: a call that fails for a reason of the
 * endpoint's own (unreachable, 5xx/404, over its budget, a malformed answer such as the wrong dims) marks it down
 * for PRIMARY_DOWN_MS; the next call after that probes it again. With a digest, the model is checked (GET
 * /api/tags) before first use and on every probe after it was down: a mismatch or a missing model keeps it out.
 */
export class Endpoint {
  readonly machine: string | null;
  readonly url: string;
  private readonly o: EndpointOptions;
  private readonly ollama: Embedder;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly budget: (texts: string[]) => number;
  private readonly digest: string | null;
  private state: EndpointState = "unknown";
  private lastError: string | null = null;
  private downUntil = 0;
  private lastUsedAt: string | null = null;
  private verified: boolean;
  private checking: Promise<boolean> | null = null;

  constructor(o: EndpointOptions) {
    this.o = o;
    this.machine = o.machine ?? null;
    this.url = displayUrl(o.url);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l: string) => console.log(l));
    this.budget = o.primaryBudgetMs ?? primaryBudgetMs;
    this.digest = o.digest ?? null;
    this.verified = !this.digest;
    this.ollama = ollamaEmbedder(o.url, o.model, o.dims, o.fetchFn ?? fetch, PRIMARY_MAX_MS);
  }

  /** Sitting out a down or mismatch window: not to be tried yet. */
  blocked(): boolean {
    return (this.state === "down" || this.state === "digest_mismatch") && this.now() < this.downUntil;
  }

  get lastFailure(): string | null { return this.lastError; }

  private setDown(next: "down" | "digest_mismatch", error: string) {
    if (this.state !== next) {
      this.log(JSON.stringify({
        level: "warn",
        msg: next === "down"
          ? "machine embedder unavailable; its work waits or uses the fallback"
          : "machine embedder model digest mismatch; its work waits or uses the fallback",
        machine: this.machine, url: this.url, error,
      }));
    }
    this.state = next;
    this.lastError = error;
    this.downUntil = this.now() + PRIMARY_DOWN_MS;
    this.verified = !this.digest;
  }

  private setUp() {
    if (this.state === "down" || this.state === "digest_mismatch") {
      this.log(JSON.stringify({ level: "info", msg: "machine embedder back", machine: this.machine, url: this.url }));
    }
    this.state = "up";
    this.lastError = null;
  }

  /** GET /api/tags: true when the model is there with the expected digest. */
  private async checkDigest(): Promise<boolean> {
    const { model } = this.o;
    let models: { name?: unknown; digest?: unknown }[];
    try {
      const res = await (this.o.fetchFn ?? fetch)(`${this.o.url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(PRIMARY_BASE_MS) });
      if (!res.ok) throw new Error(`tags returned ${res.status}`);
      const body = (await res.json()) as { models?: unknown };
      if (!Array.isArray(body.models)) throw new Error("tags returned no model list");
      models = body.models;
    } catch (e) {
      this.setDown("down", `digest check failed: ${(e as Error)?.message ?? e}`);
      return false;
    }
    const m = models.find((x) => x?.name === model || x?.name === `${model}:latest`);
    const got = typeof m?.digest === "string" ? m.digest.toLowerCase().replace(/^sha256:/, "") : null;
    if (!got) {
      this.setDown("digest_mismatch", `model ${model} not found`);
      return false;
    }
    if (!got.startsWith(this.digest!)) {
      this.setDown("digest_mismatch", `model ${model} digest ${got.slice(0, 12)} does not match EMBED_MODEL_DIGEST ${this.digest!.slice(0, 12)}`);
      return false;
    }
    this.verified = true;
    return true;
  }

  /** Whether a call may try this endpoint now: not inside a down window, and its digest verified. */
  private async usable(signal?: AbortSignal): Promise<boolean> {
    if (this.blocked()) return false;
    if (this.verified) return true;
    this.checking ??= this.checkDigest().finally(() => { this.checking = null; });
    return abortable(this.checking, signal);
  }

  /**
   * Embeds here. Null when the endpoint is not usable or failed (it is then down for PRIMARY_DOWN_MS). The
   * caller's abort and a bad-input answer (an error status other than 404/5xx) are thrown: neither says the
   * endpoint is broken, and the fallback would refuse bad input too.
   */
  async tryEmbed(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
    if (!(await this.usable(signal))) return null;
    const deadline = AbortSignal.timeout(this.budget(texts));
    try {
      const v = await this.ollama.embed(texts, signal ? AbortSignal.any([signal, deadline]) : deadline);
      this.setUp();
      this.lastUsedAt = new Date(this.now()).toISOString();
      return v;
    } catch (e) {
      if (signal?.aborted) throw e;
      const err = e as EmbedderError;
      if (!deadline.aborted && !err.transient && err.status !== undefined) {
        this.setUp(); // it answered
        throw e;
      }
      this.setDown("down", deadline.aborted ? `no answer within ${this.budget(texts)} ms` : err.message);
      return null;
    }
  }

  status(): EndpointStatus {
    const out = this.blocked() || this.state === "down" || this.state === "digest_mismatch";
    return {
      machine: this.machine, url: this.url, state: this.state, lastError: this.lastError,
      downUntil: out ? new Date(this.downUntil).toISOString() : null, lastUsedAt: this.lastUsedAt,
    };
  }
}

/** The fallback (EMBED_URL, the Zima's own Ollama), remembering when it last embedded. */
function trackedFallback(url: string, model: string, dims: number, now: () => number, fetchFn: typeof fetch) {
  const inner = ollamaEmbedder(url, model, dims, fetchFn);
  const t = {
    url: displayUrl(url),
    lastUsedAt: null as string | null,
    embedder: {
      dims,
      async embed(texts: string[], signal?: AbortSignal) {
        const v = await inner.embed(texts, signal);
        t.lastUsedAt = new Date(now()).toISOString();
        return v;
      },
    } as Embedder,
  };
  return t;
}

/** The endpoint first, then the fallback in the same call when the endpoint is not usable or fails. */
function withFallback(endpoint: Endpoint, fallback: Embedder, used: (which: "primary" | "fallback") => void): Embedder {
  return {
    dims: fallback.dims,
    async embed(texts, signal) {
      const v = await endpoint.tryEmbed(texts, signal);
      if (v) { used("primary"); return v; }
      const fb = await fallback.embed(texts, signal);
      used("fallback");
      return fb;
    },
  };
}

/** A single primary in front of a fallback, as used per machine by the router (and testable on its own). */
export interface EmbedRouting {
  primary: { url: string | null; state: EndpointState; lastError: string | null; downUntil: string | null };
  fallback: { url: string };
  lastUsed: "primary" | "fallback" | null;
}

export interface FailoverOptions extends Omit<EndpointOptions, "url" | "machine"> {
  /** Tried first; null means the fallback alone. */
  primaryUrl: string | null;
  fallbackUrl: string;
}

/**
 * Embeds on the primary Ollama when it is reachable (and serves the expected model), else on the fallback.
 * A primary failure of its own is retried on the fallback in the same call; a bad-input answer (4xx) is
 * surfaced, not retried. The caller's signal cancels whichever request is in flight.
 */
export function failoverEmbedder(o: FailoverOptions): Embedder & { routing(): EmbedRouting } {
  const now = o.now ?? Date.now;
  const fb = trackedFallback(o.fallbackUrl, o.model, o.dims, now, o.fetchFn ?? fetch);
  const endpoint = o.primaryUrl ? new Endpoint({ ...o, url: o.primaryUrl, now }) : null;
  let lastUsed: EmbedRouting["lastUsed"] = null;
  const inner = endpoint ? withFallback(endpoint, fb.embedder, (w) => { lastUsed = w; }) : fb.embedder;
  return {
    dims: o.dims,
    async embed(texts, signal) {
      const v = await inner.embed(texts, signal);
      if (!endpoint) lastUsed = "fallback";
      return v;
    },
    routing() {
      const s = endpoint?.status();
      return {
        primary: s ? { url: s.url, state: s.state, lastError: s.lastError, downUntil: s.downUntil }
          : { url: null, state: "unset", lastError: null, downUntil: null },
        fallback: { url: fb.url },
        lastUsed,
      };
    },
  };
}

export interface RouterOptions extends Omit<EndpointOptions, "url" | "machine"> {
  /** EMBED_MACHINE_URLS: machine-token name → that machine's Ollama. */
  machineUrls: Record<string, string>;
  /** EMBED_URL: the Zima's own Ollama, for unmapped machines and whenever a machine's endpoint can't serve. */
  fallbackUrl: string;
}

/**
 * Each machine embeds its own work: `forMachine(name)` is that machine's endpoint with the Zima as fallback
 * (queries and summaries), `lanes()` its endpoint alone (the worker, which leaves a down machine's chunks to wait).
 * Unmapped machines, and `embed` itself, use the Zima. An empty map behaves exactly like the Zima's Ollama alone.
 */
export function createEmbedRouter(o: RouterOptions): Embedder & Required<Pick<Embedder, "forMachine" | "lanes" | "status">> {
  const now = o.now ?? Date.now;
  const fb = trackedFallback(o.fallbackUrl, o.model, o.dims, now, o.fetchFn ?? fetch);
  const endpoints = new Map(Object.entries(o.machineUrls).map(([machine, url]) => [machine, new Endpoint({ ...o, url, machine, now })]));
  const routed = new Map([...endpoints].map(([m, ep]) => [m, withFallback(ep, fb.embedder, () => {})]));
  const lanes: EmbedLane[] = [...endpoints].map(([machine, ep]) => ({
    machine,
    blocked: () => ep.blocked(),
    embedder: {
      dims: o.dims,
      async embed(texts, signal) {
        const v = await ep.tryEmbed(texts, signal);
        if (!v) throw new EmbedderError(`${machine}'s embedder unavailable: ${ep.lastFailure ?? "down"}`, { transient: true });
        return v;
      },
    },
  }));
  return {
    dims: o.dims,
    embed: (texts, signal) => fb.embedder.embed(texts, signal),
    forMachine: (machine) => (machine !== null && routed.get(machine)) || fb.embedder,
    lanes: () => lanes,
    status: (): EmbedStatus => ({
      endpoints: [...endpoints.values()].map((ep) => ep.status()),
      fallback: { url: fb.url, lastUsedAt: fb.lastUsedAt },
    }),
  };
}
