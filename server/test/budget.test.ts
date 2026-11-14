import { test, expect } from "bun:test";
import { freshDb } from "./helpers";
import { record, budgetState, canSpend } from "../src/summarise/budget";
import { loadConfig } from "../src/config";

const cfg = { share: 0.2, windowTokens: 1000 };
const NOW = new Date("2026-11-13T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);

async function insertAt(sql: any, at: Date, tokens: number) {
  await sql`insert into usage_ledger (at, tokens, kind) values (${at.toISOString()}, ${tokens}, 'summary')`;
}

test("budget is share x window, used counts the last 5 hours only", async () => {
  const { sql, drop } = await freshDb();
  try {
    await insertAt(sql, ago(6), 500); // outside window
    await insertAt(sql, ago(4), 70);
    await insertAt(sql, ago(1), 30);
    const s = await budgetState(sql, cfg, NOW);
    expect(s).toEqual({ used: 100, limit: 200, remaining: 100, resumesAt: null });
    expect(canSpend(s, 100)).toBe(true);
    expect(canSpend(s, 101)).toBe(false);
    await record(sql, 25, "state");
    const s2 = await budgetState(sql, cfg, new Date());
    expect(s2.used).toBe(25);
  } finally { await drop(); }
});

test("resumesAt is when the oldest spending leaves the window", async () => {
  const { sql, drop } = await freshDb();
  try {
    await insertAt(sql, ago(4), 150);
    await insertAt(sql, ago(2), 100);
    await insertAt(sql, ago(1), 10);
    const s = await budgetState(sql, cfg, NOW);
    expect(s.used).toBe(260);
    expect(s.remaining).toBe(0);
    // dropping the 150 entry (at ago(4)) brings used to 110 < 200
    expect(s.resumesAt).toEqual(new Date(ago(4).getTime() + 5 * 3600_000));
    expect(canSpend(s, 1)).toBe(false);
  } finally { await drop(); }
});

test("budgetState deletes ledger rows older than 7 days", async () => {
  const { sql, drop } = await freshDb();
  try {
    await insertAt(sql, new Date(NOW.getTime() - 8 * 24 * 3600_000), 5);
    await insertAt(sql, ago(6), 5);
    await budgetState(sql, cfg, NOW);
    const [{ n }] = await sql`select count(*)::int as n from usage_ledger`;
    expect(n).toBe(1);
  } finally { await drop(); }
});

test("config validates share in (0, 1]", () => {
  const base = { DATABASE_URL: "x" };
  expect(loadConfig(base).summariser).toEqual({ enabled: true, share: 0.2, windowTokens: 2000000, cmd: "claude" });
  expect(loadConfig({ ...base, SUMMARY_SHARE: "1" }).summariser.share).toBe(1);
  expect(loadConfig({ ...base, SUMMARISER_ENABLED: "false" }).summariser.enabled).toBe(false);
  for (const bad of ["0", "-0.1", "1.5", "abc"]) {
    expect(() => loadConfig({ ...base, SUMMARY_SHARE: bad })).toThrow(/SUMMARY_SHARE/);
  }
  expect(() => loadConfig({ ...base, SUBSCRIPTION_TOKENS_PER_5H: "0" })).toThrow(/SUBSCRIPTION_TOKENS_PER_5H/);
});
