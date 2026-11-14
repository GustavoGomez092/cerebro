import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Binding, IngestEvent, IngestSession } from "@cerebro/shared";
import { Store } from "../src/store";

let prev: string | undefined;
const dirs: string[] = [];
beforeAll(() => { prev = process.env.CEREBRO_HOME; });
afterAll(() => {
  if (prev === undefined) delete process.env.CEREBRO_HOME; else process.env.CEREBRO_HOME = prev;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cerebro-store-"));
  dirs.push(d);
  return d;
}
function fresh(): Store {
  process.env.CEREBRO_HOME = tmp();
  return new Store();
}
const ev = (sessionId: string, key: string, seq = 0): IngestEvent => ({ key, sessionId, seq, ts: "2026-01-01T00:00:00Z", kind: "user", text: "hi " + key });
const sess = (id: string, cwd = "/a"): IngestSession => ({ id, bindingId: "b1", cwd, repo: "r", startedAt: "2026-01-01T00:00:00Z" });

test("events dedupe on (session, key) and come out in insertion order within size limits", () => {
  const s = fresh();
  const evs = [ev("s", "a", 0), ev("s", "b", 1), ev("s", "c", 2)];
  s.enqueueEvents(evs);
  s.enqueueEvents(evs);
  expect(s.pendingCount()).toBe(3);
  expect(s.nextEvents(2, 1e9).map((e) => e.key)).toEqual(["a", "b"]);
  const first = Buffer.byteLength(JSON.stringify(evs[0]));
  expect(s.nextEvents(10, first).map((e) => e.key)).toEqual(["a"]);
  expect(s.nextEvents(10, 1).map((e) => e.key)).toEqual(["a"]); // always at least one
  s.close();
});

test("ack and quarantine remove events from the queue", () => {
  const s = fresh();
  s.enqueueEvents([ev("s", "a"), ev("s", "b"), ev("t", "a")]);
  s.ackEvents([{ sessionId: "s", key: "a" }]);
  expect(s.pendingCount()).toBe(2);
  s.quarantineEvents([{ event: ev("s", "b"), code: "invalid_event" }]);
  expect(s.pendingCount()).toBe(1);
  expect(s.quarantineCount()).toBe(1);
  expect(s.nextEvents(10, 1e9).map((e) => `${e.sessionId}/${e.key}`)).toEqual(["t/a"]);
  s.close();
});

test("two processes can write at once without 'database is locked'", async () => {
  const dir = tmp();
  const storePath = resolve(import.meta.dir, "../src/store.ts");
  const code = `
    import { Store } from ${JSON.stringify(storePath)};
    const id = process.argv[1];
    const s = new Store();
    for (let i = 0; i < 500; i++) s.enqueueEvents([{ key: id + "-" + i, sessionId: "s" + id, seq: i, ts: "t", kind: "user", text: "x" }]);
    s.close();
  `;
  const procs = [0, 1, 2, 3].map((i) =>
    Bun.spawn(["bun", "-e", code, String(i)], { env: { ...process.env, CEREBRO_HOME: dir }, stderr: "pipe" }));
  const codes = await Promise.all(procs.map((p) => p.exited));
  const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
  expect(errs.join("")).toBe("");
  expect(codes).toEqual([0, 0, 0, 0]);
  process.env.CEREBRO_HOME = dir;
  const s = new Store();
  expect(s.pendingCount()).toBe(2000);
  s.close();
});

test("only one holder gets a lock; a dead holder's lock is stolen", () => {
  const s = fresh();
  expect(s.tryLock("flush", 60_000)).toBe(true);
  expect(s.tryLock("flush", 60_000)).toBe(false);
  const raw = new Database(join(process.env.CEREBRO_HOME!, "cerebro.db"));
  raw.run("update locks set owner_pid = 2147483646 where name = 'flush'");
  expect(s.tryLock("flush", 60_000)).toBe(true);
  s.unlock("flush");
  expect(s.tryLock("flush", 60_000)).toBe(true);
  raw.run("update locks set until = 1 where name = 'flush'"); // expired
  expect(s.tryLock("flush", 60_000)).toBe(true);
  raw.close();
  s.close();
});

test("binding cache distinguishes unknown from known-unbound", () => {
  const s = fresh();
  expect(s.cachedBinding("r", "")).toBeUndefined();
  s.cacheBinding("r", "", null);
  const unbound = s.cachedBinding("r", "");
  expect(unbound?.binding).toBeNull();
  expect(typeof unbound?.at).toBe("string");
  const b: Binding = { id: "b1", repo: "r", subpath: "p", status: "active", clientId: null, projectId: null };
  s.cacheBinding("r", "p", b);
  expect(s.cachedBinding("r", "p")?.binding).toEqual(b);
  s.close();
});

test("cursors round-trip, list open ones, and markDone closes them", () => {
  const s = fresh();
  expect(s.getCursor("/t.jsonl")).toBeUndefined();
  s.setCursor("/t.jsonl", { source: "claude", sessionId: "s", offset: 10, line: 2, state: { a: 1 }, bindingId: "b1", cwd: "/a", repo: "r", subpath: "" });
  s.setCursor("/u.jsonl", { source: "claude", sessionId: "u", offset: 0, line: 0, state: null, bindingId: null, cwd: "/a", repo: "r", subpath: "" });
  const c = s.getCursor("/t.jsonl")!;
  expect(c).toMatchObject({ transcriptPath: "/t.jsonl", source: "claude", sessionId: "s", offset: 10, line: 2, state: { a: 1 }, bindingId: "b1", cwd: "/a", repo: "r", subpath: "", done: false });
  expect(s.openCursors()).toHaveLength(2);
  s.markDone("/t.jsonl");
  expect(s.openCursors().map((x) => x.transcriptPath)).toEqual(["/u.jsonl"]);
  expect(s.getCursor("/t.jsonl")!.done).toBe(true);
  s.close();
});

test("boundFolders lists the distinct folders of cursors that have a binding, done or not", () => {
  const s = fresh();
  const c = { source: "codex", sessionId: "s", offset: 0, line: 0, state: null, cwd: "/a", repo: "r", subpath: "" };
  s.setCursor("/1.jsonl", { ...c, bindingId: "b1" });
  s.setCursor("/2.jsonl", { ...c, bindingId: "b1" });
  s.setCursor("/3.jsonl", { ...c, bindingId: "b2", cwd: "/b" });
  s.setCursor("/4.jsonl", { ...c, bindingId: null, cwd: "/unbound" });
  s.markDone("/3.jsonl");
  expect(s.boundFolders().sort()).toEqual(["/a", "/b"]);
  s.close();
});

test("sessions: upsert re-marks unsent only when changed", () => {
  const s = fresh();
  s.upsertSession(sess("a"));
  s.upsertSession(sess("b"));
  expect(s.unsentSessions(10).map((x) => x.id)).toEqual(["a", "b"]);
  s.markSessionsSent(s.unsentSessions(10));
  expect(s.unsentSessions(10)).toEqual([]);
  s.upsertSession(sess("a")); // unchanged
  expect(s.unsentSessions(10)).toEqual([]);
  s.upsertSession(sess("a", "/changed"));
  expect(s.unsentSessions(10).map((x) => x.cwd)).toEqual(["/changed"]);
  expect(s.unsentSessions(0)).toEqual([]);
  s.close();
});

test("markSessionsSent does not swallow an update that landed after the read", () => {
  const s = fresh();
  s.upsertSession(sess("A"));
  const read = s.unsentSessions(10);
  s.upsertSession(sess("A", "/v2"));
  s.markSessionsSent(read);
  expect(s.unsentSessions(10).map((x) => x.cwd)).toEqual(["/v2"]);
  s.close();
});

test("setCursor reopens a cursor that was marked done", () => {
  const s = fresh();
  const c = { source: "claude", sessionId: "s", offset: 1, line: 1, state: null, bindingId: null, cwd: "/a", repo: "r", subpath: "" };
  s.setCursor("/t.jsonl", c);
  s.markDone("/t.jsonl");
  expect(s.openCursors()).toHaveLength(0);
  s.setCursor("/t.jsonl", { ...c, offset: 2 });
  expect(s.openCursors().map((x) => x.offset)).toEqual([2]);
  s.close();
});

test("pending session ends persist, keep the latest time, and are removed only when the sent time still matches", () => {
  const s = fresh();
  s.addPendingEnd("s1", "2026-01-01T01:00:00.000Z");
  s.addPendingEnd("s1", "2026-01-01T02:00:00.000Z");
  s.addPendingEnd("s2", "2026-01-01T03:00:00.000Z");
  expect(s.pendingEnds()).toEqual([
    { sessionId: "s1", endedAt: "2026-01-01T02:00:00.000Z" },
    { sessionId: "s2", endedAt: "2026-01-01T03:00:00.000Z" },
  ]);
  s.removePendingEnd("s1", "2026-01-01T01:00:00.000Z");
  expect(s.pendingEnds().length).toBe(2);
  s.removePendingEnd("s1", "2026-01-01T02:00:00.000Z");
  expect(s.pendingEnds().map((e) => e.sessionId)).toEqual(["s2"]);
  s.close();
});

test("state get/set", () => {
  const s = fresh();
  expect(s.get("instanceId")).toBeUndefined();
  s.set("instanceId", "x");
  s.set("instanceId", "y");
  expect(s.get("instanceId")).toBe("y");
  s.close();
});
