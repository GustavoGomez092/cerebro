import { test, expect, afterEach } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { buildServer } from "../src/main";
import { createEmbedRouter } from "../src/embed/failover";
import { newWorkerState } from "../src/worker";
import { fakeOllama } from "./fakes/ollama";

const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

test("/v1/status lists each machine endpoint's state and the fallback, keeping every existing field", async () => {
  const mini = fakeOllama(1), mbp = fakeOllama(3), zima = fakeOllama(2);
  live.push(mini, mbp, zima);
  const embedder = createEmbedRouter({
    machineUrls: { "mac-mini": mini.url, "macbook-pro": mbp.url }, fallbackUrl: zima.url, model: "bge-m3", dims: 1024, log: () => {},
  });
  const workerState = { ...newWorkerState(), lastSuccessAt: "2026-11-14T10:00:00.000Z" };
  const t = await authedApp({ embedder, deps: { workerState } });
  try {
    const before = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(before).toEqual({
      lastSuccessAt: "2026-11-14T10:00:00.000Z", lastError: null, pausedUntil: null,
      endpoints: [
        { machine: "mac-mini", url: mini.url, state: "unknown", lastError: null, downUntil: null, lastUsedAt: null },
        { machine: "macbook-pro", url: mbp.url, state: "unknown", lastError: null, downUntil: null, lastUsedAt: null },
      ],
      fallback: { url: zima.url, lastUsedAt: null },
    });

    mbp.mode = "503";
    await embedder.forMachine("mac-mini").embed(["a"]);
    await embedder.forMachine("macbook-pro").embed(["b"]);
    const after = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(after.endpoints[0]).toMatchObject({ machine: "mac-mini", state: "up", lastUsedAt: expect.any(String) });
    expect(after.endpoints[1]).toMatchObject({ machine: "macbook-pro", state: "down", lastError: expect.stringContaining("503") });
    expect(Date.parse(after.endpoints[1].downUntil)).toBeGreaterThan(Date.now());
    expect(after.fallback.lastUsedAt).toEqual(expect.any(String));
  } finally {
    await t.drop();
  }
});

test("/v1/status with an embedder that reports no endpoints shows an empty list", async () => {
  const t = await authedApp();
  try {
    const e = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(e).toEqual({ lastSuccessAt: null, lastError: null, pausedUntil: null, endpoints: [], fallback: null });
  } finally {
    await t.drop();
  }
});

test("buildServer wires one router from EMBED_MACHINE_URLS / EMBED_MODEL_DIGEST / EMBED_URL", async () => {
  const db = await freshDb();
  const mini = fakeOllama(1), zima = fakeOllama(2);
  live.push(mini, zima);
  const log = console.log;
  console.log = () => {};
  try {
    const built = await buildServer({
      DATABASE_URL: db.url, EMBED_URL: zima.url, EMBED_MACHINE_URLS: `mac-mini=${mini.url}`, EMBED_MODEL_DIGEST: "790764642607",
      SUMMARISER_ENABLED: "false",
    });
    try {
      expect(built.embedder.lanes?.().map((l) => l.machine)).toEqual(["mac-mini"]);
      expect((await built.embedder.forMachine!("mac-mini").embed(["a"]))[0][0]).toBe(1);
      expect(mini.tagCalls).toBe(1); // the digest was checked
      expect(built.embedder.status?.()).toMatchObject({
        endpoints: [{ machine: "mac-mini", url: mini.url, state: "up" }], fallback: { url: zima.url },
      });
    } finally { await built.sql.close(); }

    const plain = await buildServer({ DATABASE_URL: db.url, EMBED_URL: zima.url, SUMMARISER_ENABLED: "false" });
    try {
      expect(plain.embedder.lanes?.() ?? []).toEqual([]);
      expect((await plain.embedder.embed(["a"]))[0][0]).toBe(2);
      expect(plain.embedder.status?.()).toMatchObject({ endpoints: [], fallback: { url: zima.url } });
    } finally { await plain.sql.close(); }

    await expect(buildServer({ DATABASE_URL: db.url, EMBED_URL: zima.url, EMBED_MACHINE_URLS: "mac-mini" })).rejects.toThrow(/EMBED_MACHINE_URLS/);
  } finally {
    console.log = log;
    await db.drop();
  }
});
