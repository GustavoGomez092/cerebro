// One machine endpoint in front of the Zima fallback: up/down/60 s window, background probes, digest checks,
// budgets, cancellation. Fake Ollamas on real sockets (Bun.serve, port 0); an injected clock for the windows.
import { test, expect, afterEach } from "bun:test";
import {
  createEmbedRouter, primaryBudgetMs, DIGEST_RECHECK_MS, PRIMARY_DOWN_MS, PRIMARY_BASE_MS,
} from "../src/embed/failover";
import { EmbedderError } from "../src/embed/embedder";
import { QUERY_EMBED_TIMEOUT_MS } from "../src/search";
import { fakeOllama, DIGEST } from "./fakes/ollama";

const DIMS = 1024;
const OTHER = "0123456789ab" + "c".repeat(52);
const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

/** The Mac ("mac-mini", fill 1) and the Zima (fill 2), not started: call `start()` or `probeNow()` yourself. */
function setup(opts: { digest?: string; budgetMs?: number; graceMs?: number } = {}) {
  const primary = fakeOllama(1);
  const fallback = fakeOllama(2);
  live.push(primary, fallback);
  let t = 1_000_000;
  const logs: any[] = [];
  const router = createEmbedRouter({
    machineUrls: { "mac-mini": primary.url }, fallbackUrl: fallback.url,
    model: "bge-m3", dims: DIMS, digest: opts.digest ?? "790764642607",
    now: () => t,
    log: (l) => logs.push(JSON.parse(l)),
    ...(opts.budgetMs ? { primaryBudgetMs: () => opts.budgetMs! } : {}),
    ...(opts.graceMs ? { primaryGraceMs: () => opts.graceMs! } : {}),
  });
  live.push({ stop: () => router.stop() });
  const query = router.forMachine("mac-mini");
  const storing = router.forMachine("mac-mini", { storing: true });
  const state = () => router.status().endpoints[0];
  return { primary, fallback, router, query, storing, state, logs, advance: (ms: number) => { t += ms; } };
}
const from = (v: number[][]) => v.map((x) => x[0]);

test("primary is used once a probe found it up", async () => {
  const { primary, fallback, router, query, state } = setup();
  await router.probeNow();
  expect(state()).toMatchObject({ state: "up", lastError: null });
  expect(from(await query.embed(["a", "b"]))).toEqual([1, 1]);
  expect(primary.inputs.at(-1)).toEqual(["a", "b"]);
  expect(fallback.embedCalls).toBe(0);
  expect(state().lastUsedAt).toEqual(expect.any(String));
});

test("a query never probes: before the first probe, or after a down window, it goes straight to the Zima", async () => {
  const { primary, router, query, advance } = setup();
  expect(from(await query.embed(["q"]))).toEqual([2]); // unknown yet
  expect(primary.embedCalls + primary.tagCalls).toBe(0);
  await router.probeNow();
  primary.mode = "503";
  await query.embed(["q2"]); // fails over, marks down
  advance(PRIMARY_DOWN_MS);
  const calls = primary.embedCalls + primary.tagCalls;
  primary.mode = "ok";
  expect(from(await query.embed(["q3"]))).toEqual([2]); // the window is over, but only a probe brings it back
  expect(primary.embedCalls + primary.tagCalls).toBe(calls);
});

