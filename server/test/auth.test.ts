import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { createToken, revokeToken } from "../src/auth";

test("health needs no token", async () => {
  const t = await authedApp();
  try {
    const res = await t.call("GET", "/health", undefined, null);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  } finally { await t.drop(); }
});

test("v1 rejects missing, bad and revoked tokens", async () => {
  const t = await authedApp();
  try {
    expect((await t.call("GET", "/v1/status", undefined, null)).status).toBe(401);
    expect((await t.call("GET", "/v1/status", undefined, "nope")).status).toBe(401);
    const ok = await t.call("GET", "/v1/status");
    expect(ok.status).toBe(200);
    expect((await ok.json()).machine).toBe("test-mac");
    expect(await revokeToken(t.sql, "test-mac")).toBe(true);
    expect((await t.call("GET", "/v1/status")).status).toBe(401);
  } finally { await t.drop(); }
});

test("only the hash is stored", async () => {
  const t = await authedApp();
  try {
    const [{ token_hash }] = await t.sql`select token_hash from machines`;
    expect(token_hash).not.toBe(t.token);
    expect(token_hash.length).toBe(64);
    expect(t.token.startsWith("cbr_")).toBe(true);
  } finally { await t.drop(); }
});

test("duplicate active machine name is rejected", async () => {
  const t = await authedApp();
  try {
    await expect(createToken(t.sql, "test-mac")).rejects.toThrow();
  } finally { await t.drop(); }
});
