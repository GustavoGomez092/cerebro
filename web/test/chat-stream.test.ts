// The chat page's stream handling as pure functions: SSE framing, the per-turn reducer, end-of-stream and history.
import { test, expect } from "bun:test";
import { applyEvent, endTurn, historyFor, newAssistantTurn, sseFrames, type Turn } from "../src/lib/chat-stream";

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("sseFrames yields whole frames and keeps a partial one for the next chunk", () => {
  const a = sseFrames(frame("start", { runId: "r1", model: "m" }) + 'event: tool\ndata: {"label":"sear');
  expect(a.frames).toEqual([{ event: "start", data: { runId: "r1", model: "m" } }]);
  const b = sseFrames(a.rest + 'ching \\"JS lab\\""}\n\n');
  expect(b.frames).toEqual([{ event: "tool", data: { label: 'searching "JS lab"' } }]);
  expect(b.rest).toBe("");
});

test("sseFrames copes with CRLF line ends, multi-line data, a default event name and junk", () => {
  const { frames } = sseFrames('event: text\r\ndata: {"text":\r\ndata: "hi"}\r\n\r\ndata: {"x":1}\n\nevent: text\ndata: not json\n\n');
  expect(frames).toEqual([{ event: "text", data: { text: "hi" } }, { event: "message", data: { x: 1 } }]);
});

test("the reducer builds a turn from start, tool, text, ping and done", () => {
  let t = newAssistantTurn();
  expect(t.status).toBe("waiting");
  t = applyEvent(t, { event: "start", data: { type: "start", runId: "r1", model: "claude-x" } });
  t = applyEvent(t, { event: "tool", data: { type: "tool", name: "search", label: 'searching "JS lab"' } });
  t = applyEvent(t, { event: "ping", data: {} });
  t = applyEvent(t, { event: "tool", data: { type: "tool", name: "state", label: "reading the state of JSLab / Marketing" } });
  expect(t.status).toBe("working");
  expect(t.steps.map((s) => s.label)).toEqual(['searching "JS lab"', "reading the state of JSLab / Marketing"]);
  t = applyEvent(t, { event: "text", data: { type: "text", text: "**JS Lab** is" } });
  t = applyEvent(t, { event: "text", data: { type: "text", text: " a client." } });
  expect(t.status).toBe("answering");
  expect(t.content).toBe("**JS Lab** is a client.");
  t = applyEvent(t, { event: "done", data: { type: "done", tokens: 1834, model: "claude-x", durationMs: 6400 } });
  expect(t.status).toBe("done");
  expect(t.note).toContain("tokens");
  expect(t.note).toContain("claude-x");
  expect(t.note).toContain("6.4 s");
});

test("an error event ends the turn with a readable note", () => {
  let t = applyEvent(newAssistantTurn(), { event: "error", data: { type: "error", kind: "auth", message: "x", resetAt: null } });
  expect(t.status).toBe("error");
  expect(t.note).toContain("not logged in");
  t = applyEvent(newAssistantTurn(), { event: "error", data: { type: "error", kind: "other", message: "boom", resetAt: null } });
  expect(t.note).toBe("boom");
});

test("endTurn: a stream that just stops is cut off, an abort is stopped, a finished turn stays as it is", () => {
  const streaming = applyEvent(newAssistantTurn(), { event: "text", data: { text: "half" } });
  expect(endTurn(streaming, "ended")).toMatchObject({ status: "error", note: "The answer was cut off.", content: "half" });
  expect(endTurn(streaming, "aborted")).toMatchObject({ status: "stopped", note: "Stopped." });
  expect(endTurn(streaming, "dropped")).toMatchObject({ status: "error", note: "The connection dropped." });
  const done = applyEvent(streaming, { event: "done", data: { tokens: 1, model: null, durationMs: 100 } });
  expect(endTurn(done, "ended")).toBe(done);
});

test("historyFor sends user turns and finished answers only, capped at 12, then the new question", () => {
  const turns: Turn[] = [];
  for (let i = 0; i < 8; i++) {
    turns.push({ role: "user", content: `q${i}` });
    turns.push({ ...newAssistantTurn(), content: `a${i}`, status: i === 3 ? "error" : "done" });
  }
  const h = historyFor(turns, "now?");
  expect(h.at(-1)).toEqual({ role: "user", content: "now?" });
  expect(h).toHaveLength(13);
  expect(h.some((m) => m.content === "a3")).toBe(false);
  expect(h.every((m) => Object.keys(m).sort().join() === "content,role")).toBe(true);
});
