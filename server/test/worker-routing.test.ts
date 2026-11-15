import { test, expect, afterEach } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";
import { createToken } from "../src/auth";
import { createEmbedRouter, PRIMARY_DOWN_MS } from "../src/embed/failover";
import { embedLanes, newWorkerState, startEmbedWorker } from "../src/worker";
import { fakeOllama } from "./fakes/ollama";

// Machines: "test-mac" (authedApp's token) → the Mac mini (fill 1); "macbook-pro" → the MacBook (fill 3);
// "check" is unmapped. The Zima answers fill 2.
const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

/** The test words in an embed call's texts ("User: alpha www…" → "alpha"). */
const words = (texts: string[]) => texts.map((x) => /User: (\w+)/.exec(x)?.[1]);

async function world(opts: { map?: boolean } = {}) {
  const t = await authedApp();
  const mini = fakeOllama(1), mbp = fakeOllama(3), zima = fakeOllama(2);
  live.push(mini, mbp, zima);
  let clock = 1_000_000;
  const router = createEmbedRouter({
    machineUrls: opts.map === false ? {} : { "test-mac": mini.url, "macbook-pro": mbp.url },
    fallbackUrl: zima.url, model: "bge-m3", dims: 1024, digest: "790764642607", now: () => clock, log: () => {},
  });
  await router.probeNow(); // both Macs up
  const tokens: Record<string, string> = { "test-mac": t.token };
  for (const m of ["macbook-pro", "check"]) tokens[m] = (await createToken(t.sql, m)).token;
  const { binding } = await boundFolder(t);
  /** Uploads a session as `machine`, one chunk per text. */
  const upload = async (machine: string, id: string, texts: string[], imported = false) => {
    const res = await t.call("POST", "/v1/ingest", {
      sessions: [sess(id, binding.id, { imported })],
      events: texts.map((x, i) => ev(id, i + 1, "user", `${x} ${"w".repeat(1000)}`)),
    }, tokens[machine]);
    if (res.status !== 200) throw new Error(`ingest ${res.status}`);
  };
  /** Which endpoint embedded each chunk, by the first word of its text. */
  const embeddedBy = async () => {
    const rows = await t.sql`
      select substring(c.text from 'User: ([a-z]+)') as word, split_part(trim(both '[]' from e.embedding::text), ',', 1)::real as fill
      from chunk_embeddings e join chunks c on c.id = e.chunk_id order by word`;
    return Object.fromEntries(rows.map((r: any) => [r.word, ({ 1: "mini", 2: "zima", 3: "mbp" } as any)[r.fill]]));
  };
  const lanes = () => Object.fromEntries(embedLanes(t.sql, router, { state: newWorkerState() }).map((l) => [l.name, l]));
  return { t, mini, mbp, zima, router, upload, embeddedBy, lanes, advance: (ms: number) => { clock += ms; } };
}

test("each machine's chunks embed only on that machine's endpoint", async () => {
  const w = await world();
  try {
    await w.upload("test-mac", "a1", ["alpha", "apple"]);
    await w.upload("macbook-pro", "b1", ["bravo"]);
    const lanes = w.lanes();
    expect(Object.keys(lanes).sort()).toEqual(["macbook-pro", "test-mac", "zima"]);
    await Promise.all([lanes["test-mac"].run(), lanes["macbook-pro"].run(), lanes.zima.run()]);
    expect(await w.embeddedBy()).toEqual({ alpha: "mini", apple: "mini", bravo: "mbp" });
    expect(w.zima.embedCalls).toBe(0);
  } finally { await w.t.drop(); }
});

test("while A's endpoint is down its chunks wait (no attempt charged, short delay) and B's keep flowing", async () => {
  const w = await world();
  try {
    await w.upload("test-mac", "a1", ["alpha", "apple"]);
    await w.upload("macbook-pro", "b1", ["bravo"]);
    w.mini.mode = "503";
    const lanes = w.lanes();
    const ra = await lanes["test-mac"].run();
    expect(ra).toMatchObject({ claimed: 2, embedded: 0, failed: 0, paused: true });
    const waiting = await w.t.sql`
      select q.attempts, q.locked_until, q.next_attempt_at > now() + interval '10 seconds' as delayed
      from embed_queue q join chunks c on c.id = q.chunk_id where c.session_id = 'a1'`;
    expect(waiting).toEqual([{ attempts: 0, locked_until: null, delayed: true }, { attempts: 0, locked_until: null, delayed: true }]);
    expect(w.mini.embedCalls).toBe(1); // one probe, not one per chunk
    expect(w.mbp.embedCalls + w.zima.embedCalls).toBe(0); // never sent to another Mac or (yet) the Zima

    // Blocked for its down window: the lane doesn't even claim.
    expect(await lanes["test-mac"].run()).toMatchObject({ claimed: 0 });
    expect(await lanes["macbook-pro"].run()).toMatchObject({ claimed: 1, embedded: 1 });
    expect(await w.embeddedBy()).toEqual({ bravo: "mbp" });
  } finally { await w.t.drop(); }
});

