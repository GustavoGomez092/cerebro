export interface Embedder {
  dims: number;
  /** Embeds texts in order. `signal` lets a caller (e.g. a search timeout) cancel the request. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Which endpoint embeds (failover embedder only), for /v1/status. */
  routing?(): EmbedRouting;
}

/** unset: no EMBED_PRIMARY_URL; unknown: not tried since the server started. */
export type PrimaryState = "unset" | "unknown" | "up" | "down" | "digest_mismatch";

export interface EmbedRouting {
  primary: { url: string | null; state: PrimaryState; lastError: string | null; downUntil: string | null };
  fallback: { url: string };
  lastUsed: "primary" | "fallback" | null;
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
