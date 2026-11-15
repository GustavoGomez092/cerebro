import { test, expect } from "bun:test";
import { cerebroClient, CerebroError } from "../src/server/cerebro.server";
import { chatProxy, dashboardData, Unauthorized } from "../src/server/data.server";
import { loadWebEnv } from "../src/server/env.server";

const TOKEN = "cbr_SECRET_web_ui_token_value";
const signedIn = async () => ({ user: { id: "u1", email: "owner@home.lab", name: "Owner" } });
const signedOut = async () => null;

/** A fake cerebro-server: records requests, answers JSON (or SSE for chat). */
function fakeServer(answer: (url: string, init: RequestInit) => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return answer(String(url), init); }) as typeof fetch;
  return { calls, cerebro: cerebroClient({ baseUrl: "http://cerebro-server:8790/", token: TOKEN, fetch: fetchFn }) };
}

test("every data function refuses a request without a session and never calls cerebro-server", async () => {
  const s = fakeServer();
  const data = dashboardData({ getSession: signedOut, cerebro: s.cerebro });
  const h = new Headers();
  for (const fn of [() => data.overview(h), () => data.db(h), () => data.clients(h), () => data.search(h, { query: "x" }), () => data.sessionSummaries(h, "s1")]) {
    await expect(fn()).rejects.toBeInstanceOf(Unauthorized);
  }
  expect(s.calls).toHaveLength(0);
});

test("with a session, data functions call the dashboard API with the web-ui token server-side", async () => {
  const s = fakeServer((url) => Response.json({ url }));
  const data = dashboardData({ getSession: signedIn, cerebro: s.cerebro });
  const h = new Headers();
  expect(await data.overview(h)).toEqual({ url: "http://cerebro-server:8790/v1/dashboard/overview" });
  await data.db(h);
  await data.clients(h);
  await data.search(h, { query: "checkout", include: "raw" });
  await data.sessionSummaries(h, "a/b c");
  expect(s.calls.map((c) => c.url)).toEqual([
    "http://cerebro-server:8790/v1/dashboard/overview", "http://cerebro-server:8790/v1/dashboard/db",
    "http://cerebro-server:8790/v1/dashboard/clients", "http://cerebro-server:8790/v1/dashboard/search",
    "http://cerebro-server:8790/v1/dashboard/sessions/a%2Fb%20c/summaries",
  ]);
  for (const c of s.calls) expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(JSON.parse(String(s.calls[3].init.body))).toEqual({ query: "checkout", include: "raw" });
});

test("the token is never part of what a data function returns, even when cerebro-server fails", async () => {
  const s = fakeServer(() => Response.json({ error: "internal", message: "internal error" }, { status: 500 }));
  const data = dashboardData({ getSession: signedIn, cerebro: s.cerebro });
  const err = await data.overview(new Headers()).catch((e) => e);
  expect(err).toBeInstanceOf(CerebroError);
  expect(JSON.stringify(err)).not.toContain(TOKEN);
  expect(String(err.message)).not.toContain(TOKEN);
  const ok = fakeServer(() => Response.json({ health: { ok: true } }));
  const r = await dashboardData({ getSession: signedIn, cerebro: ok.cerebro }).overview(new Headers());
  expect(JSON.stringify(r)).not.toContain(TOKEN);
  expect(JSON.stringify(ok.cerebro)).not.toContain(TOKEN); // the client object serialises without its token
});

test("search only forwards the fields the dashboard search accepts", async () => {
  const s = fakeServer();
  const data = dashboardData({ getSession: signedIn, cerebro: s.cerebro });
  await data.search(new Headers(), { query: "q", limit: 5, repo: "x", scope: "open", token: "y" } as any);
  expect(JSON.parse(String(s.calls[0].init.body))).toEqual({ query: "q", limit: 5 });
});

const chatRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://brain.home.lab/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://brain.home.lab", ...headers }, body: JSON.stringify(body) });

