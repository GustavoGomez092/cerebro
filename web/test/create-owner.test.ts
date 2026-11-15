import { test, expect } from "bun:test";
import { join } from "node:path";
import { freshDb } from "../../server/test/helpers";
import { webDbUrl } from "./web-db";
import { parseOwnerArgs, passwordFromPipe } from "../scripts/create-owner";
import { authPool, createAuth } from "../src/server/auth.server";

const SCRIPT = join(import.meta.dir, "..", "scripts", "create-owner.ts");

test("the password is never an argument", () => {
  for (const argv of [["--email", "a@b.c", "--password", "x"], ["--email", "a@b.c", "--password=x"], ["--email", "a@b.c", "-p", "x"], ["--email", "a@b.c", "hunter2"]]) {
    expect(() => parseOwnerArgs(argv)).toThrow();
  }
  expect(() => parseOwnerArgs([])).toThrow(/--email/);
  expect(parseOwnerArgs(["--email", "owner@home.lab"])).toEqual({ email: "owner@home.lab", name: "Owner" });
  expect(parseOwnerArgs(["--email", "owner@home.lab", "--name", "Gus"])).toEqual({ email: "owner@home.lab", name: "Gus" });
});

test("a piped password is the first line, without its line ending", () => {
  expect(passwordFromPipe("correct horse battery\n")).toBe("correct horse battery");
  expect(passwordFromPipe("with spaces kept  \r\nsecond line")).toBe("with spaces kept  ");
  expect(() => passwordFromPipe("")).toThrow();
});

test("the script creates the owner from a piped password and never prints it", async () => {
  const db = await freshDb();
  const webUrl = await webDbUrl(db);
  const pool = authPool(webUrl);
  try {
    const password = "piped-password-0123456789";
    const proc = Bun.spawn(["bun", SCRIPT, "--email", "owner@home.lab"], {
      stdin: new Blob([`${password}\n`]), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, DATABASE_URL: webUrl, BETTER_AUTH_SECRET: "s".repeat(40), BETTER_AUTH_URL: "http://brain.home.lab", CEREBRO_WEB_TOKEN: "unused" },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("owner@home.lab");
    expect(out + err).not.toContain(password);
    const auth = createAuth({ pool, secret: "s".repeat(40), baseURL: "http://brain.home.lab" });
    const res = await auth.handler(new Request("http://brain.home.lab/api/auth/sign-in/email", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://brain.home.lab", "X-Forwarded-For": "10.0.0.1" },
      body: JSON.stringify({ email: "owner@home.lab", password }),
    }));
    expect(res.status).toBe(200);
  } finally { await pool.end(); await db.drop(); }
});