test("the Zima lane picks up a down machine's waiting chunks, one per call, but never an up machine's", async () => {
  const w = await world();
  try {
    await w.upload("test-mac", "a1", ["alpha", "apple"]);
    await w.upload("macbook-pro", "b1", ["bravo"]);
    const lanes = w.lanes();
    expect(await lanes.zima.run()).toMatchObject({ claimed: 0 }); // both Macs up (untried): nothing for the Zima

    w.mini.mode = "503";
    await lanes["test-mac"].run(); // A goes down, its chunks wait
    await w.t.sql`update embed_queue set next_attempt_at = now()`; // the short delay has passed
    const r = await lanes.zima.run();
    expect(r).toMatchObject({ embedded: 2, paused: false });
    expect(w.zima.inputs.map(words)).toEqual([["alpha"], ["apple"]]);
    expect(await w.embeddedBy()).toEqual({ alpha: "zima", apple: "zima" }); // bravo stays for the MacBook
    expect(w.mbp.embedCalls).toBe(0);

    // Once A's window is over, A's lane probes again and its new work goes back to A.
    w.mini.mode = "ok";
    w.advance(PRIMARY_DOWN_MS);
    await w.router.probeNow();
    await w.upload("test-mac", "a2", ["avocado"]);
    expect(await lanes.zima.run()).toMatchObject({ claimed: 0 });
    expect(await lanes["test-mac"].run()).toMatchObject({ embedded: 1 });
    expect((await w.embeddedBy()).avocado).toBe("mini");
  } finally { await w.t.drop(); }
});

test("unmapped machines' chunks go to the Zima, live before imported", async () => {
  const w = await world();
  try {
    await w.upload("check", "c-old", ["charlie", "cobalt"], true);
    await w.upload("check", "c-live", ["coral"]);
    const lanes = w.lanes();
    expect(await lanes["test-mac"].run()).toMatchObject({ claimed: 0 });
    await lanes.zima.run();
    expect(words(w.zima.inputs[0])).toEqual(["coral"]);
    expect(await w.embeddedBy()).toEqual({ charlie: "zima", cobalt: "zima", coral: "zima" });
    expect(w.mini.embedCalls + w.mbp.embedCalls).toBe(0);
  } finally { await w.t.drop(); }
});

test("a machine's lane keeps live before imported", async () => {
  const w = await world();
  try {
    await w.upload("test-mac", "a-old", ["amber"], true);
    await w.upload("test-mac", "a-live", ["azure"]);
    await w.lanes()["test-mac"].run();
    expect(w.mini.inputs.map(words)).toEqual([["azure"], ["amber"]]);
  } finally { await w.t.drop(); }
});

test("an empty map is one lane on the Zima for every machine, as today", async () => {
  const w = await world({ map: false });
  try {
    await w.upload("test-mac", "a1", ["alpha"]);
    await w.upload("check", "c1", ["charlie"]);
    const lanes = embedLanes(w.t.sql, w.router, { state: newWorkerState() });
    expect(lanes.map((l) => l.name)).toEqual(["all"]);
    expect(await lanes[0].run()).toMatchObject({ claimed: 2, embedded: 2 });
    expect(await w.embeddedBy()).toEqual({ alpha: "zima", charlie: "zima" });
  } finally { await w.t.drop(); }
});

test("startEmbedWorker runs the lanes independently: a stuck Zima never holds up a Mac's flow", async () => {
  const w = await world();
  w.zima.mode = "hang";
  const worker = startEmbedWorker(w.t.sql, w.router, { state: newWorkerState(), idleMs: 20 });
  try {
    await w.upload("check", "c1", ["charlie"]); // stuck on the Zima
    await w.upload("test-mac", "a1", ["alpha"]);
    await w.upload("macbook-pro", "b1", ["bravo"]);
    for (let i = 0; i < 100 && Object.keys(await w.embeddedBy()).length < 2; i++) await Bun.sleep(20);
    expect(await w.embeddedBy()).toEqual({ alpha: "mini", bravo: "mbp" });
  } finally {
    w.zima.stop(); // releases the hung request
    await worker.stop();
    await w.t.drop();
  }
});
