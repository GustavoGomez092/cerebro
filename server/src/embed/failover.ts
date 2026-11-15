import {
  EmbedderError, type Embedder, type EmbedLane, type EmbedStatus, type EndpointState, type EndpointStatus, type FallbackState,
} from "./embedder";
import { ollamaEmbedder } from "./ollama";

/** How long a failed or mismatched endpoint is skipped before a background probe tries it again. */
export const PRIMARY_DOWN_MS = 60_000;
/** While an endpoint is up, its model digest is re-read this often (a cheap GET /api/tags), as is the Zima's. */
export const DIGEST_RECHECK_MS = 5 * 60_000;
/** While the Zima's digest is unconfirmed (unreachable, mismatched), it is re-read this often. */
const FALLBACK_RETRY_MS = 30_000;
/** How often the background prober looks for due probes. */
const PROBE_TICK_MS = 5_000;
/** GET /api/tags budget. */
const TAGS_TIMEOUT_MS = 2_000;
/** A probe's embed: known text, so a failure is the endpoint's and not a chunk's. */
const CANARY = "cerebro embedder health check";

/**
 * How long a caller that can fall back (a search query, a summary) waits for a Mac before it uses the Zima. A Mac
 * mini (M4 Pro, Metal) answers a query in ~0.02 s warm and ~1.6 s cold (model reload); 2 s covers both and LAN
 * jitter while leaving ~4 s of the search's 6 s QUERY_EMBED_TIMEOUT_MS for the Zima (~0.45 s idle). Queries never
 * wait on a probe: probes run in the background. Longer texts add 0.4 ms per char (2,500 chars/s, a tenth of the
 * Mac's measured ~25,000); capped at 60 s.
 */
export const PRIMARY_BASE_MS = 2000;
const PRIMARY_MS_PER_CHAR = 0.4;
const PRIMARY_MAX_MS = 60_000;
const charsOf = (texts: string[]) => texts.reduce((n, t) => n + t.length, 0);
export function primaryBudgetMs(texts: string[]): number {
  return Math.min(PRIMARY_MAX_MS, PRIMARY_BASE_MS + Math.ceil(charsOf(texts) * PRIMARY_MS_PER_CHAR));
}

/**
 * How long an endpoint may take before it counts as down. A query that can't wait falls back after
 * primaryBudgetMs while the request carries on, so a cold load completes and the endpoint stays up. 15 s (plus the
 * per-char allowance) covers a cold load on a busy Mac; a sleeping Mac (the connect hangs) is marked down when it
 * runs out. Worker lanes and probes, which never fall back, wait this long.
 */
export const PRIMARY_GRACE_MS = 15_000;
export function primaryGraceMs(texts: string[]): number {
  return Math.min(PRIMARY_MAX_MS, PRIMARY_GRACE_MS + Math.ceil(charsOf(texts) * PRIMARY_MS_PER_CHAR));
}

/**
 * keep_alive sent to the machine endpoints: a Mac's Ollama unloads a model after 5 idle minutes by default, and a
 * cold call costs ~1.6 s against ~0.2 s warm. 30 minutes keeps it warm through a working session without pinning
 * ~1.2 GB on the Mac forever. Not sent to the Zima fallback, whose container sets OLLAMA_KEEP_ALIVE=-1.
 */
export const MACHINE_KEEP_ALIVE = "30m";

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

/**
 * A deadline as an AbortSignal that also follows `parent`, with a timer this code owns and clears (no
 * AbortSignal.timeout / AbortSignal.any per call: thousands of those would linger during a backlog).
 */
function deadline(ms: number, parent?: AbortSignal) {
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ctrl.abort(new DOMException("deadline", "TimeoutError")); }, ms);
  const follow = () => ctrl.abort(parent!.reason);
  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });
  return {
    signal: ctrl.signal,
    get expired() { return expired; },
    done() { clearTimeout(timer); parent?.removeEventListener("abort", follow); },
  };
}

type DigestCheck = { ok: true } | { ok: false; mismatch: boolean; error: string };

/** GET /api/tags and compare `model` (or `model:latest`)'s digest with the expected prefix. */
async function checkTags(url: string, model: string, want: string, fetchFn: typeof fetch): Promise<DigestCheck> {
  const d = deadline(TAGS_TIMEOUT_MS);
  let models: { name?: unknown; digest?: unknown }[];
  try {
    const res = await fetchFn(`${url.replace(/\/+$/, "")}/api/tags`, { signal: d.signal });
    if (!res.ok) throw new Error(`tags returned ${res.status}`);
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) throw new Error("tags returned no model list");
    models = body.models;
  } catch (e) {
    return { ok: false, mismatch: false, error: `digest check failed: ${(e as Error)?.message ?? e}` };
  } finally {
    d.done();
  }
  const m = models.find((x) => x?.name === model || x?.name === `${model}:latest`);
  const got = typeof m?.digest === "string" ? m.digest.toLowerCase().replace(/^sha256:/, "") : null;
  if (!got) return { ok: false, mismatch: true, error: `model ${model} not found` };
  if (!got.startsWith(want)) {
    return { ok: false, mismatch: true, error: `model ${model} digest ${got.slice(0, 12)} does not match EMBED_MODEL_DIGEST ${want.slice(0, 12)}` };
  }
  return { ok: true };
}

