import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { ev, sess, ingest } from "./fixtures";
import { embedPending, newWorkerState } from "../src/worker";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";
import { embedSummary, summaryEmbedText } from "../src/summarise/summarise";
import { search } from "../src/search";

const down: Embedder = { dims: 1024, embed: async () => { throw new EmbedderError("down", { transient: true }); } };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

/** Polls `check` until it returns true (or fails after `ms`). */
async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}

/**
 * Two clients: Acme (project P1 on a/one, client-only a/three) and Beta (project P2 on b/two),
 * plus a declined folder x/held.
 */
async function world(opts: { embedder?: Embedder } = {}) {
  const t = await authedApp({ embedder: opts.embedder });
  const post = async (p: string, b: any) => (await t.call("POST", p, b)).json();
  const A = await post("/v1/clients", { name: "Acme" });
  const B = await post("/v1/clients", { name: "Beta" });
  const P1 = await post("/v1/projects", { clientId: A.id, name: "P1" });
  const P2 = await post("/v1/projects", { clientId: B.id, name: "P2" });
  const bind = async (repo: string, clientId: string | null, projectId?: string, status = "active", subpath = "", rebind?: boolean) =>
    (await (await t.call("PUT", "/v1/bindings", { repo, subpath, status, clientId, projectId, rebind })).json()).binding;
  const b1 = await bind("github.com/a/one", A.id, P1.id);
  const b2 = await bind("github.com/b/two", B.id, P2.id);
  const b3 = await bind("github.com/a/three", A.id);
  const held = await bind("github.com/x/held", null, undefined, "declined");
  /** A stored, embedded summary (as the summariser would leave it). */
  const summary = async (binding: any, s: { title: string; overview: string; facts?: string[]; tsFrom: string; tsTo: string; sessionId?: string; kind?: string }) => {
    const body = { title: s.title, period: "", overview: s.overview, decisions: [], changes: [], facts: s.facts ?? [], open_threads: [], resolved_threads: [] };
    const [row] = await t.sql`
      insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
      values (${s.sessionId ?? null}, ${s.kind ?? (s.sessionId ? "session" : "history")}, ${binding.id}, ${binding.clientId}, ${binding.projectId},
              ${s.sessionId ? 1 : null}, ${s.sessionId ? 1 : null}, ${s.tsFrom}, ${s.tsTo}, ${s.title},
              ${JSON.stringify(body)}::text::jsonb, ${s.overview + "\n" + (s.facts ?? []).join("\n")}, 'test')
      returning id`;
    await embedSummary(t.sql, fakeEmbedder(), row.id, summaryEmbedText({ title: s.title, body }));
    return Number(row.id);
  };
  const get = async (p: string) => {
    const res = await t.call("GET", p);
    return { status: res.status, body: await res.json() };
  };
  return { t, A, B, P1, P2, b1, b2, b3, held, bind, summary, get };
}

