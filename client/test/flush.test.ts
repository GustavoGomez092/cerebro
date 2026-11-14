import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestEvent, IngestSession } from "@cerebro/shared";
import { createToken, revokeToken } from "../../server/src/auth";
import { ApiClient } from "../src/api";
import { flush } from "../src/flush";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

let h: LiveServer;
let bindingId: string;
let prevHome: string | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  h = await liveServer();
  const c = await h.api.createClient("Acme");
  const p = await h.api.createProject(c.id, "App");
  bindingId = (await h.api.putBinding({ repo: "github.com/acme/flush", subpath: "", status: "active", clientId: c.id, projectId: p.id })).binding.id;
  prevHome = process.env.CEREBRO_HOME;
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prevHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

let n = 0;
const uid = () => `00000000-0000-4000-a000-${String(++n).padStart(12, "0")}`;

function newStore(): Store {
  const d = mkdtempSync(join(tmpdir(), "cerebro-flush-"));
  dirs.push(d);
  process.env.CEREBRO_HOME = d;
  return new Store(join(d, "cerebro.db"));
}
const session = (id: string, bId = bindingId): IngestSession =>
  ({ id, bindingId: bId, cwd: "/w", repo: "github.com/acme/flush", subpath: "", startedAt: "2026-10-20T04:00:00.000Z" });
const events = (sid: string, count: number, text = "hello"): IngestEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `${sid}:${i}`, sessionId: sid, seq: i, ts: "2026-10-20T04:00:01.000Z", kind: "user" as const, text,
  }));
function seeded(count = 5, sid = uid()) {
  const store = newStore();
  store.upsertSession(session(sid));
  const evs = events(sid, count);
  store.enqueueEvents(evs);
  return { store, sid, evs };
}
const serverCount = async (sid: string) => Number((await h.sql`select count(*)::int as n from events where session_id = ${sid}`)[0].n);

test("uploads queued sessions and events, then the queue is empty", async () => {
  const { store, sid } = seeded(5);
  const r = await flush(store, h.api);
  expect(r).toMatchObject({ outcome: "done", sent: 5, duplicates: 0, quarantined: 0 });
  expect(store.pendingCount()).toBe(0);
  expect(store.unsentSessions(10)).toEqual([]);
  expect(await serverCount(sid)).toBe(5);
  expect(store.get("lastFlushAt")).toBeTruthy();
  expect(store.get("instanceId")).toBe(h.instanceId);
  expect((await flush(store, h.api)).outcome).toBe("nothing");
});

test("replaying after a crash mid-flush uploads nothing twice", async () => {
  const { store, sid, evs } = seeded(4);
  await flush(store, h.api);
  store.enqueueEvents(evs);
  const r = await flush(store, h.api);
  expect(r.duplicates).toBe(4);
  expect(r.sent).toBe(0);
  expect(await serverCount(sid)).toBe(4);
  expect(store.pendingCount()).toBe(0);
});

test("an impostor server never receives the token or data", async () => {
  const { store } = seeded(2);
  store.set("instanceId", "instance-A");
  const seen: { method: string; path: string; auth: string | null }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
    return Response.json({ ok: true, instanceId: "instance-B", apiVersion: 1 });
  }) as typeof fetch;
  const api = new ApiClient({ serverUrl: TEST_URL, token: "secret" }, fake);
  const r = await flush(store, api);
  expect(r.outcome).toBe("instance_mismatch");
  expect(seen).toEqual([{ method: "GET", path: "/health", auth: null }]);
  expect(store.get("blocked")).toBe("instance_mismatch");
  expect(store.pendingCount()).toBe(2);
  expect((await flush(store, api)).outcome).toBe("blocked");
  expect(seen.length).toBe(1);
});

test("unreachable server backs off and keeps everything", async () => {
  const { store } = seeded(3);
  const api = new ApiClient({ serverUrl: TEST_URL, token: "t" }, (async () => { throw new TypeError("down"); }) as unknown as typeof fetch);
  const t = 1_000_000;
  const r = await flush(store, api, { now: () => t });
  expect(r.outcome).toBe("unreachable");
  expect(store.pendingCount()).toBe(3);
  expect(Number(store.get("backoffUntil"))).toBe(t + 30_000);
  expect((await flush(store, api, { now: () => t + 1000 })).outcome).toBe("backoff");
  const r2 = await flush(store, api, { now: () => t + 31_000 });
  expect(r2.outcome).toBe("unreachable");
  expect(Number(store.get("backoffMs"))).toBe(60_000);
});

