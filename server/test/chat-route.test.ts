import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatWorld } from "./chat-world";

type Sse = { event: string; data: any };
const parseSse = (text: string): Sse[] =>
  text.split("\n\n").filter((b) => b.trim()).map((b) => {
    const event = /^event: (.*)$/m.exec(b)?.[1] ?? "message";
    const data = b.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    return { event, data: JSON.parse(data) };
  });
const ask = (w: any, content: string, tok?: string) => w.call("POST", "/v1/dashboard/chat", { messages: [{ role: "user", content }] }, tok ?? w.ui);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("chat streams tool steps, text and usage as server-sent events, and counts the usage", async () => {
  const w = await chatWorld();
  w.endStandingRun();
  try {
    const res = await ask(w, "wordpress checkout");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events[0].event).toBe("start");
    expect(events.find((e) => e.event === "tool")?.data).toEqual({ type: "tool", name: "global_search", label: 'searching "wordpress checkout"' });
    expect(events.filter((e) => e.event === "text").map((e) => e.data.text).join("")).toBe("Found 2 hit(s) in Cadco.");
    expect(events.at(-1)).toMatchObject({ event: "done", data: { tokens: 150, model: "claude-sonnet-fake" } });
    const o = await (await w.call("GET", "/v1/dashboard/overview", undefined, w.ui)).json();
    expect(o.chat.window).toEqual({ hours: 5, tokens: 150, runs: 1 });
    expect(o.chat.lastRun).toMatchObject({ outcome: "ok", tokens: 150, model: "claude-sonnet-fake" });
    // Chat spend never enters the summariser's ledger.
    const [{ n }] = await w.sql`select count(*)::int as n from usage_ledger`;
    expect(n).toBe(0);
    // Nothing of the conversation is recorded as sessions or events.
    const [{ e }] = await w.sql`select count(*)::int as e from events`;
    expect(e).toBe(2);
  } finally { await w.close(); }
});

test("only the web-ui token may chat", async () => {
  const w = await chatWorld();
  w.endStandingRun();
  try {
    expect((await ask(w, "hi", w.mac)).status).toBe(403);
    const none = await w.app.request("/v1/dashboard/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
  } finally { await w.close(); }
});

test("chat answers 503 when the server has no chat configured", async () => {
  const w = await chatWorld({ chat: false });
  try {
    const res = await ask(w, "hi");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("chat_unavailable");
  } finally { await w.close(); }
});

test("chat validates the conversation: user turns last, bounded", async () => {
  const w = await chatWorld();
  w.endStandingRun();
  try {
    for (const body of [{}, { messages: [] }, { messages: [{ role: "assistant", content: "x" }] }, { messages: [{ role: "user", content: "" }] },
      { messages: [{ role: "system", content: "x" }] }, { messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) }]) {
      const res = await w.call("POST", "/v1/dashboard/chat", body, w.ui);
      expect(res.status).toBe(400);
    }
  } finally { await w.close(); }
});

test("one run at a time: a second chat is refused while one runs; cancelling frees the slot and kills the CLI", async () => {
  const pidfile = join(process.env.TMPDIR ?? "/tmp", `chat-pid-${crypto.randomUUID()}`);
  const w = await chatWorld({ mode: "slow", flags: [`--fake-pidfile=${pidfile}`] });
  w.endStandingRun();
  try {
    const first = await ask(w, "slow one");
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read(); // the start event
    for (let i = 0; i < 100 && !existsSync(pidfile); i++) await Bun.sleep(50);
    const busy = await ask(w, "second");
    expect(busy.status).toBe(429);
    expect((await busy.json()).error).toBe("chat_busy");
    await reader.cancel(); // the browser closed the stream
    for (let i = 0; i < 100 && w.runs.count > 0; i++) await Bun.sleep(20);
    expect(w.runs.count).toBe(0);
    await Bun.sleep(100);
    expect(alive(Number(await Bun.file(pidfile).text()))).toBe(false);
    const o = await (await w.call("GET", "/v1/dashboard/overview", undefined, w.ui)).json();
    expect(o.chat.lastRun.outcome).toBe("cancelled");
  } finally { await w.close(); }
});

test("a quiet run sends keep-alive pings so idle timeouts don't cut the stream", async () => {
  const w = await chatWorld({ mode: "slow", keepAliveMs: 100 });
  w.endStandingRun();
  try {
    const res = await ask(w, "hi");
    const reader = res.body!.getReader();
    let text = "";
    for (let i = 0; i < 20 && !text.includes("event: ping"); i++) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: ping");
    await reader.cancel();
    for (let i = 0; i < 100 && w.runs.count > 0; i++) await Bun.sleep(20);
  } finally { await w.close(); }
});

test("a usage limit reaches the browser as an error event and shows on the overview", async () => {
  const w = await chatWorld({ mode: "limit" });
  w.endStandingRun();
  try {
    const events = parseSse(await (await ask(w, "hi")).text());
    expect(events.at(-1)).toMatchObject({ event: "error", data: { kind: "usage_limit", resetAt: new Date(1_900_000_000_000).toISOString() } });
    const o = await (await w.call("GET", "/v1/dashboard/overview", undefined, w.ui)).json();
    expect(o.chat.lastLimit.resetAt).toBe(new Date(1_900_000_000_000).toISOString());
  } finally { await w.close(); }
});

test("a timed-out run ends the stream with a timeout error and frees the slot", async () => {
  const w = await chatWorld({ mode: "slow", timeoutMs: 700 });
  w.endStandingRun();
  try {
    const events = parseSse(await (await ask(w, "hi")).text());
    expect(events.at(-1)).toMatchObject({ event: "error", data: { kind: "timeout" } });
    expect(w.runs.count).toBe(0);
  } finally { await w.close(); }
});
