import { test, expect } from "bun:test";
import { fakeEmbedder } from "../src/embed/fake";
import { ollamaEmbedder, EmbedderError } from "../src/embed/ollama";

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

test("fake embedder is deterministic and similarity-aware", async () => {
  const f = fakeEmbedder(1024);
  const [a, a2, b, c] = await f.embed(["pricing for Acme", "pricing for Acme", "Acme pricing discussion", "the weather in Paris"]);
  expect(a).toHaveLength(1024);
  expect(a).toEqual(a2);
  expect(cos(a, a)).toBeCloseTo(1, 5);
  expect(cos(a, b)).toBeGreaterThan(cos(a, c));
});

test("ollama embedder posts input and validates dims", async () => {
  let body: any;
  const ok = ollamaEmbedder("http://ollama:11434", "bge-m3", 3, (async (url: string, init: any) => {
    expect(url).toBe("http://ollama:11434/api/embed");
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }));
  }) as any);
  expect(await ok.embed(["a"])).toEqual([[1, 2, 3]]);
  expect(body).toEqual({ model: "bge-m3", input: ["a"] });

  const wrongDims = ollamaEmbedder("http://o", "m", 4, (async () => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }))) as any);
  await expect(wrongDims.embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
  const down = ollamaEmbedder("http://o", "m", 3, (async () => new Response("boom", { status: 500 })) as any);
  await expect(down.embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
  const refused = ollamaEmbedder("http://o", "m", 3, (async () => { throw new TypeError("fetch failed"); }) as any);
  await expect(refused.embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
});
