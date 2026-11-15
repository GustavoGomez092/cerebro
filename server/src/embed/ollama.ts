import { EmbedderError, type Embedder } from "./embedder";

export { EmbedderError };

/**
 * Embeddings from an Ollama server (`POST /api/embed`). `keepAlive` is how long Ollama keeps the model loaded after
 * the call: -1 (forever) for the Zima's own container.
 */
export function ollamaEmbedder(
  url: string, model: string, dims: number, fetchFn: typeof fetch = fetch, timeoutMs = 120_000, keepAlive: number | string = -1,
): Embedder {
  const endpoint = `${url.replace(/\/+$/, "")}/api/embed`;
  return {
    dims,
    async embed(texts, signal) {
      // One controller and a timer cleared on every path (no AbortSignal.timeout/any left behind per call).
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new DOMException("embedder timeout", "TimeoutError")), timeoutMs);
      const follow = () => ctrl.abort(signal!.reason);
      if (signal?.aborted) follow();
      else signal?.addEventListener("abort", follow, { once: true });
      let embeddings: unknown;
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: texts, keep_alive: keepAlive }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          // 404 (model missing), 500 (out of memory, crashed runner), 502–504 (overloaded/restarting):
          // the embedder is broken, not these texts. 400 and other 4xx point at the input.
          throw new EmbedderError(`embedder returned ${res.status}`, {
            transient: [404, 500, 502, 503, 504].includes(res.status), status: res.status,
          });
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
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", follow);
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
