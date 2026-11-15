import { test, expect, afterEach } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { buildServer } from "../src/main";
import { createEmbedRouter, PRIMARY_DOWN_MS } from "../src/embed/failover";
import { createToken, revokeToken } from "../src/auth";
import { embedLanes, newWorkerState } from "../src/worker";
import { fakeOllama } from "./fakes/ollama";

const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

function routerFor(machines: Record<string, string>, zimaUrl: string, now?: () => number) {
  const r = createEmbedRouter({ machineUrls: machines, fallbackUrl: zimaUrl, model: "bge-m3", dims: 1024, digest: "790764642607", log: () => {}, now });
  live.push({ stop: () => r.stop() });
  return r;
}

test("/v1/status lists each machine endpoint's state, whether its name is a known machine, and the fallback", async () => {
  const mini = fakeOllama(1), mbp = fakeOllama(3), zima = fakeOllama(2);
  live.push(mini, mbp, zima);
  // "test-mac" is authedApp's machine; "macmini" is a typo; "macbook-pro" gets a token, later revoked.
  const embedder = routerFor({ "test-mac": mini.url, "macmini": mbp.url }, zima.url);
  const workerState = { ...newWorkerState(), lastSuccessAt: "2026-11-14T10:00:00.000Z" };
  const t = await authedApp({ embedder, deps: { workerState } });
  try {
    const before = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(before).toEqual({
      lastSuccessAt: "2026-11-14T10:00:00.000Z", lastError: null, pausedUntil: null, lanes: {},
      endpoints: [
        { machine: "test-mac", known: true, url: mini.url, state: "unknown", lastError: null, downUntil: null, lastUsedAt: null },
        { machine: "macmini", known: false, url: mbp.url, state: "unknown", lastError: null, downUntil: null, lastUsedAt: null },
      ],
      fallback: { url: zima.url, lastUsedAt: null, state: "unchecked", lastError: null },
    });

    mbp.mode = "503";
    await embedder.probeNow();
    await embedder.forMachine("test-mac").embed(["a"]);
    const after = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(after.endpoints[0]).toMatchObject({ machine: "test-mac", state: "up", lastUsedAt: expect.any(String) });
    expect(after.endpoints[1]).toMatchObject({ machine: "macmini", state: "down", lastError: expect.stringContaining("503") });
    expect(after.fallback).toMatchObject({ state: "ok", lastError: null });

    await createToken(t.sql, "macmini");
    expect((await (await t.call("GET", "/v1/status")).json()).embedder.endpoints[1].known).toBe(true);
    await revokeToken(t.sql, "macmini");
    expect((await (await t.call("GET", "/v1/status")).json()).embedder.endpoints[1].known).toBe(false);
  } finally {
    await t.drop();
  }
});

test("M2: a recovered Mac shows up in /v1/status from the background probe alone, with no traffic", async () => {
  const mini = fakeOllama(1), zima = fakeOllama(2);
  live.push(mini, zima);
  let clock = 1_000_000;
  const embedder = routerFor({ "test-mac": mini.url }, zima.url, () => clock);
  const t = await authedApp({ embedder });
  try {
    mini.mode = "503";
    await embedder.probeNow();
    expect((await (await t.call("GET", "/v1/status")).json()).embedder.endpoints[0].state).toBe("down");
    mini.mode = "ok";
    clock += PRIMARY_DOWN_MS;
    await embedder.probeNow();
    expect((await (await t.call("GET", "/v1/status")).json()).embedder.endpoints[0]).toMatchObject({ state: "up", downUntil: null });
  } finally {
    await t.drop();
  }
});

