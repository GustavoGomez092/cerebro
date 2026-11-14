import { test, expect, afterEach } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess } from "./fixtures";
import { createToken } from "../src/auth";
import { createEmbedRouter } from "../src/embed/failover";
import { embedSummary } from "../src/summarise/summarise";
import { fakeOllama } from "./fakes/ollama";

// "test-mac" (authedApp's token) → Mac mini (fill 1), "macbook-pro" → MacBook (fill 3), "check" unmapped; Zima fill 2.
const live: { stop(): void }[] = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

async function world() {
  const mini = fakeOllama(1), mbp = fakeOllama(3), zima = fakeOllama(2);
  live.push(mini, mbp, zima);
  const embedder = createEmbedRouter({
    machineUrls: { "test-mac": mini.url, "macbook-pro": mbp.url }, fallbackUrl: zima.url, model: "bge-m3", dims: 1024, log: () => {},
  });
  const t = await authedApp({ embedder });
  const tokens: Record<string, string> = { "test-mac": t.token };
  for (const m of ["macbook-pro", "check"]) tokens[m] = (await createToken(t.sql, m)).token;
  const { binding } = await boundFolder(t);
  return { t, mini, mbp, zima, tokens, binding };
}
const asked = (o: { inputs: string[][] }) => o.inputs.flat();

test("a search query embeds on the requesting machine's own endpoint; unmapped machines use the Zima", async () => {
  const w = await world();
  try {
    for (const [machine, query] of [["test-mac", "kingfisher pricing"], ["macbook-pro", "heron invoices"], ["check", "osprey"]]) {
      const res = await w.t.call("POST", "/v1/search", { query, scope: "open" }, w.tokens[machine]);
      expect(res.status).toBe(200);
      expect((await res.json()).degradedReasons).toEqual([]);
    }
    expect(asked(w.mini)).toEqual(["kingfisher pricing"]);
    expect(asked(w.mbp)).toEqual(["heron invoices"]);
    expect(asked(w.zima)).toEqual(["osprey"]);
  } finally { await w.t.drop(); }
});

test("a search query falls back to the Zima when its machine's endpoint is down, never to the other Mac", async () => {
  const w = await world();
  try {
    w.mini.server.stop(true);
    const res = await w.t.call("POST", "/v1/search", { query: "kingfisher pricing", scope: "open" }, w.tokens["test-mac"]);
    expect((await res.json()).degradedReasons).toEqual([]);
    expect(asked(w.zima)).toEqual(["kingfisher pricing"]);
    expect(w.mbp.embedCalls).toBe(0);
  } finally { await w.t.drop(); }
});

test("a session summary embeds on the session's machine; a summary without a session on the Zima", async () => {
  const w = await world();
  try {
    const res = await w.t.call("POST", "/v1/ingest", {
      sessions: [sess("mbp-1", w.binding.id)], events: [ev("mbp-1", 1, "user", "hello")],
    }, w.tokens["macbook-pro"]);
    expect(res.status).toBe(200);
    const insert = async (sessionId: string | null) => (await w.t.sql`
      insert into summaries (session_id, kind, binding_id, ts_from, ts_to, title, body, text, model)
      values (${sessionId}, ${sessionId ? "session" : "history"}, ${w.binding.id}, now(), now(), 't', '{}'::jsonb, 'x', 'test')
      returning id`)[0].id;
    expect(await embedSummary(w.t.sql, w.t.embedder, await insert("mbp-1"), "session summary text")).toBe(false); // text differs: not stored
    expect(asked(w.mbp)).toEqual(["session summary text"]);
    await embedSummary(w.t.sql, w.t.embedder, await insert(null), "orphan history text");
    expect(asked(w.zima)).toEqual(["orphan history text"]);
    expect(w.mini.embedCalls).toBe(0);
  } finally { await w.t.drop(); }
});

test("a history posted by a machine embeds on that machine's endpoint", async () => {
  const w = await world();
  try {
    const res = await w.t.call("POST", "/v1/summaries", {
      repo: "github.com/acme/app", title: "History", text: "How the app got here.", tsFrom: "2026-11-01T00:00:00.000Z", tsTo: "2026-11-02T00:00:00.000Z",
    }, w.tokens["macbook-pro"]);
    expect(res.status).toBe(201);
    for (let i = 0; i < 100 && w.mbp.embedCalls === 0; i++) await Bun.sleep(10); // embedded in the background
    expect(w.mbp.embedCalls).toBe(1);
    expect(w.mini.embedCalls + w.zima.embedCalls).toBe(0);
  } finally { await w.t.drop(); }
});
