import { test, expect } from "bun:test";
import { chunkEvents, searchTerms, type ChunkInput } from "../src/chunker";

const e = (seq: number, kind: ChunkInput["kind"], text: string, toolName: string | null = null, toolInput: unknown = null): ChunkInput =>
  ({ seq, ts: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(), kind, text, toolName, toolInput });

test("tool_result is never indexed", () => {
  const chunks = chunkEvents([e(1, "user", "hi"), e(2, "tool_result", "SECRET-OUTPUT", "Bash")]);
  expect(chunks.some((c) => c.text.includes("SECRET-OUTPUT"))).toBe(false);
  expect(chunks).toHaveLength(1);
});

test("packs small events and keeps seq/ts ranges", () => {
  const chunks = chunkEvents([e(1, "user", "plan the launch"), e(2, "assistant", "sure"), e(3, "tool_call", "", "Bash", { command: "ls" })]);
  expect(chunks).toHaveLength(1);
  const [c] = chunks;
  expect([c.firstSeq, c.lastSeq, c.part]).toEqual([1, 3, 0]);
  expect(c.tsFrom).toBe(e(1, "user", "").ts);
  expect(c.tsTo).toBe(e(3, "user", "").ts);
  expect(c.text.startsWith("User: plan the launch")).toBe(true);
  expect(c.text).toContain("Assistant: sure");
  expect(c.text).toContain('Tool Bash: {"command":"ls"}');
});

test("starts a new chunk when the next event would overflow", () => {
  const chunks = chunkEvents([e(1, "user", "a".repeat(1000)), e(2, "assistant", "b".repeat(1000))]);
  expect(chunks.map((c) => [c.firstSeq, c.lastSeq])).toEqual([[1, 1], [2, 2]]);
});

test("a 200 KB message indexes its first 32k chars in bounded windows", () => {
  const chunks = chunkEvents([e(7, "assistant", "x".repeat(200_000))]);
  expect(chunks.length).toBeGreaterThanOrEqual(20);
  expect(chunks.length).toBeLessThanOrEqual(30);
  for (const c of chunks) {
    expect(c.text.length).toBeLessThanOrEqual(1600);
    expect([c.firstSeq, c.lastSeq]).toEqual([7, 7]);
  }
  expect(new Set(chunks.map((c) => c.part)).size).toBe(chunks.length);
});

test("tool input is truncated", () => {
  const [c] = chunkEvents([e(1, "tool_call", "", "Write", { content: "z".repeat(5000) })]);
  expect(c.text.length).toBeLessThanOrEqual("Tool Write: ".length + 300);
});

test("empty events produce no chunks", () => {
  expect(chunkEvents([e(1, "assistant", "   ")])).toEqual([]);
  expect(chunkEvents([])).toEqual([]);
});

test("identifiers yield extra search terms", () => {
  const terms = searchTerms("edited server/src/auth/cookies.ts and chunkEvents in my-file_name").split(" ");
  expect(terms).toEqual(expect.arrayContaining(["server", "src", "auth", "cookies", "ts", "chunk", "events", "my", "file", "name"]));
  expect(searchTerms("plain words only")).toBe("");
});