test("state is project-locked like reads", async () => {
  const { t, A, B, P1, P2, get } = await world();
  try {
    const state = async (scope: string, client: string, project: string | null, text: string) =>
      t.sql`insert into project_states (scope, client_id, project_id, doc, text, version)
            values (${scope}, ${client}, ${project}, ${JSON.stringify({ overview: text })}::text::jsonb, ${text}, 3)`;
    await state(`project:${P1.id}`, A.id, P1.id, "P1 state");
    await state(`project:${P2.id}`, B.id, P2.id, "P2 state");
    await state(`client:${A.id}`, A.id, null, "Acme state");

    // A project-bound folder gets its project's state, whatever else it asks for.
    const locked = await get(`/v1/state?repo=git@github.com:a/one.git&clientId=${B.id}&projectId=${P2.id}`);
    expect(locked.status).toBe(200);
    expect(locked.body.scope).toBe(`project:${P1.id}`);
    expect(locked.body.state).toMatchObject({ text: "P1 state", doc: { overview: "P1 state" }, version: 3 });
    expect(typeof locked.body.state.updatedAt).toBe("string");

    // Open scope: explicit filters choose the state.
    expect((await get(`/v1/state?scope=open&projectId=${P2.id}`)).body.state.text).toBe("P2 state");
    expect((await get(`/v1/state?scope=open&clientId=${A.id}`)).body.state.text).toBe("Acme state");
    // A project that is not the named client's is no state at all.
    expect((await get(`/v1/state?scope=open&clientId=${A.id}&projectId=${P2.id}`)).body.state).toBeNull();
    // A client-only folder defaults to its client's state.
    const clientOnly = await get("/v1/state?repo=github.com/a/three");
    expect(clientOnly.body).toMatchObject({ scope: `client:${A.id}`, state: { text: "Acme state" } });
    // Unbound folder or bare open scope: no single state to show.
    expect((await get("/v1/state?repo=never-bound")).body).toEqual({ scope: null, state: null });
    expect((await get("/v1/state?scope=open")).body).toEqual({ scope: null, state: null });
    // A declined subfolder inside the locked repo stays locked.
    await t.call("PUT", "/v1/bindings", { repo: "github.com/a/one", subpath: "scratch", status: "declined" });
    expect((await get("/v1/state?repo=github.com/a/one&subpath=scratch/x")).body.scope).toBe(`project:${P1.id}`);

    // A scope with only the placeholder row (marked dirty, never built) has no state yet.
    await t.sql`update project_states set text = '', doc = '{}'::jsonb where scope = ${`project:${P1.id}`}`;
    expect((await get("/v1/state?repo=github.com/a/one")).body).toEqual({ scope: `project:${P1.id}`, state: null });

    expect((await get("/v1/state")).status).toBe(400);
    expect((await get("/v1/state")).body.error).toBe("scope_required");
    expect((await get("/v1/state?repo=github.com/a/one&subpath=../x")).status).toBe(400);
  } finally { await t.drop(); }
});

