import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeSource, normalizeEntries } from "../src/sources/claude-code";
import { readCompleteLines } from "../src/sources/lines";

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const linesOf = (name: string) =>
  readFileSync(fixture(name), "utf8").split("\n").filter((l, i, a) => i < a.length - 1 || l !== "").map((text, lineNo) => ({ lineNo, text }));

test("a partial last line is left for the next read", () => {
  const dir = mkdtempSync(join(tmpdir(), "cerebro-lines-"));
  try {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, "A\nB\nC-partial");
    const first = readCompleteLines(p, 0, 0);
    expect(first.lines).toEqual([{ lineNo: 0, text: "A" }, { lineNo: 1, text: "B" }]);
    expect(first.nextOffset).toBe(4);
    expect(first.nextLine).toBe(2);
    expect(readCompleteLines(p, first.nextOffset, first.nextLine).lines).toEqual([]);
    appendFileSync(p, "-done\n");
    const second = readCompleteLines(p, first.nextOffset, first.nextLine);
    expect(second.lines).toEqual([{ lineNo: 2, text: "C-partial-done" }]);
    expect(second.nextOffset).toBe(Buffer.byteLength("A\nB\nC-partial-done\n"));
    expect(readCompleteLines(join(dir, "missing"), 7, 3)).toEqual({ lines: [], nextOffset: 7, nextLine: 3 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("basic fixture becomes ordered events with stable keys and seqs", () => {
  const names = new Map<string, string>();
  const r = normalizeEntries(linesOf("session-basic.jsonl"), "sess-1", names);
  expect(r.events.length).toBeGreaterThan(15);
  for (const e of r.events) expect(e.key).toMatch(/^[0-9a-f-]{36}:\d+$/);
  for (let i = 1; i < r.events.length; i++) expect(r.events[i]!.seq).toBeGreaterThan(r.events[i - 1]!.seq);
  const kinds = new Set(r.events.map((e) => e.kind));
  for (const k of ["user", "assistant", "tool_call", "tool_result"]) expect(kinds.has(k as never)).toBe(true);
  const calls = new Map(r.events.filter((e) => e.kind === "tool_call").map((e) => [e.meta!.uuid as string, e]));
  expect(calls.size).toBeGreaterThan(0);
  const results = r.events.filter((e) => e.kind === "tool_result");
  expect(results.length).toBeGreaterThan(0);
  expect(results.filter((e) => e.toolName).length).toBeGreaterThanOrEqual(4);
  expect(results.filter((e) => !e.toolName)).toHaveLength(1); // its tool_use was trimmed out of the fixture
  expect(names.size).toBeGreaterThan(0);
  expect(r.entrypoint).toBe("cli");
  expect(r.sessionMeta.version).toBeString();
  expect(r.firstTimestamp).toMatch(/^2026-/);
  expect(r.skipped).toBeGreaterThan(0); // non-conversation line types in the fixture
  // an image inside an array tool_result becomes a placeholder part
  expect(results.some((e) => e.text.includes("[image]"))).toBe(true);
});

test("a tool_result takes the name of the tool_use with its tool_use_id", () => {
  const lines = [
    { uuid: "00000000-0000-4000-a000-000000000001", type: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }] },
    { uuid: "00000000-0000-4000-a000-000000000002", type: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { uuid: "00000000-0000-4000-a000-000000000003", type: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }] },
  ].map((m, lineNo) => ({ lineNo, text: JSON.stringify({ type: m.type, uuid: m.uuid, timestamp: "2026-10-20T05:00:00.000Z", message: { role: m.type, content: m.content } }) }));
  const r = normalizeEntries(lines, "s", new Map());
  expect(r.events.map((e) => e.toolName ?? null)).toEqual(["Grep", "Grep", null]);
  expect(r.events[0]!.toolInput).toEqual({ pattern: "x" });
});

test("thinking goes to meta, images become placeholders, secrets are redacted", () => {
  const entry = (n: number, content: unknown, type = "assistant") => ({
    lineNo: n,
    text: JSON.stringify({ type, uuid: `00000000-0000-4000-a000-00000000000${n}`, timestamp: "2026-10-20T05:00:00.000Z", message: { role: type, content } }),
  });
  const secret = "sk-ant-api03-" + "A".repeat(40);
  const r = normalizeEntries([
    entry(1, [{ type: "thinking", thinking: "pondering", signature: "sig" }]),
    entry(2, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], "user"),
    entry(3, [{ type: "text", text: `key ${secret} here` }]),
    entry(4, [{ type: "tool_use", id: "t", name: "Bash", input: { command: `echo ${secret}`, nested: { a: ["x\u0000y"] } } }]),
  ], "s", new Map());
  expect(r.events[0]).toMatchObject({ kind: "assistant", text: "", meta: { thinking: "pondering" } });
  expect(r.events[1]).toMatchObject({ kind: "user", text: "[image]" });
  expect(r.events[2]!.text).toContain("[REDACTED:anthropic-key]");
  expect(r.events[2]!.text).not.toContain(secret);
  expect(JSON.stringify(r.events[3]!.toolInput)).not.toContain(secret);
  expect(JSON.stringify(r.events[3]!.toolInput)).not.toContain("\\u0000");
});

