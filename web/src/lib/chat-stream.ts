// The chat page's stream handling, as pure functions (tested in web/test/chat-stream.test.ts).
// cerebro-server streams one turn as SSE (server/src/http/routes/dashboard.ts, server/src/chat/runner.ts):
// start {runId, model}, tool {name, label}…, text {text}…, then done {tokens, model, durationMs} or
// error {kind, message, resetAt}; ping {} keep-alives in between.
import { count, when } from "./format";

export type Frame = { event: string; data: any };
export type Step = { label: string };
export type AssistantStatus = "waiting" | "working" | "answering" | "done" | "error" | "stopped";
export type AssistantTurn = { role: "assistant"; content: string; steps: Step[]; status: AssistantStatus; model?: string; note?: string };
export type UserTurn = { role: "user"; content: string };
export type Turn = UserTurn | AssistantTurn;

/** Splits buffered SSE text into whole frames; `rest` is an unfinished frame to prepend to the next chunk. */
export function sseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const text = buffer.replace(/\r\n/g, "\n");
  const frames: Frame[] = [];
  let start = 0;
  let i: number;
  while ((i = text.indexOf("\n\n", start)) >= 0) {
    const block = text.slice(start, i);
    start = i + 2;
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event:"))?.replace(/^event: ?/, "") || "message";
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
    try { frames.push({ event, data: JSON.parse(data || "{}") }); } catch { /* not JSON: skip */ }
  }
  return { frames, rest: text.slice(start) };
}

export const newAssistantTurn = (): AssistantTurn => ({ role: "assistant", content: "", steps: [], status: "waiting" });

export function errorNote(e: { kind?: string; message?: string; resetAt?: string | null }): string {
  switch (e.kind) {
    case "usage_limit": return `The Max plan's usage limit is reached${e.resetAt ? `; it resets ${when(e.resetAt)}` : ""}. Summaries wait too.`;
    case "auth": return "Claude on the server is not logged in (run claude auth login in cerebro-server).";
    case "timeout": return "No answer in time; the run was stopped.";
    case "unavailable": return "Claude is unavailable right now (CLI or network).";
    default: return e.message || "The chat failed.";
  }
}

/** One SSE frame applied to the assistant turn it belongs to. */
export function applyEvent(t: AssistantTurn, { event, data }: Frame): AssistantTurn {
  switch (event) {
    case "start": return { ...t, model: data.model ?? t.model, status: t.status === "waiting" ? "working" : t.status };
    case "tool": return { ...t, steps: [...t.steps, { label: String(data.label ?? data.name ?? "working") }], status: t.content ? t.status : "working" };
    case "text": return { ...t, content: t.content + String(data.text ?? ""), status: "answering" };
    case "done": return {
      ...t, status: "done",
      note: `${count(data.tokens)} tokens · ${data.model ?? t.model ?? "model unknown"} · ${(Number(data.durationMs) / 1000).toFixed(1)} s`,
    };
    case "error": return { ...t, status: "error", note: errorNote(data) };
    default: return t; // ping, unknown
  }
}

const isLive = (s: AssistantStatus) => s === "waiting" || s === "working" || s === "answering";

/** How a turn ends when its stream stops: on its own ("ended"), by the Stop button ("aborted") or by the network. */
export function endTurn(t: AssistantTurn, how: "ended" | "aborted" | "dropped"): AssistantTurn {
  if (!isLive(t.status)) return t;
  if (how === "aborted") return { ...t, status: "stopped", note: "Stopped." };
  return { ...t, status: "error", note: how === "ended" ? "The answer was cut off." : "The connection dropped." };
}

export const isRunning = (t: Turn | undefined) => t?.role === "assistant" && isLive(t.status);

/** The conversation sent with a new question: user turns and finished answers (no tool steps), the last 12. */
export function historyFor(turns: Turn[], question: string): { role: "user" | "assistant"; content: string }[] {
  return [
    ...turns
      .filter((t) => t.role === "user" || (t.status === "done" && t.content))
      .map((t) => ({ role: t.role, content: t.content }))
      .slice(-12),
    { role: "user" as const, content: question },
  ];
}
