import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { indexPending } from "../src/indexer";
import { fakeEmbedder } from "../src/embed/fake";
import { buildServer } from "../src/main";

test("record → index → search → quote, all over HTTP", async () => {
  const t = await authedApp();
  try {
    const json = async (m: string, p: string, b?: any) => (await t.call(m, p, b)).json();
    const client = await json("POST", "/v1/clients", { name: "Acme" });
    const project = await json("POST", "/v1/projects", { clientId: client.id, name: "Launch" });
    const { binding } = await json("PUT", "/v1/bindings", { repo: "github.com/acme/launch", subpath: "", status: "active", clientId: client.id, projectId: project.id });
    const ts = (s: number) => new Date(Date.UTC(2026, 10, 2, 9, 0, s)).toISOString();
    const ingest = await json("POST", "/v1/ingest", {
      sessions: [{ id: "e2e", bindingId: binding.id, cwd: "/work/launch", startedAt: ts(0) }],
      events: [
        { key: "e2e:1", sessionId: "e2e", seq: 1, ts: ts(1), kind: "user", text: "When is the Acme launch?" },
        { key: "e2e:2", sessionId: "e2e", seq: 2, ts: ts(2), kind: "tool_call", text: "", toolName: "Read", toolInput: { file_path: "PLAN.md" } },
        { key: "e2e:3", sessionId: "e2e", seq: 3, ts: ts(3), kind: "tool_result", text: "launch: March 3", toolName: "Read" },
        { key: "e2e:4", sessionId: "e2e", seq: 4, ts: ts(4), kind: "assistant", text: "The launch moved to March 3." },
      ],
    });
    expect(ingest.inserted).toBe(4);
    await indexPending(t.sql, fakeEmbedder());
    const { scope, hits } = await json("POST", "/v1/search", { query: "launch moved", repo: "github.com/acme/launch" });
    expect(scope).toBe("project");
    expect(hits[0].sessionId).toBe("e2e");
    const { events } = await json("GET", `/v1/sessions/e2e/events?fromSeq=${hits[0].firstSeq}&toSeq=${hits[0].lastSeq}`);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.seq >= hits[0].firstSeq && e.seq <= hits[0].lastSeq).toBe(true);
    expect(events.some((e: any) => e.text.includes("March 3"))).toBe(true);
    const all = (await json("GET", "/v1/sessions/e2e/events")).events;
    expect(all.map((e: any) => e.kind)).toEqual(["user", "tool_call", "tool_result", "assistant"]);
    expect((await json("GET", "/v1/status")).unindexedEvents).toBe(0);
  } finally { await t.drop(); }
});

test("main refuses to start without an embedder URL", async () => {
  await expect(buildServer({ DATABASE_URL: "postgres://cerebro:cerebro@127.0.0.1:54329/cerebro" })).rejects.toThrow(/EMBED_URL/);
});
