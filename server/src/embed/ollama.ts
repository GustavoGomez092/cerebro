import { EmbedderError, type Embedder } from "./embedder";

export { EmbedderError };

/** Embeddings from an Ollama server (`POST /api/embed`); keeps the model loaded between calls. */
export function ollamaEmbedder(
  url: string, model: string, dims: number, fetchFn: typeof fetch = fetch, timeoutMs = 120_000,
): Embedder {
  const endpoint = `${url.replace(/\/+$/, "")}/api/embed`;
  return {
    dims,
    async embed(texts, signal) {
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
      let embeddings: unknown;
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: texts, keep_alive: -1 }),
          signal: AbortSignal.any(signals),
        });
        if (!res.ok) {
          // 502/503/504: the server is overloaded or restarting, not a problem with these texts.
          throw new EmbedderError(`embedder returned ${res.status}`, { transient: [502, 503, 504].includes(res.status) });
        }
        ({ embeddings } = (await res.json()) as { embeddings?: unknown });
      } catch (e) {
        if (e instanceof EmbedderError) throw e;
        const err = e as Error;
        const aborted = err?.name === "AbortError" || err?.name === "TimeoutError";
        // A refused/reset connection means the embedder is down; a timeout or bad body is per-request.
        throw new EmbedderError(`embedder ${aborted ? "timed out or was cancelled" : "unavailable"}: ${err?.message ?? e}`, {
          transient: !aborted && err instanceof TypeError,
        });
      }
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new EmbedderError("embedder returned the wrong number of vectors");
      for (const v of embeddings) {
        if (!Array.isArray(v) || v.length !== dims) throw new EmbedderError(`expected ${dims} dims, got ${Array.isArray(v) ? v.length : typeof v}`);
        if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new EmbedderError("embedder returned a non-finite value");
      }
      return embeddings as number[][];
    },
  };
}
