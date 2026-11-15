import { test, expect } from "bun:test";
import { ChatUsage, Metrics, RateCounter } from "../src/metrics";

const clock = (start = 1_000_000) => {
  const c = { t: start, now: () => c.t };
  return c;
};

test("a rate counter sums what was added inside the window only", () => {
  const c = clock();
  const r = new RateCounter(1000, 900, c.now);
  r.add();
  c.t += 30_000;
  r.add(2);
  c.t += 50_000; // first add is 80 s old, second 50 s old
  expect(r.sum(60_000)).toBe(2);
  expect(r.sum(5 * 60_000)).toBe(3);
});

test("a rate counter forgets buckets older than its span, even after a long gap", () => {
  const c = clock();
  const r = new RateCounter(1000, 900, c.now);
  r.add(5);
  c.t += 16 * 60_000;
  expect(r.sum(15 * 60_000)).toBe(0);
  r.add(1);
  expect(r.sum(15 * 60_000)).toBe(1);
});

test("a rate counter caps the asked window at its span", () => {
  const c = clock();
  const r = new RateCounter(1000, 60, c.now);
  r.add(3);
  c.t += 30_000;
  expect(r.sum(3600_000)).toBe(3);
});

test("searches per 1, 5 and 15 minutes", () => {
  const c = clock();
  const m = new Metrics(c.now);
  m.trackSearch("a", "mac")();
  c.t += 4 * 60_000;
  m.trackSearch("b", "mac")();
  c.t += 2 * 60_000;
  m.trackSearch("c", "mac")();
  expect(m.searchRates()).toEqual({ m1: 1, m5: 2, m15: 3 });
});

test("in-flight searches are listed with truncated text and elapsed time until they finish", () => {
  const c = clock();
  const m = new Metrics(c.now);
  const done = m.trackSearch("x".repeat(500), "mac-mini");
  c.t += 1500;
  const [a] = m.activeSearches();
  expect(a.machine).toBe("mac-mini");
  expect(a.query.length).toBeLessThanOrEqual(121);
  expect(a.query.endsWith("…")).toBe(true);
  expect(a.elapsedMs).toBe(1500);
  expect(a.startedAt).toBe(new Date(1_000_000).toISOString());
  done();
  done(); // idempotent
  expect(m.activeSearches()).toEqual([]);
});

test("uptime counts from construction", () => {
  const c = clock();
  const m = new Metrics(c.now);
  c.t += 90_500;
  expect(m.uptimeSeconds()).toBe(90);
  expect(m.startedAt).toBe(new Date(1_000_000).toISOString());
});

test("events and embedded chunks per minute", () => {
  const c = clock();
  const m = new Metrics(c.now);
  m.events.add(120);
  m.chunks.add(3);
  c.t += 61_000;
  m.events.add(10);
  expect(m.events.sum(60_000)).toBe(10);
  expect(m.chunks.sum(60_000)).toBe(0);
  expect(m.chunks.sum(5 * 60_000)).toBe(3);
});

test("chat usage: tokens in the 5-hour window, totals, last run and the last usage limit", () => {
  const c = clock();
  const u = new ChatUsage(c.now);
  u.recordRun({ tokens: 1000, model: "sonnet", outcome: "ok" });
  c.t += 4 * 3600_000;
  u.recordRun({ tokens: 500, model: "sonnet", outcome: "ok" });
  c.t += 2 * 3600_000; // the first run left the window
  u.recordRun({ tokens: 0, model: null, outcome: "usage_limit", message: "limit reached", resetAt: "2030-01-01T00:00:00.000Z" });
  const s = u.snapshot();
  expect(s.window).toEqual({ hours: 5, tokens: 500, runs: 2 });
  expect(s.sinceStart).toEqual({ tokens: 1500, runs: 3 });
  expect(s.lastRun?.outcome).toBe("usage_limit");
  expect(s.lastLimit).toEqual({ at: new Date(c.t).toISOString(), message: "limit reached", resetAt: "2030-01-01T00:00:00.000Z" });
});
