import { test, expect } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { freshDb } from "./helpers";
import { scramVerifier, setWebDbRole, WEB_DB_ROLE } from "../src/web-db-role";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

test("migration 009 creates cerebro_web without login, with rights on the auth schema only", async () => {
  const db = await freshDb();
  try {
    const [r] = await db.sql`select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = ${WEB_DB_ROLE}`;
    expect(r).toMatchObject({ rolsuper: false, rolcreaterole: false, rolcreatedb: false });
    const [p] = await db.sql`
      select has_schema_privilege(${WEB_DB_ROLE}, 'auth', 'USAGE') as auth_usage,
             has_schema_privilege(${WEB_DB_ROLE}, 'auth', 'CREATE') as auth_create,
             has_table_privilege(${WEB_DB_ROLE}, 'auth."user"', 'SELECT,INSERT,UPDATE,DELETE') as auth_rw,
             has_table_privilege(${WEB_DB_ROLE}, 'auth."session"', 'SELECT,INSERT,UPDATE,DELETE') as session_rw,
             has_schema_privilege(${WEB_DB_ROLE}, 'public', 'USAGE') as public_usage,
             has_schema_privilege(${WEB_DB_ROLE}, 'public', 'CREATE') as public_create,
             has_table_privilege(${WEB_DB_ROLE}, 'public.events', 'SELECT') as events_select,
             has_table_privilege(${WEB_DB_ROLE}, 'public.machines', 'SELECT') as machines_select`;
    expect(p).toEqual({
      auth_usage: true, auth_create: true, auth_rw: true, session_rw: true,
      public_usage: false, public_create: false, events_select: false, machines_select: false,
    });
  } finally { await db.drop(); }
});

test("a SCRAM verifier has Postgres's format and never contains the password", () => {
  const v = scramVerifier("Abc123password");
  expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  expect(v).not.toContain("Abc123password");
  expect(scramVerifier("Abc123password")).not.toBe(v); // a fresh salt each time
});

test("setWebDbRole gives cerebro_web a login: it reaches the auth tables and nothing in public", async () => {
  const db = await freshDb();
  try {
    const line = await setWebDbRole(db.sql, db.url);
    expect(line).toMatch(/^DATABASE_URL=postgres:\/\/cerebro_web:[A-Za-z0-9]{40}@/);
    const url = line.slice("DATABASE_URL=".length);
    expect(new URL(url).pathname).toBe(new URL(db.url).pathname);
    // Stored as a SCRAM verifier, never as the plain password.
    const [{ rolpassword, rolcanlogin }] = await db.sql`select rolpassword, rolcanlogin from pg_authid where rolname = ${WEB_DB_ROLE}`;
    expect(rolcanlogin).toBe(true);
    expect(rolpassword).toStartWith("SCRAM-SHA-256$");
    expect(rolpassword).not.toContain(decodeURIComponent(new URL(url).password));
    const web = new SQL(url, { max: 1 } as any);
    try {
      const [{ n }] = await web`select count(*)::int as n from auth."user"`;
      expect(n).toBe(0);
      await expect(web`select count(*) from public.events`).rejects.toThrow(/permission denied/);
      await expect(web`create table public.x (a int)`).rejects.toThrow(/permission denied/);
      await expect(web.unsafe(`alter role cerebro_web superuser`)).rejects.toThrow();
    } finally { await web.close(); }
  } finally { await db.drop(); }
});

test("the web-db-role command prints the URL line only into a pipe, never to a terminal", async () => {
  const db = await freshDb();
  try {
    const p = Bun.spawnSync(["bun", CLI, "web-db-role"], { env: { ...process.env, DATABASE_URL: db.url }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toMatch(/^DATABASE_URL=postgres:\/\/cerebro_web:/);
    expect(p.stderr.toString()).not.toContain(new URL(out.trim().slice(13)).password);
    // On a terminal it refuses, before changing anything.
    const { runWebDbRole } = await import("../src/web-db-role");
    const writes: string[] = [];
    await expect(runWebDbRole(db.sql, db.url, { isTTY: true, write: (s) => writes.push(s) })).rejects.toThrow(/pipe/);
    expect(writes).toEqual([]);
  } finally { await db.drop(); }
});