test("oversized text is truncated with the marker", () => {
  const big = "a".repeat(9 * 1024 * 1024);
  const r = normalizeEntries([{ lineNo: 0, text: JSON.stringify({ type: "user", uuid: "00000000-0000-4000-a000-000000000001", timestamp: "2026-10-20T05:00:00.000Z", message: { role: "user", content: big } }) }], "s", new Map());
  const t = r.events[0]!.text;
  expect(t.endsWith(`\n[truncated by cerebro: ${big.length} bytes total]`)).toBe(true);
  expect(t.length).toBeLessThan(8 * 1024 * 1024 + 100);
});

test("a PEM key straddling the truncation cut is redacted, not cut", () => {
  const limit = 8 * 1024 * 1024;
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(40);
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  // key starts 100 bytes before the limit, so the cut would land inside it and drop the END line
  const text = "a".repeat(limit - 100) + pem + "b".repeat(1000);
  const r = normalizeEntries([{ lineNo: 0, text: JSON.stringify({ type: "user", uuid: "00000000-0000-4000-a000-000000000001", timestamp: "2026-10-20T05:00:00.000Z", message: { role: "user", content: text } }) }], "s", new Map());
  const t = r.events[0]!.text;
  expect(t).toContain("[REDACTED:private-key]");
  expect(t).not.toContain("MIIEvQIBADANBg");
  expect(t).not.toContain("BEGIN PRIVATE KEY");
  expect(t).toContain("[truncated by cerebro:");
});

test("a secret in gitBranch is redacted in meta and sessionMeta", () => {
  const secret = "sk-ant-api03-" + "B".repeat(40);
  const line = JSON.stringify({ type: "user", uuid: "00000000-0000-4000-a000-000000000001", timestamp: "2026-10-20T05:00:00.000Z", gitBranch: `fix/${secret}`, message: { role: "user", content: "hi" } });
  const r = normalizeEntries([{ lineNo: 0, text: line }], "s", new Map());
  expect(r.events[0]!.meta!.gitBranch).toBe("fix/[REDACTED:anthropic-key]");
  expect(r.sessionMeta.gitBranch).toBe("fix/[REDACTED:anthropic-key]");
});

test("format drift is skipped and counted, never fatal", () => {
  const lines = linesOf("session-drift.jsonl");
  const expected = Number(/expected skipped: (\d+)/.exec(lines[0]!.text)![1]);
  const r = normalizeEntries(lines, "s", new Map());
  expect(r.skipped).toBe(expected);
  const uuids = r.events.map((e) => (e.meta!.uuid as string).slice(-3));
  expect(uuids.filter((u) => u === "001")).toHaveLength(1);
  expect(uuids.filter((u) => u === "003")).toHaveLength(1); // text block kept next to the unknown one
  expect(uuids.filter((u) => u === "007")).toHaveLength(16); // blocks 16..19 dropped
  expect(uuids.filter((u) => u === "008")).toHaveLength(1);
  expect(r.events.at(-1)!.text).toBe("Placeholder final reply.");
});

test("garbage never throws", () => {
  const texts = ["null", "42", "[]", '"x"', "{", '{"type":"user"}', '{"type":"user","uuid":"u","timestamp":"2026-10-20T05:00:00Z","message":null}',
    '{"type":"user","uuid":"u","timestamp":"2026-10-20T05:00:00Z","message":{"content":[null,1,{"type":"tool_use"},{"type":"tool_result","content":{"a":1}}]}}'];
  const r = normalizeEntries(texts.map((text, lineNo) => ({ lineNo, text })), "s", new Map());
  expect(r.skipped).toBeGreaterThanOrEqual(texts.length - 1);
});

test("normalising the same lines twice gives identical keys (idempotent upload)", () => {
  const a = normalizeEntries(linesOf("session-basic.jsonl"), "s", new Map());
  const b = normalizeEntries(linesOf("session-basic.jsonl"), "s", new Map());
  expect(a.events.map((e) => e.key)).toEqual(b.events.map((e) => e.key));
  expect(new Set(a.events.map((e) => e.key)).size).toBe(a.events.length);
});

test("claudeCodeSource discovers and reads incrementally, carrying tool names in state", async () => {
  const home = mkdtempSync(join(tmpdir(), "cerebro-cc-"));
  try {
    const dir = join(home, ".claude", "projects", "-work-project");
    mkdirSync(dir, { recursive: true });
    const text = readFileSync(fixture("session-basic.jsonl"), "utf8");
    const path = join(dir, "abc.jsonl");
    const cut = text.indexOf("\n", text.length >> 1) + 1;
    writeFileSync(path, text.slice(0, cut));
    const files = await claudeCodeSource.discover({ home });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ source: "claude-code", sessionId: "abc", path });
    expect(await claudeCodeSource.discover({ home: join(home, "nope") })).toEqual([]);

    const one = claudeCodeSource.read(files[0]!, { offset: 0, line: 0 });
    expect(one.cwd).toBe("/work/project");
    expect(one.headless).toBe(false);
    appendFileSync(path, text.slice(cut));
    const two = claudeCodeSource.read(files[0]!, { offset: one.nextOffset, line: one.nextLine, state: one.state });
    const whole = normalizeEntries(linesOf("session-basic.jsonl"), "abc", new Map());
    expect([...one.events, ...two.events].map((e) => e.key)).toEqual(whole.events.map((e) => e.key));
    expect([...one.events, ...two.events].map((e) => e.toolName)).toEqual(whole.events.map((e) => e.toolName));
    expect(one.skipped + two.skipped).toBe(whole.skipped);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