export interface EndpointOptions {
  url: string;
  machine: string;
  model: string;
  dims: number;
  /** EMBED_MODEL_DIGEST (12-hex prefix or full sha256, lower case). */
  digest: string;
  now?: () => number;
  log?: (line: string) => void;
  /** How long a caller that can fall back waits before it does (tests shorten it). */
  primaryBudgetMs?: (texts: string[]) => number;
  /** How long before an unanswered call marks the endpoint down (tests shorten it). */
  primaryGraceMs?: (texts: string[]) => number;
  fetchFn?: typeof fetch;
}

/**
 * One machine's Ollama, tried before the Zima for that machine's work. It is used only while `up`; it becomes up
 * through a background probe (its digest, then a canary embed), never from a caller's request. A request that
 * fails for a reason of the endpoint's own (unreachable, 5xx/404, no answer within its grace, a malformed answer
 * such as the wrong dims) marks it down for PRIMARY_DOWN_MS; the prober tries it again after that. While up, its
 * digest is re-read every DIGEST_RECHECK_MS, and after every embed whose vectors will be stored.
 */
export class Endpoint {
  readonly machine: string;
  readonly url: string;
  private readonly o: EndpointOptions;
  private readonly ollama: Embedder;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly budget: (texts: string[]) => number;
  private readonly grace: (texts: string[]) => number;
  private state: EndpointState = "unknown";
  private lastError: string | null = null;
  private downUntil = 0;
  private verifiedAt = 0;
  private lastUsedAt: string | null = null;
  private probing: Promise<void> | null = null;
  /** A call that outran its budget is still out (maybe loading the model): fallback-capable callers skip ahead. */
  private slowPending = 0;

