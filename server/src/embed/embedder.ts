export interface Embedder {
  dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbedderError extends Error {}
