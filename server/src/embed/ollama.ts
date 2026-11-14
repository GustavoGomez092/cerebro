import { EmbedderError, type Embedder } from "./embedder";

export { EmbedderError };

/** Embeddings from an Ollama server (`POST /api/embed`). */
export function ollamaEmbedder(url: string, model: string, dims: number, fetchFn: typeof fetch = fetch): Embedder {
  const endpoint = `${url.replace(/\/+$/, "")}/api/embed`;
  return {
    dims,
    async embed(texts) {
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (e) {
        throw new EmbedderError(`embedder unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) throw new EmbedderError(`embedder returned ${res.status}`);
      const { embeddings } = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new EmbedderError("embedder returned the wrong number of vectors");
      for (const v of embeddings) if (v.length !== dims) throw new EmbedderError(`expected ${dims} dims, got ${v.length}`);
      return embeddings;
    },
  };
}
