import type { Embedder } from "./embedder";

/** Deterministic bag-of-words embedder for tests: shared words → positive cosine similarity. */
export function fakeEmbedder(dims = 1024): Embedder {
  const vec = (text: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      v[Number(Bun.hash(tok) % BigInt(dims))] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return { dims, embed: async (texts) => texts.map(vec) };
}
