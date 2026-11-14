export interface Embedder {
  dims: number;
  /** Embeds texts in order. `signal` lets a caller (e.g. a search timeout) cancel the request. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * `transient` = the embedder itself is unavailable (unreachable, overloaded): the worker
 * pauses instead of charging the failure to the chunks it was embedding.
 */
export class EmbedderError extends Error {
  readonly transient: boolean;
  constructor(message: string, opts: { transient?: boolean } = {}) {
    super(message);
    this.transient = opts.transient ?? false;
  }
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