  constructor(o: EndpointOptions) {
    this.o = o;
    this.machine = o.machine;
    this.url = displayUrl(o.url);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l: string) => console.log(l));
    this.budget = o.primaryBudgetMs ?? primaryBudgetMs;
    this.grace = o.primaryGraceMs ?? primaryGraceMs;
    this.ollama = ollamaEmbedder(o.url, o.model, o.dims, o.fetchFn ?? fetch, PRIMARY_MAX_MS, MACHINE_KEEP_ALIVE);
  }

  get isUp(): boolean { return this.state === "up"; }
  /** Down or mismatched: its work waits (chunks) or uses the Zima (queries, summaries). */
  get isOut(): boolean { return this.state === "down" || this.state === "digest_mismatch"; }
  get lastFailure(): string | null { return this.lastError; }
  budgetFor(texts: string[]): number { return this.budget(texts); }

  private setDown(next: "down" | "digest_mismatch", error: string) {
    if (this.state !== next) {
      this.log(JSON.stringify({
        level: "warn",
        msg: next === "down"
          ? "machine embedder unavailable; its work waits or uses the Zima"
          : "machine embedder model digest mismatch; its work waits or uses the Zima",
        machine: this.machine, url: this.url, error,
      }));
    }
    this.state = next;
    this.lastError = error;
    this.downUntil = this.now() + PRIMARY_DOWN_MS;
  }

  private setUp() {
    if (this.state !== "up") this.log(JSON.stringify({ level: "info", msg: "machine embedder up", machine: this.machine, url: this.url }));
    this.state = "up";
    this.lastError = null;
  }

  /** Reads the digest now. False (and out) on a mismatch, a missing model or an unreachable /api/tags. */
  private async verifyDigest(): Promise<boolean> {
    const r = await checkTags(this.o.url, this.o.model, this.o.digest, this.o.fetchFn ?? fetch);
    if (!r.ok) {
      this.setDown(r.mismatch ? "digest_mismatch" : "down", r.error);
      return false;
    }
    this.verifiedAt = this.now();
    return true;
  }

  /** Whether the prober should look at this endpoint now. */
  probeDue(): boolean {
    if (this.state === "unknown") return true;
    if (this.isOut) return this.now() >= this.downUntil;
    return this.now() - this.verifiedAt >= DIGEST_RECHECK_MS;
  }

  /** Digest, then (unless already up) a canary embed: brings the endpoint up, or keeps it out. Concurrent calls share one. */
  probe(): Promise<void> {
    this.probing ??= (async () => {
      if (!(await this.verifyDigest())) return;
      if (this.state === "up") return; // a periodic re-check
      const d = deadline(this.grace([CANARY]));
      try {
        await this.ollama.embed([CANARY], d.signal);
        this.setUp();
      } catch (e) {
        this.setDown("down", d.expired ? `no answer within ${this.grace([CANARY])} ms` : (e as Error).message);
      } finally {
        d.done();
      }
    })().finally(() => { this.probing = null; });
    return this.probing;
  }

  /**
   * Embeds here if the endpoint is up. Null when it isn't, when it failed (it is then down), or, with
   * `fallbackAfterMs`, when it hasn't answered by then: the request carries on (a cold load finishes and the
   * endpoint stays up) and marks it down only if it fails, outlasts its grace, or its caller gives up first. With
   * `confirmDigest`, the digest is re-read after the embed and the vectors are dropped if it changed. The caller's
   * abort and a bad-input answer (an error status other than 404/5xx) are thrown: neither says the endpoint is
   * broken, and the Zima would refuse bad input too.
   */
  async tryEmbed(texts: string[], signal?: AbortSignal, opts: { fallbackAfterMs?: number; confirmDigest?: boolean } = {}): Promise<number[][] | null> {
    const canFallBack = opts.fallbackAfterMs !== undefined;
    if (!this.isUp || (canFallBack && this.slowPending > 0)) return null;
    const graceMs = this.grace(texts);
    const d = deadline(graceMs, signal);
    let wentSlow = false;
    const settled = this.ollama.embed(texts, d.signal).then(
      async (v) => {
        d.done();
        this.setUp();
        if (opts.confirmDigest && !(await this.verifyDigest())) return null;
        this.lastUsedAt = new Date(this.now()).toISOString();
        return v;
      },
      (e) => {
        d.done();
        if (signal?.aborted) {
          // A search that gave up after falling back from this Mac: treat the Mac as down so the next one doesn't wait.
          if (wentSlow) this.setDown("down", `no answer within ${opts.fallbackAfterMs} ms before the caller gave up`);
          throw e;
        }
        const err = e as EmbedderError;
        if (!d.expired && !err.transient && err.status !== undefined) {
          this.setUp(); // it answered
          throw e;
        }
        this.setDown("down", d.expired ? `no answer within ${graceMs} ms` : err.message);
        return null;
      },
    );
    if (!canFallBack) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = Symbol("slow");
    const first = await Promise.race([settled, new Promise<typeof slow>((r) => { timer = setTimeout(() => r(slow), opts.fallbackAfterMs); })])
      .finally(() => clearTimeout(timer));
    if (first !== slow) return first;
    wentSlow = true;
    this.slowPending++;
    settled.catch(() => {}).finally(() => { this.slowPending--; });
    return null;
  }

  status(): EndpointStatus {
    return {
      machine: this.machine, url: this.url, state: this.state, lastError: this.lastError,
      downUntil: this.isOut ? new Date(this.downUntil).toISOString() : null, lastUsedAt: this.lastUsedAt,
    };
  }
}

export interface RouterOptions {
  /** EMBED_MACHINE_URLS: machine-token name → that machine's Ollama. */
  machineUrls: Record<string, string>;
  /** EMBED_URL: the Zima's own Ollama, for unmapped machines and whenever a machine's endpoint can't serve. */
  fallbackUrl: string;
  model: string;
  dims: number;
  /** EMBED_MODEL_DIGEST; required with any machine endpoint. */
  digest?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  primaryBudgetMs?: (texts: string[]) => number;
  primaryGraceMs?: (texts: string[]) => number;
  fetchFn?: typeof fetch;
}

export type EmbedRouter = Embedder & Required<Pick<Embedder, "forMachine" | "lanes" | "status">> & {
  /** Checks the Zima's digest, probes every endpoint now, and keeps probing in the background. */
  start(): Promise<void>;
  /** One prober pass: whatever is due (tests drive the clock and call this). */
  probeNow(): Promise<void>;
  stop(): void;
};

/**
 * Each machine embeds its own work: `forMachine(name)` is that machine's endpoint with the Zima as fallback
 * (queries and summaries), `lanes()` its endpoint alone (the worker, which leaves a down machine's chunks to wait).
 * Unmapped machines, and `embed` itself, use the Zima. A Mac is used only while it is up and the Zima's own bge-m3
 * matches EMBED_MODEL_DIGEST, so vectors from two models never meet in one index. An empty map behaves exactly
 * like the Zima's Ollama alone.
 */
