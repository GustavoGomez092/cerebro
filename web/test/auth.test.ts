import { test, expect } from "bun:test";
import { getMigrations } from "better-auth/db/migration";
import { freshDb } from "../../server/test/helpers";
import { webDbUrl } from "./web-db";
import { authOptions, authPool, createAuth } from "../src/server/auth.server";
import { createOrResetOwner } from "../src/server/owner.server";

const BASE = "http://brain.home.lab";
const SECRET = "test-secret-".padEnd(48, "x");

async function setup() {
  const db = await freshDb(); // server migrations, 008 and 009 included
  // Better Auth runs as cerebro_web (migration 009), as on the Zima: never the superuser.
  const pool = authPool(await webDbUrl(db));
  const auth = createAuth({ pool, secret: SECRET, baseURL: BASE });
  const post = (path: string, body: unknown, ip = "192.168.4.10") =>
    auth.handler(new Request(`${BASE}/api/auth${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "X-Forwarded-For": ip }, body: JSON.stringify(body),
    }));
  return {
    db, auth, pool, post,
    async close() { await pool.end(); await db.drop(); },
  };
}

test("migration 008 creates exactly the tables Better Auth expects (its own migrate has nothing to do)", async () => {
  const s = await setup();
  try {
    const m = await getMigrations(authOptions({ pool: s.pool, secret: SECRET, baseURL: BASE }) as any);
    expect(m.toBeCreated.map((t: any) => t.table)).toEqual([]);
    expect(m.toBeAdded.map((t: any) => t.table)).toEqual([]);
  } finally { await s.close(); }
});

test("the owner signs in with the seeded password; the cookie is httpOnly and SameSite=Lax, not Secure (LAN http)", async () => {
  const s = await setup();
  try {
    await createOrResetOwner(s.auth, { email: "Owner@Home.lab", name: "Owner", password: "correct horse battery" });
    const bad = await s.post("/sign-in/email", { email: "owner@home.lab", password: "wrong password!!" });
    expect(bad.status).toBe(401);
    const ok = await s.post("/sign-in/email", { email: "owner@home.lab", password: "correct horse battery" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("better-auth.session_token=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
    const session = await s.auth.api.getSession({ headers: new Headers({ cookie: cookie.split(";")[0] }) });
    expect(session?.user.email).toBe("owner@home.lab");
  } finally { await s.close(); }
});

test("public sign-up is disabled", async () => {
  const s = await setup();
  try {
    const res = await s.post("/sign-up/email", { email: "intruder@lan", password: "a long enough password", name: "x" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [{ n }] = await s.db.sql`select count(*)::int as n from auth."user"`;
    expect(n).toBe(0);
  } finally { await s.close(); }
});

test("sign-in is rate limited per client address", async () => {
  const s = await setup();
  try {
    await createOrResetOwner(s.auth, { email: "owner@home.lab", name: "Owner", password: "correct horse battery" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await s.post("/sign-in/email", { email: "owner@home.lab", password: `guess-number-${i}` }, "192.168.4.99")).status);
    expect(statuses.slice(0, 5).every((x) => x === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another address is not held back.
    expect((await s.post("/sign-in/email", { email: "owner@home.lab", password: "correct horse battery" }, "192.168.4.11")).status).toBe(200);
  } finally { await s.close(); }
});

test("re-running the owner seed resets the password; short passwords are refused", async () => {
  const s = await setup();
  try {
    await createOrResetOwner(s.auth, { email: "owner@home.lab", name: "Owner", password: "first password here" });
    const r = await createOrResetOwner(s.auth, { email: "owner@home.lab", name: "Owner", password: "second password here" });
    expect(r).toBe("reset");
    expect((await s.post("/sign-in/email", { email: "owner@home.lab", password: "first password here" })).status).toBe(401);
    expect((await s.post("/sign-in/email", { email: "owner@home.lab", password: "second password here" })).status).toBe(200);
    await expect(createOrResetOwner(s.auth, { email: "owner@home.lab", name: "Owner", password: "short" })).rejects.toThrow(/12/);
    const [{ n }] = await s.db.sql`select count(*)::int as n from auth."user"`;
    expect(n).toBe(1);
  } finally { await s.close(); }
});
