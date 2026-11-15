export interface Embedder {
  dims: number;
  /** Embeds texts in order. `signal` lets a caller (e.g. a search timeout) cancel the request. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /**
   * EMBED_MACHINE_URLS routing: the embedder for work that belongs to `machine` (absent: this one serves all).
   * `storing`: the vectors will be stored, so a Mac's digest is re-confirmed after it made them.
   */
  forMachine?(machine: string | null, opts?: { storing?: boolean }): Embedder;
  /** The mapped machines' own endpoints, one worker lane each (absent or empty: one lane, this embedder). */
  lanes?(): EmbedLane[];
  /** Per-endpoint state for /v1/status. */
  status?(): EmbedStatus;
}

/** The embedder for `machine`'s work: its own endpoint when routed, else `e` itself. */
export const embedderFor = (e: Embedder, machine: string | null, opts?: { storing?: boolean }): Embedder =>
  e.forMachine?.(machine, opts) ?? e;

/** unknown: not probed yet since the server started. */
export type EndpointState = "unknown" | "up" | "down" | "digest_mismatch";

export interface EndpointStatus {
  machine: string | null;
  url: string;
  state: EndpointState;
  lastError: string | null;
  downUntil: string | null;
  lastUsedAt: string | null;
}

/** The Zima's own bge-m3 against EMBED_MODEL_DIGEST: no Mac is used unless it is `ok`. */
export type FallbackState = "unchecked" | "ok" | "digest_mismatch" | "unreachable";

export interface EmbedStatus {
  endpoints: EndpointStatus[];
  fallback: { url: string; lastUsedAt: string | null; state: FallbackState; lastError: string | null };
}

/**
 * A mapped machine's endpoint as the worker sees it: `embed` uses that endpoint only (never the fallback) and
 * throws a transient EmbedderError when it is down; `blocked` while it sits out its down window.
 */
export interface EmbedLane {
  machine: string;
  embedder: Embedder;
  /** Not usable now (not up, or the Zima's digest unconfirmed): the lane doesn't claim. */
  blocked(): boolean;
  /** Down or mismatched: the Zima lane may take this machine's waiting chunks. */
  waiting(): boolean;
}

/**
 * `transient` = the embedder itself is unavailable (unreachable, overloaded): the worker
 * pauses instead of charging the failure to the chunks it was embedding.
 */
export class EmbedderError extends Error {
  readonly transient: boolean;
  /** The HTTP status the embedder answered with, when it answered with an error status. */
  readonly status?: number;
  constructor(message: string, opts: { transient?: boolean; status?: number } = {}) {
    super(message);
    this.transient = opts.transient ?? false;
    this.status = opts.status;
  }
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
