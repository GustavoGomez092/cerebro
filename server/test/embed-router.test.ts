import { test, expect, afterEach } from "bun:test";
import { createEmbedRouter, PRIMARY_DOWN_MS } from "../src/embed/failover";
import { EmbedderError, embedderFor } from "../src/embed/embedder";
import { ollamaEmbedder } from "../src/embed/ollama";
import { fakeOllama, type OllamaMode } from "./fakes/ollama";

const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

/** Mac mini answers 1s, MacBook Pro 3s, the Zima 2s. */
/** Probed once (both Macs up) unless `probe: false`. */
async function setup(opts: { map?: boolean; probe?: boolean } = {}) {
  const mini = fakeOllama(1), mbp = fakeOllama(3), zima = fakeOllama(2);
  live.push(mini, mbp, zima);
  let t = 1_000_000;
  const router = createEmbedRouter({
    machineUrls: opts.map === false ? {} : { "mac-mini": mini.url, "macbook-pro": mbp.url },
    fallbackUrl: zima.url, model: "bge-m3", dims: 1024, digest: "790764642607",
    now: () => t, log: () => {},
  });
  if (opts.probe !== false) await router.probeNow();
  return { mini, mbp, zima, router, advance: (ms: number) => { t += ms; } };
}
const from = (v: number[][]) => v.map((x) => x[0]);

test("each machine's work embeds on its own endpoint only", async () => {
  const { mini, mbp, zima, router } = await setup();
  expect(from(await embedderFor(router, "mac-mini").embed(["a"]))).toEqual([1]);
  expect(from(await embedderFor(router, "macbook-pro").embed(["b"]))).toEqual([3]);
  expect(mini.inputs).toEqual([["a"]]);
  expect(mbp.inputs).toEqual([["b"]]);
  expect(zima.embedCalls).toBe(0);
});

test("unmapped machines (and work with no machine) embed on the Zima", async () => {
  const { mini, mbp, zima, router } = await setup();
  expect(from(await embedderFor(router, "check").embed(["a"]))).toEqual([2]);
  expect(from(await embedderFor(router, null).embed(["b"]))).toEqual([2]);
  expect(from(await router.embed(["c"]))).toEqual([2]);
  expect(mini.embedCalls + mbp.embedCalls).toBe(0);
});

test("a machine whose endpoint is down falls back to the Zima, never to the other Mac", async () => {
  const { mini, mbp, zima, router } = await setup();
  mini.mode = "503";
  expect(from(await embedderFor(router, "mac-mini").embed(["q"]))).toEqual([2]);
  expect(mbp.embedCalls).toBe(0);
  expect(zima.inputs).toEqual([["q"]]);
  expect(from(await embedderFor(router, "macbook-pro").embed(["r"]))).toEqual([3]); // B unaffected
});

test("worker lanes: one per mapped machine, its endpoint only; a down endpoint throws transient and is blocked until a probe after 60 s", async () => {
  const { mini, mbp, zima, router, advance } = await setup();
  const lanes = router.lanes();
  expect(lanes.map((l) => l.machine)).toEqual(["mac-mini", "macbook-pro"]);
  const [a, b] = lanes;
  expect(from(await a.embedder.embed(["x"]))).toEqual([1]);
  mini.mode = "503";
  const e = await a.embedder.embed(["y"]).catch((x) => x);
  expect(e).toBeInstanceOf(EmbedderError);
  expect(e.transient).toBe(true);
  expect(e.message).toContain("mac-mini");
  expect(zima.embedCalls).toBe(0); // the lane never falls back
  expect(a.blocked()).toBe(true);
  expect(b.blocked()).toBe(false);
  expect(from(await b.embedder.embed(["z"]))).toEqual([3]);
  advance(PRIMARY_DOWN_MS);
  expect(a.blocked()).toBe(true); // the window is over, but only a probe brings it back
  mini.mode = "ok";
  await router.probeNow();
  expect(a.blocked()).toBe(false);
  expect(mbp.inputs).toEqual([["z"]]);
});

test("a digest mismatch on one Mac sends its query to the Zima and blocks its lane", async () => {
  const { mini, zima, router } = await setup({ probe: false });
  mini.models = [{ name: "bge-m3:latest", digest: "0123456789ab" + "c".repeat(52) }];
  await router.probeNow();
  expect(from(await embedderFor(router, "mac-mini").embed(["q"]))).toEqual([2]);
  expect(mini.embedCalls + mini.canaryCalls).toBe(0); // not even the probe's canary
  expect(router.lanes()[0].blocked()).toBe(true);
  expect(from(await embedderFor(router, "macbook-pro").embed(["q"]))).toEqual([3]);
  expect(zima.embedCalls).toBe(1);
});

test("status lists every endpoint by machine, with the Zima fallback", async () => {
  const { mini, mbp, zima, router } = await setup();
  mbp.mode = "503";
  await embedderFor(router, "mac-mini").embed(["a"]);
  await embedderFor(router, "macbook-pro").embed(["b"]);
  const s = router.status();
  expect(s.endpoints).toEqual([
    { machine: "mac-mini", url: mini.url, state: "up", lastError: null, downUntil: null, lastUsedAt: expect.any(String) },
    { machine: "macbook-pro", url: mbp.url, state: "down", lastError: expect.stringContaining("503"), downUntil: expect.any(String), lastUsedAt: null },
  ]);
  expect(s.fallback).toEqual({ url: zima.url, lastUsedAt: expect.any(String), state: "ok", lastError: null });
});

test("an empty map is identical to the Zima's Ollama alone", async () => {
  const { mini, mbp, zima, router } = await setup({ map: false });
  expect(router.lanes()).toEqual([]);
  expect(router.status()).toEqual({ endpoints: [], fallback: { url: zima.url, lastUsedAt: null, state: "ok", lastError: null } });
  for (const m of ["mac-mini", "check", null]) expect(from(await embedderFor(router, m).embed(["a"]))).toEqual([2]);
  expect(mini.embedCalls + mbp.embedCalls + mini.tagCalls + mbp.tagCalls + zima.tagCalls).toBe(0);
  const plain = ollamaEmbedder(zima.url, "bge-m3", 1024);
  for (const mode of ["503", "400"] as OllamaMode[]) {
    zima.mode = mode;
    const x = await router.embed(["x"]).catch((e) => e);
    const y = await plain.embed(["x"]).catch((e) => e);
    expect([x.message, x.transient]).toEqual([y.message, y.transient]);
  }
});
