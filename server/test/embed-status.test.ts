import { test, expect } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { buildServer } from "../src/main";
import { failoverEmbedder } from "../src/embed/failover";
import { newWorkerState } from "../src/worker";

/** A stand-in Ollama answering 1024-dim vectors, or 503 when `down`. */
function fakeOllama() {
  const s = { down: false };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [] });
      const { input } = (await req.json()) as { input: string[] };
      if (s.down) return new Response("busy", { status: 503 });
      return Response.json({ embeddings: input.map(() => new Array(1024).fill(0.5)) });
    },
  });
  return Object.assign(s, { url: `http://127.0.0.1:${server.port}`, server });
}

test("/v1/status reports the primary's state and which endpoint embedded last, keeping every existing field", async () => {
  const primary = fakeOllama();
  const fallback = fakeOllama();
  const embedder = failoverEmbedder({ primaryUrl: primary.url, fallbackUrl: fallback.url, model: "bge-m3", dims: 1024, log: () => {} });
  const workerState = { ...newWorkerState(), lastSuccessAt: "2026-11-14T10:00:00.000Z" };
  const t = await authedApp({ embedder, deps: { workerState } });
  try {
    const before = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(before).toEqual({
      lastSuccessAt: "2026-11-14T10:00:00.000Z", lastError: null, pausedUntil: null,
      primary: { url: primary.url, state: "unknown", lastError: null, downUntil: null },
      fallback: { url: fallback.url },
      lastUsed: null,
    });

    await embedder.embed(["a"]);
    const up = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(up).toMatchObject({ primary: { state: "up" }, lastUsed: "primary" });

    primary.down = true;
    await embedder.embed(["b"]);
    const down = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(down).toMatchObject({ primary: { url: primary.url, state: "down", lastError: expect.stringContaining("503") }, lastUsed: "fallback" });
    expect(Date.parse(down.primary.downUntil)).toBeGreaterThan(Date.now());
  } finally {
    await t.drop();
    primary.server.stop(true);
    fallback.server.stop(true);
  }
});

test("/v1/status with an embedder that has no routing reports the primary as unset", async () => {
  const t = await authedApp();
  try {
    const e = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(e).toMatchObject({ lastSuccessAt: null, lastError: null, pausedUntil: null, primary: { url: null, state: "unset" }, lastUsed: null });
  } finally {
    await t.drop();
  }
});

test("buildServer wires one failover embedder from EMBED_PRIMARY_URL / EMBED_MODEL_DIGEST / EMBED_URL", async () => {
  const db = await freshDb();
  const primary = fakeOllama();
  const fallback = fakeOllama();
  const log = console.log;
  console.log = () => {};
  try {
    const built = await buildServer({
      DATABASE_URL: db.url, EMBED_URL: fallback.url, EMBED_PRIMARY_URL: primary.url, EMBED_MODEL_DIGEST: "790764642607",
      SUMMARISER_ENABLED: "false",
    });
    try {
      // The fake primary lists no models: the digest check fails, the fallback embeds, nothing fails.
      expect((await built.embedder.embed(["a"]))[0]).toHaveLength(1024);
      expect(built.embedder.routing?.()).toMatchObject({
        primary: { url: primary.url, state: "digest_mismatch" }, fallback: { url: fallback.url }, lastUsed: "fallback",
      });
    } finally { await built.sql.close(); }

    const plain = await buildServer({ DATABASE_URL: db.url, EMBED_URL: fallback.url, SUMMARISER_ENABLED: "false" });
    try {
      await plain.embedder.embed(["a"]);
      expect(plain.embedder.routing?.()).toMatchObject({ primary: { url: null, state: "unset" }, lastUsed: "fallback" });
    } finally { await plain.sql.close(); }

    await expect(buildServer({ DATABASE_URL: db.url, EMBED_URL: fallback.url, EMBED_PRIMARY_URL: "mac:11434" })).rejects.toThrow(/EMBED_PRIMARY_URL/);
  } finally {
    console.log = log;
    await db.drop();
    primary.server.stop(true);
    fallback.server.stop(true);
  }
});
