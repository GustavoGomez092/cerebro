// In-process metrics for the dashboard: ring buffers and counters, reset on restart. Never holds tokens or bodies.

/** Counts in fixed time buckets over a rolling span (bucketMs × buckets). */
export class RateCounter {
  private readonly counts: number[];
  private readonly stamps: number[];
  constructor(private readonly bucketMs: number, private readonly buckets: number, private readonly now: () => number = Date.now) {
    this.counts = new Array(buckets).fill(0);
    this.stamps = new Array(buckets).fill(-1);
  }
  add(n = 1): void {
    const b = Math.floor(this.now() / this.bucketMs);
    const i = b % this.buckets;
    if (this.stamps[i] !== b) { this.stamps[i] = b; this.counts[i] = 0; }
    this.counts[i] += n;
  }
  /** Total over the last `windowMs` (capped at the counter's span), the current bucket included. */
  sum(windowMs: number): number {
    const cur = Math.floor(this.now() / this.bucketMs);
    const span = Math.min(this.buckets, Math.ceil(windowMs / this.bucketMs));
    let total = 0;
    for (let i = 0; i < this.buckets; i++) if (this.stamps[i] > cur - span && this.stamps[i] <= cur) total += this.counts[i];
    return total;
  }
}

export interface ActiveSearch { id: number; query: string; machine: string | null; startedAt: string; elapsedMs: number }

const QUERY_PREVIEW = 120;
const preview = (s: string) => (s.length > QUERY_PREVIEW ? `${s.slice(0, QUERY_PREVIEW)}…` : s);

export type ChatOutcome = "ok" | "usage_limit" | "auth" | "timeout" | "cancelled" | "unavailable" | "failed";
export interface ChatRunRecord { tokens: number; model: string | null; outcome: ChatOutcome; message?: string; resetAt?: string | null }

const CHAT_WINDOW_MS = 5 * 3600_000;

/**
 * Chat runs' subscription spend as the CLI reported it. Kept apart from the summariser's usage_ledger, so chat
 * never eats the summariser's SUMMARY_SHARE; both still draw on the same Max plan.
 */
export class ChatUsage {
  private runs: { at: number; tokens: number }[] = [];
  private total = { tokens: 0, runs: 0 };
  private last: (ChatRunRecord & { at: string }) | null = null;
  private limit: { at: string; message: string; resetAt: string | null } | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  recordRun(r: ChatRunRecord): void {
    const at = this.now();
    this.runs.push({ at, tokens: r.tokens });
    this.total.tokens += r.tokens;
    this.total.runs++;
    this.last = { ...r, at: new Date(at).toISOString() };
    if (r.outcome === "usage_limit") this.limit = { at: new Date(at).toISOString(), message: r.message ?? "", resetAt: r.resetAt ?? null };
  }
  snapshot() {
    const cutoff = this.now() - CHAT_WINDOW_MS;
    this.runs = this.runs.filter((r) => r.at > cutoff);
    return {
      window: { hours: 5, tokens: this.runs.reduce((n, r) => n + r.tokens, 0), runs: this.runs.length },
      sinceStart: { ...this.total },
      lastRun: this.last,
      lastLimit: this.limit,
    };
  }
}

export class Metrics {
  readonly startedAt: string;
  private readonly started: number;
  /** Search requests (client API, dashboard and chat tools), events ingested, chunks embedded: 1 s buckets, 15 min. */
  readonly searches: RateCounter;
  readonly events: RateCounter;
  readonly chunks: RateCounter;
  readonly chat: ChatUsage;
  private readonly active = new Map<number, { query: string; machine: string | null; started: number }>();
  private nextId = 1;

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
    this.startedAt = new Date(this.started).toISOString();
    this.searches = new RateCounter(1000, 900, now);
    this.events = new RateCounter(1000, 900, now);
    this.chunks = new RateCounter(1000, 900, now);
    this.chat = new ChatUsage(now);
  }

  uptimeSeconds(): number { return Math.floor((this.now() - this.started) / 1000); }

  /** Counts a search and lists it as in flight until the returned function is called. */
  trackSearch(query: string, machine: string | null): () => void {
    const id = this.nextId++;
    this.searches.add();
    this.active.set(id, { query: preview(query.replace(/\s+/g, " ").trim()), machine, started: this.now() });
    return () => { this.active.delete(id); };
  }

  activeSearches(): ActiveSearch[] {
    const now = this.now();
    return [...this.active].map(([id, a]) => ({
      id, query: a.query, machine: a.machine, startedAt: new Date(a.started).toISOString(), elapsedMs: now - a.started,
    }));
  }

  searchRates() {
    return { m1: this.searches.sum(60_000), m5: this.searches.sum(5 * 60_000), m15: this.searches.sum(15 * 60_000) };
  }
}