test("the chat proxy needs a session, a same-origin request and a conversation", async () => {
  const s = fakeServer();
  const deps = { getSession: signedOut, cerebro: s.cerebro, origin: "http://brain.home.lab" };
  expect((await chatProxy(chatRequest({ messages: [{ role: "user", content: "hi" }] }), deps)).status).toBe(401);
  const authed = { ...deps, getSession: signedIn };
  expect((await chatProxy(chatRequest({ messages: [{ role: "user", content: "hi" }] }, { Origin: "http://evil.example" }), authed)).status).toBe(403);
  expect((await chatProxy(chatRequest({ nope: 1 }), authed)).status).toBe(400);
  expect(s.calls).toHaveLength(0);
});

test("the chat proxy streams cerebro-server's events through and passes the browser's abort along", async () => {
  let seenSignal: AbortSignal | undefined;
  const s = fakeServer((_, init) => {
    seenSignal = init.signal ?? undefined;
    return new Response("event: start\ndata: {}\n\nevent: text\ndata: {\"text\":\"hi\"}\n\n", { headers: { "Content-Type": "text/event-stream", "X-Internal": "1" } });
  });
  const ctrl = new AbortController();
  const req = new Request(chatRequest({ messages: [{ role: "user", content: "hi" }] }), { signal: ctrl.signal });
  const res = await chatProxy(req, { getSession: signedIn, cerebro: s.cerebro, origin: "http://brain.home.lab" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("x-internal")).toBeNull();
  expect(await res.text()).toContain('"text":"hi"');
  expect(s.calls[0].url).toBe("http://cerebro-server:8790/v1/dashboard/chat");
  expect(new Headers(s.calls[0].init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  ctrl.abort();
  expect(seenSignal?.aborted).toBe(true);
});

test("the chat proxy trims a long conversation to fit cerebro-server's body limit, keeping the newest turns", async () => {
  const s = fakeServer(() => new Response("event: start\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const messages = Array.from({ length: 39 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn-${i} ${"é".repeat(15_000)}` }));
  messages.push({ role: "user", content: "the question" });
  await chatProxy(chatRequest({ messages }), { getSession: signedIn, cerebro: s.cerebro, origin: "http://brain.home.lab" });
  const sent = String(s.calls[0].init.body);
  expect(new TextEncoder().encode(sent).length).toBeLessThan(60_000);
  const m = JSON.parse(sent).messages;
  expect(m.at(-1)).toEqual({ role: "user", content: "the question" });
  expect(m.length).toBeGreaterThan(1);
  expect(m[0].content).not.toContain("turn-0 ");
  for (const x of m) expect(x.content.length).toBeLessThanOrEqual(8000);
});

test("the chat proxy relays a busy or failing server as JSON without the token", async () => {
  const s = fakeServer(() => Response.json({ error: "chat_busy", message: "another chat answer is in progress" }, { status: 429 }));
  const res = await chatProxy(chatRequest({ messages: [{ role: "user", content: "hi" }] }), { getSession: signedIn, cerebro: s.cerebro, origin: "http://brain.home.lab" });
  expect(res.status).toBe(429);
  const body = await res.text();
  expect(body).toContain("chat_busy");
  expect(body).not.toContain(TOKEN);
});

test("web settings: required secrets, the token from a file, and no default secret", async () => {
  const base = { DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: "http://brain.home.lab", CEREBRO_WEB_TOKEN: TOKEN };
  expect(loadWebEnv(base)).toEqual({
    databaseUrl: "postgres://x", authSecret: "s".repeat(32), baseUrl: "http://brain.home.lab", cerebroUrl: "http://cerebro-server:8790", cerebroToken: TOKEN,
  });
  for (const k of ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) expect(() => loadWebEnv({ ...base, [k]: "" })).toThrow(k);
  expect(() => loadWebEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/32/);
  expect(() => loadWebEnv({ ...base, CEREBRO_WEB_TOKEN: "" })).toThrow(/CEREBRO_WEB_TOKEN/);
  const file = `${process.env.TMPDIR ?? "/tmp"}/web-token-${crypto.randomUUID()}`;
  await Bun.write(file, `${TOKEN}\n`);
  expect(loadWebEnv({ ...base, CEREBRO_WEB_TOKEN: "", CEREBRO_WEB_TOKEN_FILE: file }).cerebroToken).toBe(TOKEN);
});
