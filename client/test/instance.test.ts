import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../src/api";
import { checkInstance } from "../src/instance";
import { Store } from "../src/store";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

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
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, (async (input: RequestInfo | URL, init?: RequestInit) => {
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
