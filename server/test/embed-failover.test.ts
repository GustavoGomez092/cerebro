import { test, expect, afterEach } from "bun:test";
import { failoverEmbedder, primaryBudgetMs, PRIMARY_DOWN_MS } from "../src/embed/failover";
import { EmbedderError } from "../src/embed/embedder";
import { ollamaEmbedder } from "../src/embed/ollama";

const DIMS = 1024;
const MODEL = "bge-m3";
const DIGEST = "790764642607" + "b".repeat(52);

type Mode = "ok" | "503" | "400" | "hang" | "dims768";

/** A stand-in Ollama on a random port: /api/tags and /api/embed, answering vectors filled with `fill`. */
function fakeOllama(fill: number) {
  const s = {
    mode: "ok" as Mode,
    models: [{ name: `${MODEL}:latest`, digest: DIGEST }] as { name: string; digest: string }[],
    embedCalls: 0, tagCalls: 0, aborted: 0,
    inputs: [] as string[][],
    started: Promise.withResolvers<void>(),
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/tags") { s.tagCalls++; return Response.json({ models: s.models }); }
      if (path !== "/api/embed") return new Response("no", { status: 404 });
      s.embedCalls++;
      const body = (await req.json()) as { input: string[] };
      s.inputs.push(body.input);
      s.started.resolve();
      if (s.mode === "hang") {
        await new Promise((r) => req.signal.addEventListener("abort", () => { s.aborted++; r(null); }));
        return new Response("", { status: 500 });
      }
      if (s.mode === "503") return new Response("busy", { status: 503 });
      if (s.mode === "400") return new Response("bad input", { status: 400 });
      const dims = s.mode === "dims768" ? 768 : DIMS;
      return Response.json({ embeddings: body.input.map(() => new Array(dims).fill(fill)) });
    },
  });
  return Object.assign(s, { url: `http://127.0.0.1:${server.port}`, server });
}

const servers: { server: ReturnType<typeof Bun.serve> }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.server.stop(true); });

function setup(opts: { digest?: string | null; primary?: boolean; budgetMs?: number } = {}) {
  const primary = fakeOllama(1);
  const fallback = fakeOllama(2);
  servers.push(primary, fallback);
  let t = 1_000_000;
  const logs: any[] = [];
  const embedder = failoverEmbedder({
    primaryUrl: opts.primary === false ? null : primary.url,
    fallbackUrl: fallback.url,
    model: MODEL, dims: DIMS, digest: opts.digest ?? null,
    now: () => t,
    log: (l) => logs.push(JSON.parse(l)),
    ...(opts.budgetMs ? { primaryBudgetMs: () => opts.budgetMs! } : {}),
  });
  return { primary, fallback, embedder, logs, advance: (ms: number) => { t += ms; } };
}

const from = (v: number[][]) => v.map((x) => x[0]);

test("primary is used when it is up", async () => {
  const { primary, fallback, embedder } = setup();
  expect(from(await embedder.embed(["a", "b"]))).toEqual([1, 1]);
  expect(primary.inputs).toEqual([["a", "b"]]);
  expect(fallback.embedCalls).toBe(0);
  expect(embedder.routing()).toMatchObject({ primary: { url: primary.url, state: "up", lastError: null }, lastUsed: "primary" });
});

