import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToken, revokeToken } from "../../server/src/auth";
import { ApiClient, ApiError } from "../src/api";
import { loadClientConfig, saveClientConfig } from "../src/config";
import { cerebroHome } from "../src/paths";
import { logError, logInfo } from "../src/log";
import { liveServer, TEST_URL, type LiveServer } from "./harness";

let h: LiveServer;
beforeAll(async () => { h = await liveServer(); });
afterAll(async () => { await h.drop(); });

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "cerebro-home-"));
  const prev = process.env.CEREBRO_HOME;
  process.env.CEREBRO_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.CEREBRO_HOME;
    else process.env.CEREBRO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("health needs no token and returns the instance id", async () => {
  const seen: (string | null)[] = [];
  const spy = (async (i: any, init?: any) => { seen.push(new Headers(init?.headers).get("authorization")); return h.fetch(i, init); }) as typeof fetch;
  const api = new ApiClient({ serverUrl: TEST_URL, token: h.token }, spy);
  expect(await api.health()).toMatchObject({ ok: true, instanceId: h.instanceId });
  expect(seen).toEqual([null]);
});

test("authenticated calls round-trip against the real server", async () => {
  expect((await h.api.status()).machine).toBe("test-mac");
  const c = await h.api.createClient("Acme");
  const p = await h.api.createProject(c.id, "Site");
  expect((await h.api.listClients()).clients.map((x) => x.name)).toContain("Acme");
  expect((await h.api.listProjects(c.id)).projects[0].id).toBe(p.id);
  const b = await h.api.putBinding({ repo: "github.com/a/b", subpath: "", status: "active", clientId: c.id, projectId: p.id });
  expect((await h.api.resolve("github.com/a/b", "")).binding?.id).toBe(b.binding.id);
});

test("server error envelopes become ApiError with status and code", async () => {
  const { token } = await createToken(h.sql, "doomed");
  await revokeToken(h.sql, "doomed");
  const revoked = new ApiClient({ serverUrl: TEST_URL, token }, h.fetch);
  const e1 = await revoked.status().catch((e) => e);
  expect(e1).toBeInstanceOf(ApiError);
  expect(e1).toMatchObject({ status: 401, code: "token_revoked" });
  const e2 = await h.api.search({ query: "x" }).catch((e) => e);
  expect(e2).toBeInstanceOf(ApiError);
  expect(e2).toMatchObject({ status: 400, code: "scope_required" });
});

test("network failures and timeouts are ApiError codes", async () => {
  const cfg = { serverUrl: TEST_URL, token: "t" };
  const e1 = await new ApiClient(cfg, (async () => { throw new TypeError("fetch failed"); }) as any).status().catch((e) => e);
  expect(e1).toBeInstanceOf(ApiError);
  expect(e1.code).toBe("network");
  const hang = ((_: any, init?: any) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason)))) as any;
  const e2 = await new ApiClient(cfg, hang).status({ timeoutMs: 50 }).catch((e) => e);
  expect(e2).toBeInstanceOf(ApiError);
  expect(e2.code).toBe("timeout");
});

test("config prefers plugin options over the config file", () => {
  withHome((home) => {
    expect(cerebroHome()).toBe(home);
    expect(loadClientConfig({})).toBeNull();
    saveClientConfig({ serverUrl: "http://file", token: "f" });
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(loadClientConfig({})).toEqual({ serverUrl: "http://file", token: "f" });
    expect(loadClientConfig({ CLAUDE_PLUGIN_OPTION_SERVER_URL: "http://env", CLAUDE_PLUGIN_OPTION_TOKEN: "e" })).toEqual({ serverUrl: "http://env", token: "e" });
    expect(loadClientConfig({ CEREBRO_SERVER_URL: "http://env2", CEREBRO_TOKEN: "e2" })).toEqual({ serverUrl: "http://env2", token: "e2" });
    writeFileSync(join(home, "config.json"), "{not json");
    expect(loadClientConfig({})).toBeNull();
  });
});

test("logging writes JSON lines and never throws", () => {
  withHome((home) => {
    logInfo("hello", { a: 1 });
    logError("where", new Error("boom"));
    const lines = readFileSync(join(home, "client.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.msg ?? l.where)).toEqual(["hello", "where"]);
    expect(lines[1].error).toContain("boom");
    process.env.CEREBRO_HOME = join(home, "client.log", "nope"); // unwritable: parent is a file
    expect(() => { logError("x", "y"); logInfo("z"); }).not.toThrow();
    process.env.CEREBRO_HOME = home;
    const cyc: any = {};
    cyc.self = cyc;
    expect(() => logInfo("cyc", cyc)).not.toThrow();
  });
});
