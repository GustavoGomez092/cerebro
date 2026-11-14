import type { IngestEvent, IngestRejection, IngestSession } from "@cerebro/shared";
import { ApiError, type ApiClient } from "./api";
import { sweepOpenCursors } from "./capture";
import type { BlockedReason, Store } from "./store";

export type FlushOutcome = "done" | "nothing" | "locked" | "backoff" | "unreachable" | "blocked" | "instance_mismatch" | "error";

export interface FlushResult { sent: number; duplicates: number; quarantined: number; outcome: FlushOutcome }

export interface FlushOptions {
  maxEvents?: number;
  /** Cap on the encoded size of one batch (default 8 MB, under the server's 10 MB body limit). */
  maxBytes?: number;
  /** Stop starting new requests after this long (default 120 000). */
  deadlineMs?: number;
  now?: () => number;
  /** After uploading, tell the server this session ended (used by the detached SessionEnd flush). */
  end?: { sessionId: string; endedAt: string };
}

const LOCK_TTL_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** The event byte budget ignores the JSON array and session rows, so keep this much in reserve. */
const HEADROOM_BYTES = 64 * 1024;
const MAX_SESSIONS = 200;

/** Uploads the local queue to the server. Never throws: every failure becomes an outcome. */
export async function flush(store: Store, api: ApiClient, opts: FlushOptions = {}): Promise<FlushResult> {
  const now = opts.now ?? Date.now;
  const result: FlushResult = { sent: 0, duplicates: 0, quarantined: 0, outcome: "nothing" };
  const finish = (outcome: FlushOutcome): FlushResult => { result.outcome = outcome; return result; };

  let locked = false;
  try {
    if (!store.tryLock("flush", LOCK_TTL_MS)) return finish("locked");
    locked = true;

    const blocked = store.get("blocked");
    if (blocked) return finish("blocked");
    const until = Number(store.get("backoffUntil") ?? 0);
    if (until && now() < until) return finish("backoff");

    // The lock must outlive the run: stop before it could expire, leaving room for the last request.
    const start = now();
    const deadlineMs = Math.min(opts.deadlineMs ?? 120_000, LOCK_TTL_MS - 2 * REQUEST_TIMEOUT_MS - 60_000);
    const fail = (): FlushResult => {
      const prev = Number(store.get("backoffMs") ?? 0);
      const ms = prev ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
      store.set("backoffMs", String(ms));
      store.set("backoffUntil", String(now() + ms));
      return finish("unreachable");
    };
    const block = (e: ApiError): FlushResult => {
      store.set("blocked", e.code === "token_revoked" ? "token_revoked" satisfies BlockedReason : "unauthorized");
      return finish("blocked");
    };

    sweepOpenCursors(store);

    // Preflight on an unauthenticated route, so an impostor never sees the token or any data.
    try {
      const health = await api.health({ timeoutMs: HEALTH_TIMEOUT_MS });
      if (!health.ok || !health.instanceId) return fail();
      const pinned = store.get("instanceId");
      if (pinned === undefined) store.set("instanceId", health.instanceId);
      else if (pinned !== health.instanceId) {
        store.set("blocked", "instance_mismatch");
        return finish("instance_mismatch");
      }
    } catch (e) {
      if (e instanceof ApiError) return fail();
      throw e;
    }

    let maxEvents = opts.maxEvents ?? 2000;
    let maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    let maxSessions = MAX_SESSIONS;
    let drained = false;

    while (now() - start < deadlineMs) {
      const allUnsent = store.unsentSessions(10_000);
      const sessions = allUnsent.slice(0, maxSessions);
      const inBatch = new Set(sessions.map((s) => s.id));
      const waiting = new Set(allUnsent.slice(maxSessions).map((s) => s.id));
      const sessionBytes = sessions.reduce((a, s) => a + Buffer.byteLength(JSON.stringify(s)), 0);
      const eventCap = Math.max(0, maxBytes - HEADROOM_BYTES);

      let events = store.nextEvents(maxEvents, Math.max(0, eventCap - sessionBytes));
      // An event whose session row has not been sent yet would be rejected as unknown; wait for the next round.
      const blockedAt = events.findIndex((e) => waiting.has(e.sessionId) && !inBatch.has(e.sessionId));
      if (blockedAt >= 0) events = events.slice(0, blockedAt);

      if (sessions.length === 0 && events.length === 0) { drained = true; break; }

      if (events.length === 1 && byteLength(events[0]) > eventCap) {
        store.quarantineEvents([{ event: events[0], code: "too_large" }]);
        result.quarantined++;
        continue;
      }

      let res;
      try {
        res = await api.ingest({ sessions, events }, { timeoutMs: REQUEST_TIMEOUT_MS });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 401) return block(e);
        if (e.status === 413) {
          if (events.length === 1) {
            store.quarantineEvents([{ event: events[0], code: "too_large" }]);
            result.quarantined++;
            continue;
          }
          if (events.length <= 1 && sessions.length <= 1) return fail();
          maxEvents = Math.max(1, Math.floor(events.length / 2));
          maxBytes = Math.max(HEADROOM_BYTES + 1, Math.floor(maxBytes / 2));
          maxSessions = Math.max(1, Math.floor(sessions.length / 2));
          continue;
        }
        if (e.status >= 500 || e.code === "network" || e.code === "timeout") return fail();
        throw e;
      }

      result.sent += res.inserted;
      result.duplicates += res.duplicates;
      store.markSessionsSent(sessions);
      const outcome = settle(store, sessions, events, res.rejected);
      result.quarantined += outcome;
    }

    store.set("backoffMs", null);
    store.set("backoffUntil", null);

    // Only close the session once everything queued has gone up.
    if (opts.end && drained) {
      try {
        await api.endSession(opts.end.sessionId, opts.end.endedAt, { timeoutMs: REQUEST_TIMEOUT_MS });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 401) return block(e);
        if (e.status === 404) { /* the server never saw this session (not bound/captured): nothing to end */ }
        else if (e.status >= 500 || e.code === "network" || e.code === "timeout") return fail();
        else throw e;
      }
    }

    store.set("lastFlushAt", new Date(now()).toISOString());
    return finish(result.sent + result.duplicates + result.quarantined > 0 ? "done" : "nothing");
  } catch {
    return finish("error");
  } finally {
    if (locked) { try { store.unlock("flush"); } catch { /* lock expires by TTL */ } }
  }
}

