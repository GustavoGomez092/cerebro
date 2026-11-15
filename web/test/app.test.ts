// The built app end to end: vite build, then requests through web/server.ts's handler against a real cerebro-server
// app (fresh database, a web-ui token) and Better Auth on the same database.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { freshDb } from "../../server/test/helpers";
import { webDbUrl } from "./web-db";
import { createApp } from "../../server/src/http/app";
import { createToken } from "../../server/src/auth";
import { fakeEmbedder } from "../../server/src/embed/fake";
import { webFetch } from "../server";

const WEB = join(import.meta.dir, "..");
const BASE = "http://brain.home.lab";
let db: Awaited<ReturnType<typeof freshDb>>;
let cerebro: ReturnType<typeof Bun.serve>;
let fetchApp: (req: Request) => Promise<Response>;
let token: string;

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", "--bun", "x", "vite", "build"], { cwd: WEB, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`vite build failed: ${build.stderr.toString().slice(-2000)}`);
  db = await freshDb();
  token = (await createToken(db.sql, "web-ui")).token;
  const api = createApp({ sql: db.sql, embedder: fakeEmbedder(), log: () => {} });
  cerebro = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: api.fetch });
  Object.assign(process.env, {
    DATABASE_URL: await webDbUrl(db), BETTER_AUTH_SECRET: "app-test-secret-".padEnd(48, "z"), BETTER_AUTH_URL: BASE,
    CEREBRO_URL: `http://127.0.0.1:${cerebro.port}`, CEREBRO_WEB_TOKEN: token,
  });
  const handler = (await import(join(WEB, "dist", "server", "server.js"))).default;
  fetchApp = webFetch(handler, join(WEB, "dist", "client"));
}, 120_000);

afterAll(async () => {
  cerebro?.stop(true);
  await db?.drop();
});

const get = (path: string, cookie?: string) => fetchApp(new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" }));

test("an unauthenticated request for any page redirects to the login page", async () => {
  for (const path of ["/", "/clients", "/chat"]) {
    const res = await get(path);
    expect([302, 307]).toContain(res.status);
    expect(new URL(res.headers.get("location")!, BASE).pathname).toBe("/login");
  }
  const login = await get("/login");
  expect(login.status).toBe(200);
  expect(await login.text()).toContain("Sign in");
  expect(login.headers.get("x-frame-options")).toBe("DENY");
});

test("unauthenticated API calls are refused and sign-up is closed", async () => {
  const chat = await fetchApp(new Request(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  }));
  expect(chat.status).toBe(401);
  const signUp = await fetchApp(new Request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "X-Forwarded-For": "10.1.1.1" },
    body: JSON.stringify({ email: "x@y.z", password: "a long enough password", name: "x" }),
  }));
  expect(signUp.status).toBeGreaterThanOrEqual(400);
});

test("signed in, the pages render cerebro-server's data and never carry the web-ui token", async () => {
  const proc = Bun.spawn(["bun", join(WEB, "scripts", "create-owner.ts"), "--email", "owner@home.lab"], {
    stdin: new Blob(["app-test-password-1234\n"]), stdout: "pipe", stderr: "pipe", env: process.env,
  });
  expect(await proc.exited).toBe(0);
  const signIn = await fetchApp(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "X-Forwarded-For": "10.1.1.2" },
    body: JSON.stringify({ email: "owner@home.lab", password: "app-test-password-1234" }),
  }));
  expect(signIn.status).toBe(200);
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  for (const [path, marker] of [["/", "Dashboard"], ["/clients", "Personal"], ["/chat", "Ask Claude"]]) {
    const res = await get(path, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(marker);
    expect(html).not.toContain(token);
  }
});

test("the browser bundle holds no server module, secret name or token", () => {
  const dir = join(WEB, "dist", "client", "assets");
  const all = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  for (const s of ["CEREBRO_WEB_TOKEN", "BETTER_AUTH_SECRET", "cerebroToken", "internalAdapter", "search_path", "Authorization: `Bearer", token]) {
    expect(all).not.toContain(s);
  }
});

test("client-side navigation works over plain http: same-origin pages send a Referer the CSRF check accepts", async () => {
  // Chrome sends no Sec-Fetch-Site to an http (not secure) origin and no Origin on a same-origin GET, so TanStack
  // Start's CSRF check on server functions has only the Referer to go on; "no-referrer" made every one a 403.
  const login = await get("/login");
  expect(login.headers.get("referrer-policy")).toBe("same-origin");
  expect(await login.text()).not.toContain(`content="no-referrer"`);

  const signIn = await fetchApp(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "X-Forwarded-For": "10.1.1.3" },
    body: JSON.stringify({ email: "owner@home.lab", password: "app-test-password-1234" }),
  }));
  expect(signIn.status).toBe(200);
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  const dir = join(WEB, "dist", "client", "assets");
  const ids = readdirSync(dir).filter((f) => f.endsWith(".js"))
    .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/\(`([0-9a-f]{64})`\)/g)].map((m) => m[1]));
  expect(ids.length).toBeGreaterThan(0);
  // What the browser sends for a GET server function under "same-origin": the cookie and the page as Referer.
  const statuses = await Promise.all(ids.map(async (id) =>
    (await fetchApp(new Request(`${BASE}/_serverFn/${id}`, { headers: { cookie, Referer: `${BASE}/clients` } }))).status));
  expect(statuses).not.toContain(403);
  // A cross-site Referer is still refused.
  const cross = await fetchApp(new Request(`${BASE}/_serverFn/${ids[0]}`, { headers: { cookie, Referer: "http://evil.example/" } }));
  expect(cross.status).toBe(403);
});