test("summaries list pages and filters by date", async () => {
  const { t, b1, b2, b3, held, bind, summary, get, A, B, P2 } = await world();
  try {
    await ingest(t, { sessions: [{ ...sess("s1", b1.id, { repo: "github.com/a/one" }), startedAt: day(1) }], events: [{ ...ev("s1", 1, "user", "x"), ts: day(1) }] });
    const one = await summary(b1, { sessionId: "s1", title: "Day one", overview: "first", facts: ["f1"], tsFrom: day(1, 10), tsTo: day(1, 11) });
    const two = await summary(b1, { title: "Day five history", overview: "fifth", tsFrom: day(5, 10), tsTo: day(5, 11) });
    const three = await summary(b1, { title: "Day nine", overview: "ninth", tsFrom: day(9, 10), tsTo: day(9, 11) });
    await summary(b2, { title: "Beta work", overview: "beta", tsFrom: day(6), tsTo: day(6) });
    await summary(b3, { title: "Acme misc", overview: "misc", tsFrom: day(7), tsTo: day(7) });
    await summary(held, { title: "Held", overview: "never shown", tsFrom: day(8), tsTo: day(8) });

    const page1 = await get("/v1/summaries?repo=github.com/a/one&limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.summaries.map((s: any) => s.id)).toEqual([three, two]);
    expect(page1.body.next).toBeTruthy();
    const page2 = await get(`/v1/summaries?repo=github.com/a/one&limit=2&before=${encodeURIComponent(page1.body.next)}`);
    expect(page2.body.summaries.map((s: any) => s.id)).toEqual([one]);
    expect(page2.body.next).toBeNull();
    expect(page2.body.summaries[0]).toEqual({
      id: one, kind: "session", sessionId: "s1", firstSeq: 1, lastSeq: 1, tsFrom: day(1, 10), tsTo: day(1, 11),
      title: "Day one", overview: "first", facts: ["f1"], clientName: "Acme", projectName: "P1",
    });
    expect(page1.body.summaries[1]).toMatchObject({ kind: "history", sessionId: null, firstSeq: null, lastSeq: null });

    // Date window: overlapping summaries only.
    const win = await get(`/v1/summaries?repo=github.com/a/one&from=${day(4)}&to=${day(6)}`);
    expect(win.body.summaries.map((s: any) => s.id)).toEqual([two]);
    expect((await get(`/v1/summaries?repo=github.com/a/one&from=${day(6)}&to=${day(4)}`)).status).toBe(400);
    expect((await get("/v1/summaries?repo=github.com/a/one&limit=101")).status).toBe(400);
    expect((await get("/v1/summaries?repo=github.com/a/one&before=garbage")).status).toBe(400);

    // Open scope sees every active binding, never the declined one; filters narrow it.
    const open = await get("/v1/summaries?scope=open");
    expect(open.body.summaries.map((s: any) => s.title).sort()).toEqual(["Acme misc", "Beta work", "Day five history", "Day nine", "Day one"]);
    expect((await get(`/v1/summaries?scope=open&clientId=${A.id}`)).body.summaries).toHaveLength(4);
    expect((await get("/v1/summaries")).status).toBe(400);

    // Equal timestamps down to the microsecond page by id: nothing skipped, nothing repeated.
    const tie = [
      await summary(b2, { title: "Tie one", overview: "t", tsFrom: day(20), tsTo: day(20) }),
      await summary(b2, { title: "Tie two", overview: "t", tsFrom: day(21), tsTo: day(21) }),
    ];
    await t.sql`update summaries set ts_to = '2026-10-21T00:00:00.123456Z' where id = ${tie[0]} or id = ${tie[1]}`;
    const seen: number[] = [];
    let next: string | null = "";
    while (next !== null && seen.length < 10) {
      const page = await get(`/v1/summaries?scope=open&projectId=${P2.id}&limit=1${next ? `&before=${encodeURIComponent(next)}` : ""}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.summaries.map((s: any) => s.id));
      next = page.body.next;
    }
    expect(seen.slice(0, 2)).toEqual([tie[1], tie[0]]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(3);

    // A folder re-bound to another client takes its summaries out of the old client's scope.
    await bind("github.com/a/three", B.id, P2.id, "active", "", true);
    expect((await get(`/v1/summaries?scope=open&clientId=${A.id}`)).body.summaries.map((s: any) => s.title)).not.toContain("Acme misc");
  } finally { await t.drop(); }
});

test("initial history is stored for the bound folder only and redacted", async () => {
  const { t, P1, A, get } = await world();
  try {
    const save = (b: any) => t.call("POST", "/v1/summaries", b);
    const key = "sk-ant-api03-" + "x1".repeat(20);
    const history = {
      repo: "github.com/a/one", subpath: "pkg/web", title: `History with ${key}`,
      text: `How it got here. DB_PASSWORD=hunter2hunter2 and token ${key}. Zebra importer launched.\u0000`,
      tsFrom: day(1), tsTo: day(30),
    };

    expect((await save({ ...history, repo: "never-bound" })).status).toBe(404);
    expect((await (await save({ ...history, repo: "never-bound" })).json()).error).toBe("unknown_binding");
    expect((await save({ ...history, repo: "github.com/x/held" })).status).toBe(409);
    expect((await save({ ...history, title: "x".repeat(201) })).status).toBe(400);
    expect((await save({ ...history, text: "x".repeat(20001) })).status).toBe(400);
    expect((await save({ ...history, tsFrom: day(30), tsTo: day(1) })).status).toBe(400);
    expect((await save({ ...history, repo: "path:other-mac:/x" })).status).toBe(403);
    expect(Number((await t.sql`select count(*) from summaries`)[0].count)).toBe(0);

    const res = await save(history);
    expect(res.status).toBe(201);
    const { summary } = await res.json();
    expect(summary).toMatchObject({ kind: "history", sessionId: null, tsFrom: day(1), tsTo: day(30), clientName: "Acme", projectName: "P1" });

    const [row] = await t.sql`select * from summaries where id = ${summary.id}`;
    expect(row).toMatchObject({ kind: "history", session_id: null, client_id: A.id, project_id: P1.id });
    for (const s of [row.title, row.text, JSON.stringify(row.body)]) {
      expect(s).not.toContain(key);
      expect(s).not.toContain("hunter2");
      expect(s).not.toContain("\u0000");
    }
    expect(row.text).toContain("[REDACTED:anthropic-key]");
    expect(row.body.overview).toContain("Zebra importer");
    await until(async () => (await t.sql`select 1 from summary_embeddings where summary_id = ${row.id}`).length === 1);
    const [st] = await t.sql`select dirty from project_states where scope = ${`project:${P1.id}`}`;
    expect(st.dirty).toBe(true);
    expect((await t.sql`select count(*)::int as n from usage_ledger`)[0].n).toBe(0);

    // Listed for the folder; a 20 000-character text fits the request limit; the same period replaces.
    expect((await get("/v1/summaries?repo=github.com/a/one")).body.summaries.map((s: any) => s.id)).toEqual([summary.id]);
    const again = await save({ ...history, title: "Rewritten history", text: "z".repeat(20000) });
    expect(again.status).toBe(200);
    expect((await again.json()).summary.id).toBe(summary.id);
    const rows = await t.sql`select title from summaries`;
    expect(rows.map((r: any) => r.title)).toEqual(["Rewritten history"]);
    await until(async () => (await t.sql`select 1 from summary_embeddings where summary_id = ${row.id}`).length === 1);
  } finally { await t.drop(); }
});

test("saving a history answers at once and embeds in the background", async () => {
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  const slow: Embedder = { dims: 1024, embed: async (texts) => { await answered; return fakeEmbedder().embed(texts); } };
  const { t } = await world({ embedder: slow });
  try {
    const started = Date.now();
    const res = await t.call("POST", "/v1/summaries", { repo: "github.com/a/one", subpath: "", title: "Slow history", text: "the zebra importer", tsFrom: day(1), tsTo: day(2) });
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
    const { summary } = await res.json();
    expect((await t.sql`select count(*)::int as n from summary_embeddings`)[0].n).toBe(0);
    release();
    await until(async () => (await t.sql`select 1 from summary_embeddings where summary_id = ${summary.id}`).length === 1);
  } finally { release(); await t.drop(); }
});

test("an un-embedded history is still stored and found by full text", async () => {
  const { t } = await world({ embedder: down });
  try {
    const res = await t.call("POST", "/v1/summaries", { repo: "github.com/a/one", subpath: "", title: "Zebra history", text: "the zebra importer", tsFrom: day(1), tsTo: day(2) });
    expect(res.status).toBe(201);
    expect((await t.sql`select count(*)::int as n from summary_embeddings`)[0].n).toBe(0);
    const r = await (await t.call("POST", "/v1/search", { query: "zebra", repo: "github.com/a/one" })).json();
    expect(r.hits.map((h: any) => h.kind)).toEqual(["summary"]);
  } finally { await t.drop(); }
});

test("search returns summary hits with kind, and include=raw excludes them", async () => {
  const { t, b1, b2, held, summary, P1 } = await world();
  try {
    await ingest(t, { sessions: [{ ...sess("s1", b1.id, { repo: "github.com/a/one" }), startedAt: day(1) }], events: [{ ...ev("s1", 1, "user", "pricing tiers for the dashboard"), ts: day(1) }] });
    await embedPending(t.sql, fakeEmbedder(), { state: newWorkerState() });
    const mine = await summary(b1, { sessionId: "s1", title: "Pricing tiers decided", overview: "pricing tiers for the dashboard", tsFrom: day(1), tsTo: day(1) });
    await summary(b2, { title: "Beta pricing", overview: "pricing tiers for Beta", tsFrom: day(2), tsTo: day(2) });
    await summary(held, { title: "Held pricing", overview: "pricing tiers held", tsFrom: day(3), tsTo: day(3) });

    const s = async (b: any) => {
      const res = await t.call("POST", "/v1/search", b);
      expect(res.status).toBe(200);
      return res.json();
    };
    const all = await s({ query: "pricing tiers", repo: "github.com/a/one" });
    expect(all.hits.map((h: any) => h.kind)).toEqual(["summary", "chunk"]);
    const [sh, ch] = all.hits;
    expect(sh).toMatchObject({ kind: "summary", summaryId: mine, sessionId: "s1", firstSeq: 1, lastSeq: 1, projectName: "P1" });
    expect(sh.matched).toEqual(expect.arrayContaining(["fts", "vec"]));
    expect(sh.snippet).toContain("Pricing tiers decided");
    expect(sh.chunkId).toBeUndefined();
    expect(ch).toMatchObject({ kind: "chunk", sessionId: "s1" });
    expect(typeof ch.chunkId).toBe("number");
    // Equal fusion scores: the summary ranks first.
    expect(sh.score).toBe(ch.score);

    const raw = await s({ query: "pricing tiers", repo: "github.com/a/one", include: "raw" });
    expect(raw.hits.map((h: any) => h.kind)).toEqual(["chunk"]);
    const only = await s({ query: "pricing tiers", repo: "github.com/a/one", include: "summaries" });
    expect(only.hits.map((h: any) => h.summaryId)).toEqual([mine]);

    // Open scope: every active binding's summaries, never a declined one's; dates filter summaries too.
    const open = await s({ query: "pricing tiers", scope: "open", include: "summaries" });
    expect(open.hits.map((h: any) => h.snippet.split(" — ")[0]).sort()).toEqual(["Beta pricing", "Pricing tiers decided"]);
    const dated = await s({ query: "pricing tiers", scope: "open", include: "summaries", from: day(2, 0), to: day(2, 23) });
    expect(dated.hits.map((h: any) => h.snippet.split(" — ")[0])).toEqual(["Beta pricing"]);

    expect((await t.call("POST", "/v1/search", { query: "x", scope: "open", include: "bogus" })).status).toBe(400);
  } finally { await t.drop(); }
});

test("degraded reasons come back sorted", async () => {
  const { t, b1, summary } = await world();
  const lock = await t.sql.reserve();
  try {
    await summary(b1, { title: "Zebra summary", overview: "zebra", tsFrom: day(1), tsTo: day(1) });
    // The summaries table is locked, so its full-text leg hits the 5 s statement timeout; the query
    // embedding fails later (5.5 s), so the reasons arrive out of order.
    await lock`begin`;
    await lock`lock table summaries in access exclusive mode`;
    const hang: Embedder = { dims: 1024, embed: (_x, signal) => new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new EmbedderError("aborted")))) };
    const r = await search(t.sql, hang, { query: "zebra", repo: "github.com/a/one" }, { embedTimeoutMs: 5500 });
    expect(r.degradedReasons).toEqual(["embedder", "summary_fts_timeout"]);
  } finally {
    await lock`rollback`;
    lock.release();
    await t.drop();
  }
}, 20_000);

test("summary legs degrade on their own", async () => {
  const { t, b1, summary } = await world({ embedder: down });
  try {
    await summary(b1, { title: "Zebra summary", overview: "zebra", tsFrom: day(1), tsTo: day(1) });
    const r = await (await t.call("POST", "/v1/search", { query: "zebra", repo: "github.com/a/one" })).json();
    expect(r.degraded).toBe(true);
    expect(r.degradedReasons).toEqual(["embedder"]);
    expect(r.hits.map((h: any) => h.kind)).toEqual(["summary"]);
    expect(r.hits[0].matched).toEqual(["fts"]);
  } finally { await t.drop(); }
});

test("an embedding of replaced history text is dropped, not stored over the new text's", async () => {
  const { t, b1 } = await world();
  try {
    const post = (text: string) => t.call("POST", "/v1/summaries", {
      repo: b1.repo, subpath: "", title: "History", text, tsFrom: day(1), tsTo: day(2),
    });
    const first = await post("First draft about zebras");
    expect(first.status).toBe(201);
    const id = (await first.json()).summary.id;
    const vector = async () => (await t.sql`select embedding::text as v from summary_embeddings where summary_id = ${id}`)[0]?.v;
    await until(async () => !!(await vector()));
    const [old] = await t.sql`select title, body from summaries where id = ${id}`;

    // A slow embed of the old text is still in flight when the history is replaced.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: Embedder = { dims: 1024, embed: async (texts, signal) => { await gate; return fakeEmbedder().embed(texts, signal); } };
    const stale = embedSummary(t.sql, slow, id, summaryEmbedText(old));

    expect((await post("Second draft about giraffes")).status).toBe(200);
    await until(async () => !!(await vector()));
    const fresh = await vector();
    release();
    const wrote = await stale;
    expect(await vector()).toBe(fresh);
    expect(wrote).toBe(false);
  } finally { await t.drop(); }
});