test("/v1/status reports each lane's last success and how long the oldest live and imported chunks have waited", async () => {
  const mini = fakeOllama(1), zima = fakeOllama(2);
  live.push(mini, zima);
  const embedder = routerFor({ "test-mac": mini.url }, zima.url);
  await embedder.probeNow();
  const workerState = newWorkerState();
  const t = await authedApp({ embedder, deps: { workerState } });
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("live1", binding.id), sess("old1", binding.id, { imported: true })],
      events: [ev("live1", 1, "user", "hello"), ev("old1", 1, "user", "history")] });
    await t.sql`update embed_queue set enqueued_at = now() - interval '7 hours' where priority = 0`;
    await t.sql`update embed_queue set enqueued_at = now() - interval '50 hours' where priority = 1`;
    const q = (await (await t.call("GET", "/v1/status")).json()).queue;
    expect(q.pending).toBe(2);
    expect(Math.round(q.oldestWaitSeconds.live / 3600)).toBe(7);
    expect(Math.round(q.oldestWaitSeconds.imported / 3600)).toBe(50);

    for (const lane of embedLanes(t.sql, embedder, { state: workerState })) await lane.run();
    const e = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(e.lanes["test-mac"]).toEqual({ lastSuccessAt: expect.any(String), lastError: null });
    expect(e.lanes.zima).toEqual({ lastSuccessAt: null, lastError: null });
    const empty = (await (await t.call("GET", "/v1/status")).json()).queue;
    expect(empty).toMatchObject({ pending: 0, oldestWaitSeconds: { live: 0, imported: 0 } });
  } finally {
    await t.drop();
  }
});

test("/v1/status with an embedder that reports no endpoints shows an empty list", async () => {
  const t = await authedApp();
  try {
    const e = (await (await t.call("GET", "/v1/status")).json()).embedder;
    expect(e).toEqual({ lastSuccessAt: null, lastError: null, pausedUntil: null, lanes: {}, endpoints: [], fallback: null });
  } finally {
    await t.drop();
  }
});

test("buildServer wires one router, checks the Zima's digest at startup, and warns about unknown machine names", async () => {
  const db = await freshDb();
  const mini = fakeOllama(1), zima = fakeOllama(2);
  live.push(mini, zima);
  const lines: string[] = [];
  const log = console.log;
  console.log = (l: string) => { lines.push(String(l)); };
  try {
    const built = await buildServer({
      DATABASE_URL: db.url, EMBED_URL: zima.url, EMBED_MACHINE_URLS: `mac-mini=${mini.url}`, EMBED_MODEL_DIGEST: "790764642607",
      SUMMARISER_ENABLED: "false",
    });
    try {
      expect(zima.tagCalls).toBeGreaterThanOrEqual(1); // checked before serving
      expect(built.embedder.status().fallback.state).toBe("ok");
      await built.embedder.probeNow();
      expect(built.embedder.lanes().map((l) => l.machine)).toEqual(["mac-mini"]);
      expect((await built.embedder.forMachine("mac-mini").embed(["a"]))[0][0]).toBe(1);
      expect(lines.some((l) => /mac-mini/.test(l) && /no machine/.test(l))).toBe(true); // no token named mac-mini yet
    } finally { built.embedder.stop(); await built.sql.close(); }

    const plain = await buildServer({ DATABASE_URL: db.url, EMBED_URL: zima.url, SUMMARISER_ENABLED: "false" });
    try {
      expect(plain.embedder.lanes()).toEqual([]);
      expect((await plain.embedder.embed(["a"]))[0][0]).toBe(2);
      expect(plain.embedder.status()).toMatchObject({ endpoints: [], fallback: { url: zima.url, state: "ok" } });
    } finally { plain.embedder.stop(); await plain.sql.close(); }

    await expect(buildServer({ DATABASE_URL: db.url, EMBED_URL: zima.url, EMBED_MACHINE_URLS: "mac-mini" })).rejects.toThrow(/EMBED_MACHINE_URLS/);
    await expect(buildServer({ DATABASE_URL: db.url, EMBED_URL: zima.url, EMBED_MACHINE_URLS: `mac-mini=${mini.url}` }))
      .rejects.toThrow(/EMBED_MODEL_DIGEST/);
  } finally {
    console.log = log;
    await db.drop();
  }
});