test("413 halves the batch until it fits", async () => {
  const { store, sid } = seeded(10);
  const bodies: number[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname === "/v1/ingest") {
      const body = JSON.parse(await req.clone().text());
      bodies.push(body.events.length);
      if (body.events.length > 3) return Response.json({ error: "batch_too_large", message: "x" }, { status: 413 });
    }
    return h.fetch(req);
  }) as typeof fetch;
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, wrapped);
  const r = await flush(store, api);
  expect(r.outcome).toBe("done");
  expect(store.pendingCount()).toBe(0);
  expect(await serverCount(sid)).toBe(10);
  expect(bodies[0]).toBe(10);
  expect(Math.max(...bodies.slice(1))).toBeLessThanOrEqual(5);
});

test("a single event over the byte limit is quarantined as too_large, not retried forever", async () => {
  const sid = uid();
  const store = newStore();
  store.upsertSession(session(sid));
  const small = events(sid, 2, "ok").map((e) => ({ ...e, key: `${e.key}:ok`, seq: e.seq + 10 }));
  store.enqueueEvents([...events(sid, 1, "x".repeat(2000)), ...small]);
  const r = await flush(store, h.api, { maxBytes: 64 * 1024 + 1000 });
  expect(r.quarantined).toBe(1);
  expect(store.quarantineCount()).toBe(1);
  expect(store.pendingCount()).toBe(0);
  expect(await serverCount(sid)).toBe(2);
});

test("rejected items are quarantined and the rest is acknowledged", async () => {
  const sid = uid();
  const store = newStore();
  store.upsertSession(session(sid));
  const evs = events(sid, 3);
  evs[1] = { ...evs[1], ts: "0000-01-01T00:00:00Z" };
  store.enqueueEvents(evs);
  const r = await flush(store, h.api);
  expect(r.quarantined).toBe(1);
  expect(store.quarantineCount()).toBe(1);
  expect(store.pendingCount()).toBe(0);
  expect(await serverCount(sid)).toBe(2);
});

test("a session with an unknown binding is dropped: events quarantined, cursor and binding cache cleared", async () => {
  const sid = uid();
  const store = newStore();
  store.upsertSession(session(sid, "99999999-9999-4999-a999-999999999999"));
  store.enqueueEvents(events(sid, 2));
  store.cacheBinding("github.com/acme/flush", "", { id: "x", repo: "github.com/acme/flush", subpath: "", status: "active", clientId: null, projectId: null });
  store.setCursor("/t/a.jsonl", { source: "claude-code", sessionId: sid, offset: 0, line: 0, state: null, bindingId: "x", cwd: "/w", repo: "github.com/acme/flush", subpath: "" });
  const r = await flush(store, h.api);
  expect(r.quarantined).toBe(2);
  expect(store.pendingCount()).toBe(0);
  expect(store.openCursors()).toEqual([]);
  expect(store.cachedBinding("github.com/acme/flush", "")?.binding).toBeNull();
  expect(store.unsentSessions(10)).toEqual([]);
});

test("a revoked token stops uploading until retried", async () => {
  const { store } = seeded(2);
  const { token } = await createToken(h.sql, "doomed-flush");
  await revokeToken(h.sql, "doomed-flush");
  const api = new ApiClient({ serverUrl: TEST_URL, token }, h.fetch);
  const r = await flush(store, api);
  expect(r.outcome).toBe("blocked");
  expect(store.get("blocked")).toBe("token_revoked");
  expect(store.pendingCount()).toBe(2);
  expect((await flush(store, api)).outcome).toBe("blocked");
});

test("concurrent flushes never send the same batch twice", async () => {
  const { store, sid } = seeded(6);
  const [a, b] = await Promise.all([flush(store, h.api), flush(store, h.api)]);
  expect([a.outcome, b.outcome].sort()).toEqual(["done", "locked"]);
  expect(await serverCount(sid)).toBe(6);
});

test("end option closes the session after its events are uploaded", async () => {
  const { store, sid } = seeded(2);
  const endedAt = "2026-10-20T05:00:00.000Z";
  await flush(store, h.api, { end: { sessionId: sid, endedAt } });
  const [row] = await h.sql`select ended_at from sessions where id = ${sid}`;
  expect(new Date(row.ended_at).toISOString()).toBe(endedAt);
});

test("a store failure returns an outcome, releases the lock and does not throw", async () => {
  const store = newStore();
  const broken = Object.create(store) as Store;
  broken.unsentSessions = () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); };
  const r = await flush(broken, h.api);
  expect(r.outcome).toBe("error");
  expect(store.tryLock("flush", 1000)).toBe(true);
  store.unlock("flush");
});

test("stops starting new requests once the deadline passes", async () => {
  const { store } = seeded(6);
  let t = 0;
  const r = await flush(store, h.api, { maxEvents: 2, deadlineMs: 1000, now: () => (t += 600) });
  expect(r.outcome).toBe("done");
  expect(store.pendingCount()).toBeGreaterThan(0);
});