test("a transiently failing primary falls back within the same call, then is skipped for 60 s", async () => {
  const { primary, fallback, embedder, advance, logs } = setup();
  primary.mode = "503";
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(1);
  expect(fallback.inputs).toEqual([["a"]]);
  const r = embedder.routing();
  expect(r).toMatchObject({ primary: { state: "down" }, lastUsed: "fallback" });
  expect(r.primary.lastError).toContain("503");
  expect(logs.some((l) => l.level === "warn" && /embedder unavailable/.test(l.msg))).toBe(true);

  primary.mode = "ok"; // back, but the 60 s window is not over: not contacted
  advance(PRIMARY_DOWN_MS - 1);
  expect(from(await embedder.embed(["b"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(1);
});

test("an unreachable primary (connection refused) falls back", async () => {
  const { primary, embedder } = setup();
  primary.server.stop(true);
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(embedder.routing()).toMatchObject({ primary: { state: "down" }, lastUsed: "fallback" });
});

test("after the 60 s window the primary is probed again: used when back, down again when not", async () => {
  const { primary, embedder, advance } = setup();
  primary.mode = "503";
  await embedder.embed(["a"]);
  advance(PRIMARY_DOWN_MS);
  expect(from(await embedder.embed(["b"]))).toEqual([2]); // still failing: probed, fell back
  expect(primary.embedCalls).toBe(2);
  advance(PRIMARY_DOWN_MS - 1);
  await embedder.embed(["c"]);
  expect(primary.embedCalls).toBe(2); // a fresh window from the failed probe
  advance(1);
  primary.mode = "ok";
  expect(from(await embedder.embed(["d"]))).toEqual([1]);
  expect(embedder.routing()).toMatchObject({ primary: { state: "up", lastError: null }, lastUsed: "primary" });
});

test("a primary that doesn't answer within its budget falls back, and its request is cancelled", async () => {
  const { primary, embedder } = setup({ budgetMs: 100 });
  primary.mode = "hang";
  const started = performance.now();
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(performance.now() - started).toBeLessThan(2000);
  await Bun.sleep(20);
  expect(primary.aborted).toBe(1);
  expect(embedder.routing().primary.state).toBe("down");
});

test("a primary answering with the wrong dims never yields vectors: it falls back and is marked down", async () => {
  const { primary, embedder } = setup();
  primary.mode = "dims768";
  const v = await embedder.embed(["a"]);
  expect(v[0]).toHaveLength(DIMS);
  expect(from(v)).toEqual([2]);
  expect(embedder.routing().primary.state).toBe("down");
});

test("a non-transient error from the primary (bad input) is not retried on the fallback", async () => {
  const { primary, fallback, embedder } = setup();
  primary.mode = "400";
  const e = await embedder.embed(["a"]).catch((x) => x);
  expect(e).toBeInstanceOf(EmbedderError);
  expect(e.transient).toBe(false);
  expect(e.message).toContain("400");
  expect(fallback.embedCalls).toBe(0);
  expect(embedder.routing().primary.state).toBe("up"); // the input was bad, not the primary
});

test("the caller's abort cancels the primary request in flight and does not fall back", async () => {
  const { primary, fallback, embedder } = setup();
  primary.mode = "hang";
  const ctrl = new AbortController();
  const p = embedder.embed(["a"], ctrl.signal).catch((x) => x);
  await primary.started.promise;
  ctrl.abort();
  const e = await p;
  expect(e).toBeInstanceOf(EmbedderError);
  await Bun.sleep(20);
  expect(primary.aborted).toBe(1);
  expect(fallback.embedCalls).toBe(0);
  expect(embedder.routing().primary.state).not.toBe("down"); // a cancelled search says nothing about the primary
});

test("the caller's abort cancels the fallback request in flight", async () => {
  const { primary, fallback, embedder } = setup();
  primary.mode = "503";
  fallback.mode = "hang";
  const ctrl = new AbortController();
  const p = embedder.embed(["a"], ctrl.signal).catch((x) => x);
  await fallback.started.promise;
  ctrl.abort();
  expect(await p).toBeInstanceOf(EmbedderError);
  await Bun.sleep(20);
  expect(fallback.aborted).toBe(1);
});

test("digest: checked once before first use, accepting the 12-hex prefix or the full sha256", async () => {
  for (const digest of ["790764642607", DIGEST]) {
    const { primary, embedder } = setup({ digest });
    expect(from(await embedder.embed(["a"]))).toEqual([1]);
    expect(from(await embedder.embed(["b"]))).toEqual([1]);
    expect(primary.tagCalls).toBe(1);
  }
});

test("digest: a bare model name in /api/tags matches too", async () => {
  const { primary, embedder } = setup({ digest: "790764642607" });
  primary.models = [{ name: "nomic-embed-text:latest", digest: "f".repeat(64) }, { name: MODEL, digest: DIGEST }];
  expect(from(await embedder.embed(["a"]))).toEqual([1]);
});

test("digest: a mismatch routes to the fallback without failing the call, and is picked up again once fixed", async () => {
  const { primary, fallback, embedder, advance, logs } = setup({ digest: "790764642607" });
  primary.models = [{ name: `${MODEL}:latest`, digest: "0123456789ab" + "c".repeat(52) }];
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(0); // never embedded with a different model
  expect(fallback.embedCalls).toBe(1);
  const r = embedder.routing();
  expect(r).toMatchObject({ primary: { state: "digest_mismatch" }, lastUsed: "fallback" });
  expect(r.primary.lastError).toContain("0123456789ab");
  expect(logs.some((l) => l.level === "warn" && /digest/.test(l.msg))).toBe(true);

  advance(PRIMARY_DOWN_MS - 1);
  await embedder.embed(["b"]);
  expect(primary.tagCalls).toBe(1); // not re-checked inside the window
  primary.models = [{ name: `${MODEL}:latest`, digest: DIGEST }];
  advance(1);
  expect(from(await embedder.embed(["c"]))).toEqual([1]);
  expect(primary.tagCalls).toBe(2);
  expect(embedder.routing()).toMatchObject({ primary: { state: "up", lastError: null }, lastUsed: "primary" });
});

test("digest: the model missing on the primary counts as a mismatch", async () => {
  const { primary, embedder } = setup({ digest: "790764642607" });
  primary.models = [];
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(primary.embedCalls).toBe(0);
  expect(embedder.routing().primary).toMatchObject({ state: "digest_mismatch", lastError: expect.stringContaining("not found") });
});

test("digest: re-checked on the re-probe after the primary was down", async () => {
  const { primary, embedder, advance } = setup({ digest: "790764642607" });
  await embedder.embed(["a"]);
  expect(primary.tagCalls).toBe(1);
  primary.mode = "503";
  await embedder.embed(["b"]);
  primary.mode = "ok";
  primary.models = [{ name: `${MODEL}:latest`, digest: "0123456789ab" + "c".repeat(52) }]; // swapped while it was down
  advance(PRIMARY_DOWN_MS);
  expect(from(await embedder.embed(["c"]))).toEqual([2]);
  expect(primary.tagCalls).toBe(2);
  expect(embedder.routing().primary.state).toBe("digest_mismatch");
});

test("digest: an unreachable primary during the check is down (not a mismatch) and the call still succeeds", async () => {
  const { primary, embedder } = setup({ digest: "790764642607" });
  primary.server.stop(true);
  expect(from(await embedder.embed(["a"]))).toEqual([2]);
  expect(embedder.routing().primary.state).toBe("down");
});

test("concurrent first calls share one digest check", async () => {
  const { primary, embedder } = setup({ digest: "790764642607" });
  const all = await Promise.all([embedder.embed(["a"]), embedder.embed(["b"]), embedder.embed(["c"])]);
  expect(all.map(from)).toEqual([[1], [1], [1]]);
  expect(primary.tagCalls).toBe(1);
});

test("unset primary behaves exactly like the plain Ollama embedder on EMBED_URL", async () => {
  const { primary, fallback, embedder } = setup({ primary: false, digest: "790764642607" });
  expect(from(await embedder.embed(["a", "b"]))).toEqual([2, 2]);
  expect(fallback.inputs).toEqual([["a", "b"]]);
  expect(primary.embedCalls + primary.tagCalls + fallback.tagCalls).toBe(0);
  expect(embedder.routing()).toEqual({
    primary: { url: null, state: "unset", lastError: null, downUntil: null },
    fallback: { url: fallback.url },
    lastUsed: "fallback",
  });
  // Errors surface exactly as the plain embedder's (the worker's pause/charge logic depends on `transient`).
  const plain = ollamaEmbedder(fallback.url, MODEL, DIMS);
  for (const mode of ["503", "400"] as Mode[]) {
    fallback.mode = mode;
    const a = await embedder.embed(["x"]).catch((x) => x);
    const b = await plain.embed(["x"]).catch((x) => x);
    expect(a).toBeInstanceOf(EmbedderError);
    expect([a.message, a.transient]).toEqual([b.message, b.transient]);
  }
  // The caller's signal still cancels the request.
  fallback.mode = "hang";
  const ctrl = new AbortController();
  const p = embedder.embed(["x"], ctrl.signal).catch((x) => x);
  await fallback.started.promise;
  ctrl.abort();
  expect(await p).toBeInstanceOf(EmbedderError);
});

test("status shows URLs without credentials", async () => {
  const fallback = fakeOllama(2);
  servers.push(fallback);
  const embedder = failoverEmbedder({
    primaryUrl: "http://user:s3cret@127.0.0.1:1", fallbackUrl: fallback.url, model: MODEL, dims: DIMS, log: () => {},
  });
  await embedder.embed(["a"]);
  const r = embedder.routing();
  expect(JSON.stringify(r)).not.toContain("s3cret");
  expect(r.primary.url).toBe("http://127.0.0.1:1/");
});

test("the primary's budget is short for a query and grows with the text, capped", () => {
  expect(primaryBudgetMs(["what did we decide about pricing"])).toBeLessThanOrEqual(2100);
  expect(primaryBudgetMs(["what did we decide about pricing"])).toBeGreaterThanOrEqual(2000);
  const chunk = "x".repeat(1600);
  expect(primaryBudgetMs([chunk])).toBeGreaterThan(2000);
  expect(primaryBudgetMs([chunk])).toBeLessThan(3000);
  expect(primaryBudgetMs(new Array(16).fill(chunk))).toBeGreaterThan(primaryBudgetMs([chunk]));
  expect(primaryBudgetMs(new Array(10_000).fill(chunk))).toBe(60_000);
});