const byteLength = (e: IngestEvent) => Buffer.byteLength(JSON.stringify(e));
const evKey = (sessionId: string | null, key: string | null) => `${sessionId}\u0000${key}`;

/** Acks accepted events, quarantines rejected ones, and retires sessions the server refused. Returns the quarantined count. */
function settle(store: Store, sessions: IngestSession[], events: IngestEvent[], rejected: IngestRejection[]): number {
  const rejectedEvents = new Map<string, string>();
  const unknownBinding = new Set<string>();
  for (const r of rejected) {
    if ("key" in r) rejectedEvents.set(evKey(r.sessionId, r.key), r.code);
    else if (r.code === "unknown_binding") unknownBinding.add(r.sessionId);
  }

  const bad: { event: IngestEvent; code: string }[] = [];
  const good: { sessionId: string; key: string }[] = [];
  for (const e of events) {
    const code = rejectedEvents.get(evKey(e.sessionId, e.key));
    if (code) bad.push({ event: e, code });
    else good.push({ sessionId: e.sessionId, key: e.key });
  }
  store.ackEvents(good);
  store.quarantineEvents(bad);

  // A session on a binding the server does not know: stop capturing it and forget the stale binding.
  for (const s of sessions) {
    if (!unknownBinding.has(s.id)) continue;
    for (const c of store.openCursors()) if (c.sessionId === s.id) store.markDone(c.transcriptPath);
    store.cacheBinding(s.repo, s.subpath ?? "", null);
  }
  return bad.length;
}