export function createEmbedRouter(o: RouterOptions): EmbedRouter {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const fetchFn = o.fetchFn ?? fetch;
  const names = Object.keys(o.machineUrls);
  if (names.length && !o.digest) throw new Error("a digest (EMBED_MODEL_DIGEST) is required with machine endpoints");
  const digest = o.digest ?? "";

  const zima = ollamaEmbedder(o.fallbackUrl, o.model, o.dims, fetchFn);
  const fb = {
    url: displayUrl(o.fallbackUrl),
    lastUsedAt: null as string | null,
    state: (names.length ? "unchecked" : "ok") as FallbackState,
    lastError: null as string | null,
    checkedAt: -Infinity,
  };
  const fallback: Embedder = {
    dims: o.dims,
    async embed(texts, signal) {
      const v = await zima.embed(texts, signal);
      fb.lastUsedAt = new Date(now()).toISOString();
      return v;
    },
  };
  const checkFallback = async () => {
    const r = await checkTags(o.fallbackUrl, o.model, digest, fetchFn);
    const next: FallbackState = r.ok ? "ok" : r.mismatch ? "digest_mismatch" : "unreachable";
    if (next !== fb.state && next !== "ok") {
      log(JSON.stringify({
        level: "warn", msg: "the Zima's bge-m3 can't be confirmed against EMBED_MODEL_DIGEST; no Mac is used until it is",
        fallback: fb.url, error: r.ok ? null : r.error,
      }));
    }
    fb.state = next;
    fb.lastError = r.ok ? null : r.error;
    fb.checkedAt = now();
  };
  const fallbackOk = () => fb.state === "ok";

  const endpoints = new Map(names.map((machine) => [machine, new Endpoint({
    url: o.machineUrls[machine], machine, model: o.model, dims: o.dims, digest, now, log,
    primaryBudgetMs: o.primaryBudgetMs, primaryGraceMs: o.primaryGraceMs, fetchFn,
  })]));
  const usable = (ep: Endpoint) => ep.isUp && fallbackOk();

  /** The endpoint first, then the Zima in the same call when the endpoint is not usable or fails. */
  const routed = (ep: Endpoint, storing: boolean): Embedder => ({
    dims: o.dims,
    async embed(texts, signal) {
      if (usable(ep)) {
        const v = await ep.tryEmbed(texts, signal, { fallbackAfterMs: ep.budgetFor(texts), confirmDigest: storing });
        if (v) return v;
      }
      return fallback.embed(texts, signal);
    },
  });
  const query = new Map([...endpoints].map(([m, ep]) => [m, routed(ep, false)]));
  const store = new Map([...endpoints].map(([m, ep]) => [m, routed(ep, true)]));

  const lanes: EmbedLane[] = [...endpoints].map(([machine, ep]) => ({
    machine,
    blocked: () => !usable(ep),
    waiting: () => ep.isOut || fb.state === "digest_mismatch",
    embedder: {
      dims: o.dims,
      async embed(texts, signal) {
        const v = usable(ep) ? await ep.tryEmbed(texts, signal, { confirmDigest: true }) : null;
        if (!v) throw new EmbedderError(`${machine}'s embedder unavailable: ${ep.lastFailure ?? "not up"}`, { transient: true });
        return v;
      },
    },
  }));

  let ticking: Promise<void> | null = null;
  const probeNow = () => {
    ticking ??= (async () => {
      if (!names.length) return;
      const due = now() - fb.checkedAt >= (fallbackOk() ? DIGEST_RECHECK_MS : FALLBACK_RETRY_MS);
      if (due) await checkFallback();
      await Promise.all([...endpoints.values()].filter((ep) => ep.probeDue()).map((ep) => ep.probe()));
    })().finally(() => { ticking = null; });
    return ticking;
  };
  let interval: ReturnType<typeof setInterval> | undefined;

  return {
    dims: o.dims,
    embed: (texts, signal) => fallback.embed(texts, signal),
    forMachine: (machine, opts) => (machine !== null && (opts?.storing ? store : query).get(machine)) || fallback,
    lanes: () => lanes,
    status: (): EmbedStatus => ({
      endpoints: [...endpoints.values()].map((ep) => ep.status()),
      fallback: { url: fb.url, lastUsedAt: fb.lastUsedAt, state: fb.state, lastError: fb.lastError },
    }),
    probeNow,
    async start() {
      if (!names.length) return;
      await checkFallback(); // at startup, before any Mac is used
      void probeNow().catch(() => {});
      interval ??= setInterval(() => { void probeNow().catch(() => {}); }, PROBE_TICK_MS);
      (interval as any).unref?.();
    },
    stop() { clearInterval(interval); interval = undefined; },
  };
}
