import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError, verificationRecord, VERIFIED_KEY } from "../src/api";
import { checkInstance } from "../src/instance";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer, trustedState } from "./harness";

let h: LiveServer;
const dirs: string[] = [];
beforeAll(async () => { h = await liveServer(); });
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.drop();
});

function store(): Store {
  const d = mkdtempSync(join(tmpdir(), "cerebro-instance-"));
  dirs.push(d);
  return new Store(join(d, "cerebro.db"));
}

/** Records whether any request carried the token. */
function spyApi(fetchFn: typeof fetch = h.fetch) {
  const seen = { authed: 0, requests: 0 };
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, trustedState(), (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.requests++;
    if (req.headers.get("authorization")) seen.authed++;
    return fetchFn(req);
  }) as typeof fetch);
  return { api, seen };
}

test("first contact pins the instance; the same instance is ok; no token is sent", async () => {
  const s = store();
  const { api, seen } = spyApi();
  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("ok");
  expect(s.get("instanceId")).toBe(h.instanceId);
  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("ok");
  expect(seen).toEqual({ authed: 0, requests: 2 });
  expect(s.get("blocked")).toBeUndefined();
  s.close();
});

test("a different instance is a mismatch and blocks uploads", async () => {
  const s = store();
  s.set("instanceId", crypto.randomUUID());
  const { api, seen } = spyApi();
  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("mismatch");
  expect(s.get("blocked")).toBe("instance_mismatch");
  expect(seen.authed).toBe(0);
  s.close();
});

test("down, unhealthy or instance-less servers are unreachable and pin nothing", async () => {
  const cases: (typeof fetch)[] = [
    (() => { throw new TypeError("connection refused"); }) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ ok: false, db: false, apiVersion: 1, instanceId: null }), { status: 503 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ ok: true, apiVersion: 1, instanceId: null }))) as unknown as typeof fetch,
    (async () => new Response("<html>captive portal</html>", { status: 200 })) as unknown as typeof fetch,
  ];
  for (const f of cases) {
    const s = store();
    const { api } = spyApi(f);
    expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("unreachable");
    expect(s.get("instanceId")).toBeUndefined();
    expect(s.get("blocked")).toBeUndefined();
    s.close();
  }
});

/** An ApiClient gated by `s`, counting requests and those that carried the token. */
function gatedSpy(s: Store, fetchFn: typeof fetch = h.fetch) {
  const seen = { authed: 0, requests: 0 };
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, s, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.requests++;
    if (req.headers.get("authorization")) seen.authed++;
    return fetchFn(req);
  }) as typeof fetch);
  const refused = async () => {
    const e = await api.status().catch((x) => x);
    return e instanceof ApiError && e.code === "instance_unverified";
  };
  return { api, seen, refused };
}

test("the token goes out only after a fresh check of the pinned instance at this URL, and never while blocked", async () => {
  const s = store();
  const { api, seen, refused } = gatedSpy(s);
  expect(await refused()).toBe(true); // never checked
  expect(seen.requests).toBe(0);

  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("ok");
  expect((await api.status()).machine).toBe("test-mac");
  expect(seen.authed).toBe(1);

  s.set(VERIFIED_KEY, verificationRecord(TEST_URL, h.instanceId, Date.now() - 61_000));
  expect(await refused()).toBe(true); // stale
  s.set(VERIFIED_KEY, verificationRecord("http://elsewhere.test", h.instanceId));
  expect(await refused()).toBe(true); // checked another server
  s.set(VERIFIED_KEY, verificationRecord(TEST_URL, "not-the-pinned-one"));
  expect(await refused()).toBe(true); // not the pinned instance
  for (const reason of ["instance_mismatch", "token_revoked", "unauthorized"]) {
    s.set(VERIFIED_KEY, verificationRecord(TEST_URL, h.instanceId));
    s.set("blocked", reason);
    expect(await refused()).toBe(true);
  }
  expect(seen.authed).toBe(1);
  expect((await api.health()).instanceId).toBe(h.instanceId); // health needs no token and stays open
  s.close();
});

test("a mismatch or an unreachable server withdraws an earlier verification", async () => {
  const s = store();
  const { api, refused } = gatedSpy(s);
  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("ok");
  expect(await refused()).toBe(false);

  const down = gatedSpy(s, (() => { throw new TypeError("connection refused"); }) as unknown as typeof fetch);
  expect(await checkInstance(s, down.api, { timeoutMs: 1000 })).toBe("unreachable");
  expect(await refused()).toBe(true);

  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("ok");
  s.set("instanceId", crypto.randomUUID());
  expect(await checkInstance(s, api, { timeoutMs: 1000 })).toBe("mismatch");
  s.set("blocked", null);
  expect(await refused()).toBe(true);
  s.close();
});