test("a transiently failing primary falls back within the same call, then is skipped for 60 s", async () => {
  const { primary, fallback, router, query, state, advance, logs } = setup();
  await router.probeNow();
  const probes = primary.embedCalls;
  primary.mode = "503";
  expect(from(await query.embed(["a"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(probes + 1);
  expect(fallback.inputs).toEqual([["a"]]);
  expect(state()).toMatchObject({ state: "down", lastError: expect.stringContaining("503") });
  expect(logs.some((l) => l.level === "warn" && /embedder unavailable/.test(l.msg))).toBe(true);
  primary.mode = "ok";
  advance(PRIMARY_DOWN_MS - 1);
  await router.probeNow(); // still inside the window: no probe
  expect(from(await query.embed(["b"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(probes + 1);
});

test("an unreachable primary (connection refused) is down after its probe, and the call still succeeds", async () => {
  const { primary, router, query, state } = setup();
  primary.server.stop(true);
  await router.probeNow();
  expect(state().state).toBe("down");
  expect(from(await query.embed(["a"]))).toEqual([2]);
});

test("after the window a background probe brings a recovered Mac back to up with no traffic (M2), or keeps it down", async () => {
  const { primary, router, state, advance } = setup();
  await router.probeNow();
  primary.mode = "503";
  await router.forMachine("mac-mini").embed(["a"]);
  advance(PRIMARY_DOWN_MS);
  await router.probeNow(); // still failing: a fresh window
  expect(state().state).toBe("down");
  advance(PRIMARY_DOWN_MS - 1);
  primary.mode = "ok";
  await router.probeNow();
  expect(state().state).toBe("down");
  advance(1);
  await router.probeNow();
  expect(state()).toMatchObject({ state: "up", lastError: null, downUntil: null });
});

test("a primary that doesn't answer within its budget: this call falls back; down only once its grace runs out", async () => {
  const { primary, router, query, state } = setup({ budgetMs: 100, graceMs: 400 });
  await router.probeNow();
  primary.mode = "hang";
  const started = performance.now();
  expect(from(await query.embed(["a"]))).toEqual([2]);
  expect(performance.now() - started).toBeLessThan(350);
  expect(state().state).toBe("up"); // maybe just loading the model
  const calls = primary.embedCalls;
  expect(from(await query.embed(["b"]))).toEqual([2]); // a request is still out: straight to the fallback
  expect(primary.embedCalls).toBe(calls);
  await Bun.sleep(450);
  expect(primary.aborted).toBe(1);
  expect(state()).toMatchObject({ state: "down", lastError: expect.stringContaining("no answer") });
});

test("a cold model load is not 'down': the slow call falls back once, the load finishes, the next call uses the primary", async () => {
  const { primary, fallback, router, query, state } = setup({ budgetMs: 100, graceMs: 2000 });
  await router.probeNow();
  primary.mode = "slow";
  primary.delayMs = 300;
  expect(from(await query.embed(["q1"]))).toEqual([2]);
  await Bun.sleep(350);
  expect(state().state).toBe("up");
  primary.mode = "ok";
  expect(from(await query.embed(["q2"]))).toEqual([1]);
  expect(fallback.embedCalls).toBe(1);
});

test("a caller (search) that gives up while a Mac it already fell back from is still silent marks the Mac down (I3)", async () => {
  const { primary, router, query, state } = setup({ budgetMs: 100, graceMs: 10_000 });
  await router.probeNow();
  primary.mode = "hang";
  const ctrl = new AbortController();
  const p = query.embed(["q"], ctrl.signal);
  expect(from(await p)).toEqual([2]); // fell back after 100 ms; the Mac request is still out
  ctrl.abort(); // the search's own timeout
  await Bun.sleep(20);
  expect(state()).toMatchObject({ state: "down", lastError: expect.stringContaining("gave up") });
});

test("machine endpoints are asked to keep the model loaded 30 minutes; the fallback keeps its own setting (-1)", async () => {
  const { primary, fallback, router, query } = setup();
  await router.probeNow();
  await query.embed(["a"]);
  primary.mode = "503";
  await query.embed(["b"]);
  expect(primary.keepAlive.every((k) => k === "30m")).toBe(true);
  expect(primary.keepAlive.length).toBeGreaterThanOrEqual(2);
  expect(fallback.keepAlive).toEqual([-1]);
});

test("a primary answering with the wrong dims never yields vectors: it falls back and is marked down", async () => {
  const { primary, router, query, state } = setup();
  await router.probeNow();
  primary.mode = "dims768";
  const v = await query.embed(["a"]);
  expect(v[0]).toHaveLength(DIMS);
  expect(from(v)).toEqual([2]);
  expect(state().state).toBe("down");
});

test("a non-transient error from the primary (bad input) is not retried on the fallback", async () => {
  const { primary, fallback, router, query, state } = setup();
  await router.probeNow();
  primary.mode = "400";
  const e = await query.embed(["a"]).catch((x) => x);
  expect(e).toBeInstanceOf(EmbedderError);
  expect(e.transient).toBe(false);
  expect(e.message).toContain("400");
  expect(fallback.embedCalls).toBe(0);
  expect(state().state).toBe("up"); // the input was bad, not the primary
});

test("the caller's abort cancels the primary request in flight and does not fall back", async () => {
  const { primary, fallback, router, query, state } = setup();
  await router.probeNow();
  primary.mode = "hang";
  primary.started = Promise.withResolvers<void>();
  const ctrl = new AbortController();
  const p = query.embed(["a"], ctrl.signal).catch((x) => x);
  await primary.started.promise;
  ctrl.abort();
  expect(await p).toBeInstanceOf(EmbedderError);
  await Bun.sleep(20);
  expect(primary.aborted).toBe(1);
  expect(fallback.embedCalls).toBe(0);
  expect(state().state).toBe("up"); // a cancelled search inside the budget says nothing about the primary
});

test("the caller's abort cancels the fallback request in flight", async () => {
  const { fallback, query } = setup(); // never probed: the query goes to the Zima
  fallback.mode = "hang";
  const ctrl = new AbortController();
  const p = query.embed(["a"], ctrl.signal).catch((x) => x);
  await fallback.started.promise;
  ctrl.abort();
  expect(await p).toBeInstanceOf(EmbedderError);
  await Bun.sleep(20);
  expect(fallback.aborted).toBe(1);
});

test("digest: the 12-hex prefix or the full sha256 both match; a bare model name in /api/tags matches too", async () => {
  for (const digest of ["790764642607", DIGEST]) {
    const { router, state } = setup({ digest });
    await router.probeNow();
    expect(state().state).toBe("up");
  }
  const { primary, router, state } = setup();
  primary.models = [{ name: "nomic-embed-text:latest", digest: "f".repeat(64) }, { name: "bge-m3", digest: DIGEST }];
  await router.probeNow();
  expect(state().state).toBe("up");
});

test("digest: a mismatch keeps the Mac out (queries use the Zima, nothing is embedded there) and is picked up once fixed", async () => {
  const { primary, router, query, state, advance, logs } = setup();
  primary.models = [{ name: "bge-m3:latest", digest: OTHER }];
  await router.probeNow();
  expect(state()).toMatchObject({ state: "digest_mismatch", lastError: expect.stringContaining("0123456789ab") });
  expect(primary.embedCalls + primary.canaryCalls).toBe(0); // not even the canary is sent to a mismatched model
  expect(from(await query.embed(["a"]))).toEqual([2]);
  expect(logs.some((l) => l.level === "warn" && /digest/.test(l.msg))).toBe(true);
  primary.models = [{ name: "bge-m3:latest", digest: DIGEST }];
  advance(PRIMARY_DOWN_MS - 1);
  await router.probeNow();
  expect(state().state).toBe("digest_mismatch");
  advance(1);
  await router.probeNow();
  expect(state()).toMatchObject({ state: "up", lastError: null });
  expect(from(await query.embed(["b"]))).toEqual([1]);
});

test("digest: the model missing on the Mac counts as a mismatch", async () => {
  const { primary, router, state } = setup();
  primary.models = [];
  await router.probeNow();
  expect(state()).toMatchObject({ state: "digest_mismatch", lastError: expect.stringContaining("not found") });
});

test("digest: re-checked every 5 minutes while up; a model swapped mid-run is caught (I1)", async () => {
  const { primary, router, query, state, advance } = setup();
  await router.probeNow();
  const tags = primary.tagCalls;
  advance(DIGEST_RECHECK_MS - 1);
  await router.probeNow();
  expect(primary.tagCalls).toBe(tags);
  primary.models = [{ name: "bge-m3:latest", digest: OTHER }]; // `ollama pull` fetched a new manifest
  advance(1);
  await router.probeNow();
  expect(primary.tagCalls).toBe(tags + 1);
  expect(state().state).toBe("digest_mismatch");
  const calls = primary.embedCalls;
  expect(from(await query.embed(["a"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(calls);
});

test("digest: a vector that will be stored is only returned if the Mac's digest still matches after it was made (I1)", async () => {
  const { primary, router, storing, state } = setup();
  await router.probeNow();
  expect(from(await storing.embed(["kept"]))).toEqual([1]);
  primary.models = [{ name: "bge-m3:latest", digest: OTHER }]; // swapped between probes
  expect(from(await storing.embed(["dropped"]))).toEqual([2]); // the Mac's vector is discarded; the Zima's is used
  expect(primary.inputs.flat()).toContain("dropped");
  expect(state().state).toBe("digest_mismatch");
  const lane = router.lanes()[0];
  expect(lane.blocked()).toBe(true);
});

test("digest: an unreachable /api/tags is down (not a mismatch)", async () => {
  const { primary, router, state } = setup();
  primary.server.stop(true);
  await router.probeNow();
  expect(state().state).toBe("down");
});

test("concurrent probes share one check", async () => {
  const { primary, router } = setup();
  await Promise.all([router.probeNow(), router.probeNow(), router.probeNow()]);
  expect(primary.tagCalls).toBe(1);
});

test("the Zima's own digest is checked against EMBED_MODEL_DIGEST: a mismatch keeps every Mac out (I1)", async () => {
  const { primary, fallback, router, query, state, logs } = setup();
  fallback.models = [{ name: "bge-m3:latest", digest: OTHER }];
  await router.probeNow();
  expect(router.status().fallback).toMatchObject({ state: "digest_mismatch", lastError: expect.stringContaining("0123456789ab") });
  expect(state().state).toBe("up"); // the Mac itself is fine…
  expect(router.lanes()[0].blocked()).toBe(true); // …but unused: its vectors would not match the Zima's
  expect(from(await query.embed(["a"]))).toEqual([2]);
  expect(primary.inputs.flat()).not.toContain("a");
  expect(logs.some((l) => l.level === "warn" && /Zima|fallback/.test(l.msg))).toBe(true);
});

test("Macs stay unused until the Zima's digest has been confirmed (it was unreachable at start)", async () => {
  const { fallback, router, advance } = setup();
  fallback.server.stop(true);
  await router.probeNow();
  expect(router.status().fallback.state).toBe("unreachable");
  expect(router.lanes()[0].blocked()).toBe(true);
  advance(30_000);
  await router.probeNow(); // retried; still unreachable
  expect(router.status().fallback.state).toBe("unreachable");
});

test("a router with machine endpoints refuses to run without a digest", () => {
  expect(() => createEmbedRouter({
    machineUrls: { "mac-mini": "http://127.0.0.1:1" }, fallbackUrl: "http://127.0.0.1:2", model: "bge-m3", dims: DIMS, digest: null,
  })).toThrow(/digest/);
});

test("status shows URLs without credentials", async () => {
  const fallback = fakeOllama(2);
  live.push(fallback);
  const router = createEmbedRouter({
    machineUrls: { "mac-mini": "http://user:s3cret@127.0.0.1:1" }, fallbackUrl: fallback.url, model: "bge-m3", dims: DIMS,
    digest: "790764642607", log: () => {},
  });
  await router.probeNow();
  const s = router.status();
  expect(JSON.stringify(s)).not.toContain("s3cret");
  expect(s.endpoints[0].url).toBe("http://127.0.0.1:1/");
});

test("the primary's budget is short for a query and grows with the text, capped; a Mac wait plus an idle Zima fits the search budget", () => {
  expect(primaryBudgetMs(["what did we decide about pricing"])).toBeLessThanOrEqual(2100);
  expect(primaryBudgetMs(["what did we decide about pricing"])).toBeGreaterThanOrEqual(2000);
  const chunk = "x".repeat(1600);
  expect(primaryBudgetMs([chunk])).toBeGreaterThan(2000);
  expect(primaryBudgetMs([chunk])).toBeLessThan(3000);
  expect(primaryBudgetMs(new Array(10_000).fill(chunk))).toBe(60_000);
  expect(PRIMARY_BASE_MS + 450).toBeLessThan(QUERY_EMBED_TIMEOUT_MS);
});

test("M6: 1000 calls leave no timers behind and create no AbortSignal.timeout", async () => {
  const { router, query, storing } = setup();
  await router.probeNow();
  const realTimeout = AbortSignal.timeout;
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let timeouts = 0;
  const open = new Set<unknown>();
  (AbortSignal as any).timeout = (ms: number) => { timeouts++; return realTimeout.call(AbortSignal, ms); };
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const id = realSet(() => { open.delete(id); fn(...a); }, ms);
    open.add(id);
    return id;
  };
  (globalThis as any).clearTimeout = (id: any) => { open.delete(id); realClear(id); };
  try {
    for (let i = 0; i < 500; i++) await query.embed([`q${i}`]);
    for (let i = 0; i < 500; i++) await storing.embed([`s${i}`]);
    for (let i = 0; i < 100; i++) await router.lanes()[0].embedder.embed([`l${i}`]);
  } finally {
    (AbortSignal as any).timeout = realTimeout;
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  expect(timeouts).toBe(0);
  expect(open.size).toBe(0);
});
