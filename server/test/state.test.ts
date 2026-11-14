import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ingest, sess } from "./fixtures";
import { adoptSessions, moveSession } from "../src/bindings";
import { record } from "../src/summarise/budget";
import { runClaude, type ClaudeInput } from "../src/summarise/claude";
import {
  STATE_SCHEMA, markScopesDirty, rebuildState, scopeKey, updateState, type StateDeps,
} from "../src/summarise/state";

const FAKE = "bun server/test/fakes/fake-claude.ts";
const fakeRun = (mode: string, extra: Record<string, string> = {}) => (input: ClaudeInput) =>
  runClaude(input, { ...process.env, SUMMARISER_CMD: FAKE, FAKE_CLAUDE_MODE: mode, ...extra } as NodeJS.ProcessEnv);
const BUDGET = { share: 0.2, windowTokens: 2_000_000 };
const deps = (mode = "ok"): StateDeps => ({ run: fakeRun(mode), budget: BUDGET });

let seqBase = 0;
/**
 * Stores a summary for a binding's scope the way summariseJob does (and marks its scope dirty).
 * With `sessionId` it is a session summary, else an initial-history one.
 */
async function addSummary(
  t: any,
  b: { id: string; clientId: string; projectId: string | null },
  o: { title: string; day: number; facts?: string[]; open?: string[]; resolved?: string[]; decisions?: string[]; sessionId?: string },
): Promise<bigint> {
  const body = {
    title: o.title, period: `2026-11-${o.day}`, overview: `Overview of ${o.title}`,
    decisions: o.decisions ?? [], changes: [], facts: o.facts ?? [], open_threads: o.open ?? [], resolved_threads: o.resolved ?? [],
  };
  const from = new Date(Date.UTC(2026, 10, o.day, 9)).toISOString();
  const to = new Date(Date.UTC(2026, 10, o.day, 11)).toISOString();
  const first = (seqBase += 10);
  const [row] = await t.sql`
    insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq, ts_from, ts_to,
      title, body, text, model)
    values (${o.sessionId ?? null}, ${o.sessionId ? "session" : "history"}, ${b.id}, ${b.clientId}, ${b.projectId},
      ${o.sessionId ? first : null}, ${o.sessionId ? first + 5 : null}, ${from}, ${to}, ${o.title},
      ${JSON.stringify(body)}::text::jsonb, ${body.overview}, 'claude-haiku-fake')
    returning id`;
  await markScopesDirty(t.sql, [scopeKey(b.clientId, b.projectId)]);
  return BigInt(row.id);
}

const stateRow = async (t: any, scope: string) => (await t.sql`select * from project_states where scope = ${scope}`)[0];
const ids = (row: any) => (row.source_summary_ids as unknown[]).map((x) => BigInt(x as any)).sort();

test("STATE_SCHEMA caps every field", () => {
  const p = (STATE_SCHEMA as any).properties;
  expect(p.overview.maxLength).toBe(1500);
  expect(p.current_status.maxLength).toBe(800);
  expect(p.decisions.maxItems).toBe(30);
  expect(p.open_threads.maxItems).toBe(30);
  expect(p.resolved_recently.maxItems).toBe(15);
  expect(p.facts.maxItems).toBe(40);
  expect(Object.keys(p.decisions.items.properties).sort()).toEqual(["date", "text"]);
  expect(Object.keys(p.open_threads.items.properties).sort()).toEqual(["since", "text"]);
  expect(Object.keys(p.resolved_recently.items.properties).sort()).toEqual(["date", "text"]);
  expect((STATE_SCHEMA as any).required.sort()).toEqual(
    ["current_status", "decisions", "facts", "open_threads", "overview", "resolved_recently"]);
});

test("a new summary updates its project's state and closes threads it resolves", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const s1 = await addSummary(t, binding, {
      title: "Login work", day: 1, open: ["Fix the login redirect"], facts: ["Staging is at stage.acme.test"],
      decisions: ["Use OAuth device flow"],
    });
    // No state yet: built from the scope's summaries.
    expect(await updateState(t.sql, scope, [s1], deps())).toMatchObject({
      status: "updated", credentialExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    let st = await stateRow(t, scope);
    expect(st.client_id).toBe(client.id);
    expect(st.project_id).toBe(project.id);
    expect(st.dirty).toBe(false);
    expect(ids(st)).toEqual([s1]);
    expect(st.doc.open_threads).toEqual([{ text: "Fix the login redirect", since: "2026-11-01" }]);
    expect(st.doc.decisions).toEqual([{ text: "Use OAuth device flow", date: "2026-11-01" }]);
    expect(st.text).toContain("Fix the login redirect");
    expect(st.text).toContain("stage.acme.test");
    const v1 = st.version;

    // The prompt fences the current state and the new summaries as data, with a per-call tag.
    const seen: ClaudeInput[] = [];
    const spy = async (input: ClaudeInput) => { seen.push(input); return fakeRun("ok")(input); };
    const s2 = await addSummary(t, binding, { title: "Redirect fixed", day: 3, resolved: ["Fix the login redirect"], open: ["Write the docs"] });
    expect((await updateState(t.sql, scope, [s2], { run: spy, budget: BUDGET })).status).toBe("updated");
    expect(seen).toHaveLength(1);
    const tag = seen[0].prompt.match(/<(state-[0-9a-f]{8})>/)![1];
    expect(seen[0].systemPrompt).toContain(`<${tag}>`);
    expect(seen[0].systemPrompt).toMatch(/data/i);
    expect(seen[0].schema).toBe(STATE_SCHEMA);
    const fenced = seen[0].prompt.split(`<${tag}>`)[1].split(`</${tag}>`)[0];
    const data = JSON.parse(fenced);
    expect(data.current_state.open_threads).toEqual([{ text: "Fix the login redirect", since: "2026-11-01" }]);
    // Only the new summary is sent; already folded ones are not.
    expect(data.new_summaries.map((s: any) => s.title)).toEqual(["Redirect fixed"]);
    expect(data.new_summaries[0]).toMatchObject({ to: "2026-11-03T11:00:00.000Z", resolved_threads: ["Fix the login redirect"] });

    st = await stateRow(t, scope);
    expect(st.version).toBe(v1 + 1);
    expect(ids(st)).toEqual([s1, s2]);
    expect(st.doc.open_threads).toEqual([{ text: "Write the docs", since: "2026-11-03" }]);
    expect(st.doc.resolved_recently).toEqual([{ text: "Fix the login redirect", date: "2026-11-03" }]);
    expect(st.doc.facts).toEqual(["Staging is at stage.acme.test"]);
    expect(st.dirty).toBe(false);
    const [led] = await t.sql`select count(*)::int as n, min(kind) as kind from usage_ledger`;
    expect(led).toEqual({ n: 2, kind: "state" });

    // Nothing new: no call, nothing changes.
    seen.length = 0;
    expect((await updateState(t.sql, scope, [s2], { run: spy, budget: BUDGET })).status).toBe("updated");
    expect(seen).toHaveLength(0);
    expect((await stateRow(t, scope)).version).toBe(v1 + 1);
  } finally { await t.drop(); }
});

test("client-only bindings keep a client-level state", async () => {
  const t = await authedApp();
  try {
    const { client, binding } = await boundFolder(t, { client: "Solo" });
    const pres = await t.call("POST", "/v1/projects", { clientId: client.id, name: "Side" });
    const project = await pres.json();
    const pb = (await (await t.call("PUT", "/v1/bindings", {
      repo: "github.com/solo/side", subpath: "", status: "active", clientId: client.id, projectId: project.id,
    })).json()).binding;
    const clientScope = scopeKey(client.id, null);
    expect(clientScope).toBe(`client:${client.id}`);
    const c1 = await addSummary(t, binding, { title: "Invoices", day: 2, facts: ["Invoices go out on the 1st"] });
    await addSummary(t, pb, { title: "Side project", day: 2, facts: ["Side project uses Rust"] });
    expect((await updateState(t.sql, clientScope, [c1], deps())).status).toBe("updated");
    const st = await stateRow(t, clientScope);
    expect(st.client_id).toBe(client.id);
    expect(st.project_id).toBeNull();
    expect(st.doc.facts).toEqual(["Invoices go out on the 1st"]);
    expect(st.text).not.toContain("Rust"); // project work stays in the project's state
    expect(ids(st)).toEqual([c1]);
  } finally { await t.drop(); }
});

test("re-binding a folder to another client rebuilds both scopes and the old one no longer mentions it", async () => {
  const t = await authedApp();
  try {
    const { client: A, binding: keep } = await boundFolder(t, { client: "Acme", repo: "github.com/acme/keep" });
    const { client: B } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/other" });
    const mover = (await (await t.call("PUT", "/v1/bindings", {
      repo: "github.com/acme/moving", subpath: "", status: "active", clientId: A.id,
    })).json()).binding;
    const scopeA = scopeKey(A.id, null);
    const scopeB = scopeKey(B.id, null);
    await addSummary(t, keep, { title: "Keep work", day: 1, facts: ["Alpha stays with Acme"] });
    const moved = await addSummary(t, mover, { title: "Moving work", day: 2, facts: ["Beta-bound folder fact"], open: ["Ship moving"] });
    expect((await rebuildState(t.sql, scopeA, deps())).status).toBe("updated");
    expect((await stateRow(t, scopeA)).text).toContain("Beta-bound folder fact");
    expect((await stateRow(t, scopeA)).dirty).toBe(false);

    const res = await t.call("PUT", "/v1/bindings", {
      repo: "github.com/acme/moving", subpath: "", status: "active", clientId: B.id, rebind: true,
    });
    expect(res.status).toBe(200);
    // The folder's summaries moved with it; both scopes are flagged.
    const [s] = await t.sql`select client_id, project_id from summaries where id = ${moved}`;
    expect(s).toEqual({ client_id: B.id, project_id: null });
    expect((await stateRow(t, scopeA)).dirty).toBe(true);
    expect((await stateRow(t, scopeB)).dirty).toBe(true);

    for (const scope of [scopeA, scopeB]) expect((await rebuildState(t.sql, scope, deps())).status).toBe("updated");
    const a = await stateRow(t, scopeA);
    const b = await stateRow(t, scopeB);
    expect(a.text).toContain("Alpha stays with Acme");
    expect(a.text).not.toContain("Beta-bound folder fact");
    expect(a.text).not.toContain("Ship moving");
    expect(JSON.stringify(a.doc)).not.toContain("Moving work");
    expect(ids(a)).not.toContain(moved);
    expect(b.text).toContain("Beta-bound folder fact");
    expect(ids(b)).toEqual([moved]);
    expect(a.dirty).toBe(false);
    expect(b.dirty).toBe(false);
  } finally { await t.drop(); }
});

test("an update of a scope that lost summaries rebuilds instead of folding", async () => {
  const t = await authedApp();
  try {
    const { client: A, binding: keep } = await boundFolder(t, { client: "Acme", repo: "github.com/acme/keep" });
    const { client: B } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/other" });
    const mover = (await (await t.call("PUT", "/v1/bindings", {
      repo: "github.com/acme/moving", subpath: "", status: "active", clientId: A.id,
    })).json()).binding;
    const scopeA = scopeKey(A.id, null);
    await addSummary(t, mover, { title: "Moving work", day: 1, facts: ["Leaving fact"] });
    expect((await updateState(t.sql, scopeA, [], deps())).status).toBe("updated");
    await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/moving", subpath: "", status: "active", clientId: B.id, rebind: true });
    const k = await addSummary(t, keep, { title: "Keep work", day: 2, facts: ["Staying fact"] });
    expect((await updateState(t.sql, scopeA, [k], deps())).status).toBe("updated");
    const a = await stateRow(t, scopeA);
    expect(a.text).toContain("Staying fact");
    expect(a.text).not.toContain("Leaving fact");
    expect(ids(a)).toEqual([k]);
  } finally { await t.drop(); }
});

test("declining a folder empties the state its summaries built", async () => {
  const t = await authedApp();
  try {
    const { client, binding } = await boundFolder(t, { client: "Acme" });
    const scope = scopeKey(client.id, null);
    await addSummary(t, binding, { title: "Secret-ish work", day: 1, facts: ["Declined fact"] });
    expect((await rebuildState(t.sql, scope, deps())).status).toBe("updated");
    await t.call("PUT", "/v1/bindings", { repo: binding.repo, subpath: "", status: "declined", rebind: true });
    let called = 0;
    const res = await rebuildState(t.sql, scope, { run: async (i) => { called++; return fakeRun("ok")(i); }, budget: BUDGET });
    expect(res.status).toBe("updated");
    expect(called).toBe(0);
    const st = await stateRow(t, scope);
    expect(st.text).toBe("");
    expect(st.doc.facts).toEqual([]);
    expect(ids(st)).toEqual([]);
  } finally { await t.drop(); }
});

test("adopting and moving sessions re-scope their summaries and flag source and target", async () => {
  const t = await authedApp();
  try {
    const { client: A, binding: root } = await boundFolder(t, { client: "Acme" });
    await ingest(t, { sessions: [sess("s1", root.id, { subpath: "apps/web" })], events: [] });
    const s = await addSummary(t, root, { title: "Web work", day: 1, sessionId: "s1" });
    const B = await (await t.call("POST", "/v1/clients", { name: "Beta" })).json();
    const P = await (await t.call("POST", "/v1/projects", { clientId: B.id, name: "Web" })).json();
    const web = (await (await t.call("PUT", "/v1/bindings", {
      repo: root.repo, subpath: "apps/web", status: "active", clientId: B.id, projectId: P.id,
    })).json()).binding;
    const scopeA = scopeKey(A.id, null);
    const scopeP = scopeKey(B.id, P.id);
    await t.sql`update project_states set dirty = false`;

    expect(await adoptSessions(t.sql, web.id)).toBe(1);
    let [row] = await t.sql`select binding_id, client_id, project_id from summaries where id = ${s}`;
    expect(row).toEqual({ binding_id: web.id, client_id: B.id, project_id: P.id });
    expect((await stateRow(t, scopeA)).dirty).toBe(true);
    expect((await stateRow(t, scopeP)).dirty).toBe(true);

    await t.sql`update project_states set dirty = false`;
    expect(await moveSession(t.sql, "s1", root.id)).toBe(true);
    [row] = await t.sql`select binding_id, client_id, project_id from summaries where id = ${s}`;
    expect(row).toEqual({ binding_id: root.id, client_id: A.id, project_id: null });
    expect((await stateRow(t, scopeA)).dirty).toBe(true);
    expect((await stateRow(t, scopeP)).dirty).toBe(true);
  } finally { await t.drop(); }
});

test("state output is redacted and size-capped", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const s1 = await addSummary(t, binding, { title: "Work", day: 1 });
    expect((await updateState(t.sql, scope, [s1], deps("hostile"))).status).toBe("updated");
    const st = await stateRow(t, scope);
    const all = JSON.stringify(st.doc) + st.text;
    for (const secret of ["sk-ant-api03-AAAA", "sk-ant-api03-CCCC", "hunter2secret", "ghp_bbbb", "\u0000"]) {
      expect(all).not.toContain(secret);
    }
    expect(st.doc.overview.length).toBeLessThanOrEqual(1500);
    expect(st.doc.current_status.length).toBeLessThanOrEqual(800);
    expect(st.doc.decisions).toHaveLength(30);
    expect(st.doc.open_threads).toHaveLength(30);
    expect(st.doc.resolved_recently).toHaveLength(15);
    expect(st.doc.facts).toHaveLength(40);
    for (const d of st.doc.decisions) {
      expect(Object.keys(d).sort()).toEqual(["date", "text"]);
      expect(d.text.length).toBeLessThanOrEqual(300);
      expect(d.date.length).toBeLessThanOrEqual(40);
    }
    for (const f of st.doc.facts) expect(f.length).toBeLessThanOrEqual(300);
    expect(st.doc.instructions).toBeUndefined();
    expect(st.text.length).toBeLessThanOrEqual(6000);
    expect(st.text.isWellFormed()).toBe(true);
  } finally { await t.drop(); }
});

test("output missing fields stores nothing; usage limit and budget defer", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const s1 = await addSummary(t, binding, { title: "Work", day: 1, facts: ["F1"] });
    const before = await stateRow(t, scope);

    expect(await updateState(t.sql, scope, [s1], deps("missing"))).toMatchObject({ status: "failed", reason: "bad_output" });
    expect(await updateState(t.sql, scope, [s1], {
      run: fakeRun("limit", { FAKE_CLAUDE_RESET_EPOCH: "1900000000" }), budget: BUDGET,
    })).toMatchObject({ status: "deferred", reason: "usage_limit", until: new Date(1_900_000_000_000) });
    expect(await updateState(t.sql, scope, [s1], deps("auth"))).toMatchObject({ status: "deferred", reason: "login" });
    let after = await stateRow(t, scope);
    expect(after.version).toBe(before.version);
    expect(after.doc).toEqual({});
    expect(after.dirty).toBe(true);

    // Over budget: deferred until the window frees up, without calling claude.
    await record(t.sql, 400_000, "summary");
    let called = 0;
    const spy = async (i: ClaudeInput) => { called++; return fakeRun("ok")(i); };
    for (const res of [
      await updateState(t.sql, scope, [s1], { run: spy, budget: BUDGET }),
      await rebuildState(t.sql, scope, { run: spy, budget: BUDGET }),
    ]) {
      expect(res).toMatchObject({ status: "deferred", reason: "budget" });
      expect(res.until).toBeInstanceOf(Date);
      expect(res.until!.getTime()).toBeGreaterThan(Date.now() + 4 * 3600_000);
    }
    expect(called).toBe(0);
    after = await stateRow(t, scope);
    expect(after.version).toBe(before.version);
  } finally { await t.drop(); }
});

test("concurrent updates of one scope never lose a summary", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const s1 = await addSummary(t, binding, { title: "One", day: 1, facts: ["fact one"] });
    expect((await updateState(t.sql, scope, [s1], deps())).status).toBe("updated");

    // While the outer update waits on claude, another worker stores and folds a newer summary.
    const s2 = await addSummary(t, binding, { title: "Two", day: 2, facts: ["fact two"] });
    let s3: bigint | undefined;
    const interleaved = async (input: ClaudeInput) => {
      if (s3 === undefined) {
        s3 = await addSummary(t, binding, { title: "Three", day: 3, facts: ["fact three"] });
        expect((await updateState(t.sql, scope, [s3], deps())).status).toBe("updated");
      }
      return fakeRun("ok")(input);
    };
    expect((await updateState(t.sql, scope, [s2], { run: interleaved, budget: BUDGET })).status).toBe("updated");
    let st = await stateRow(t, scope);
    expect(st.doc.facts).toEqual(["fact one", "fact two", "fact three"]);
    expect(ids(st)).toEqual([s1, s2, s3!]);

    // Same for a rebuild racing an update.
    let s4: bigint | undefined;
    const racing = async (input: ClaudeInput) => {
      if (s4 === undefined) {
        s4 = await addSummary(t, binding, { title: "Four", day: 4, facts: ["fact four"] });
        expect((await updateState(t.sql, scope, [s4], deps())).status).toBe("updated");
      }
      return fakeRun("ok")(input);
    };
    expect((await rebuildState(t.sql, scope, { run: racing, budget: BUDGET })).status).toBe("updated");
    st = await stateRow(t, scope);
    expect(st.doc.facts).toEqual(["fact one", "fact two", "fact three", "fact four"]);
    expect(ids(st)).toEqual([s1, s2, s3!, s4!]);

    // Two plain updates at once both land.
    const [s5, s6] = [
      await addSummary(t, binding, { title: "Five", day: 5, facts: ["fact five"] }),
      await addSummary(t, binding, { title: "Six", day: 6, facts: ["fact six"] }),
    ];
    const results = await Promise.all([updateState(t.sql, scope, [s5], deps()), updateState(t.sql, scope, [s6], deps())]);
    expect(results.map((r) => r.status)).toEqual(["updated", "updated"]);
    st = await stateRow(t, scope);
    expect(st.doc.facts).toEqual(expect.arrayContaining(["fact five", "fact six"]));
    expect(ids(st)).toEqual(expect.arrayContaining([s5, s6]));
  } finally { await t.drop(); }
});

test("a rebuild keeps the scope dirty when a new mark arrives while it runs", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await addSummary(t, binding, { title: "One", day: 1, facts: ["fact one"] });
    let marked = false;
    const marking = async (input: ClaudeInput) => {
      if (!marked) { marked = true; await markScopesDirty(t.sql, [scope]); }
      return fakeRun("ok")(input);
    };
    expect((await rebuildState(t.sql, scope, { run: marking, budget: BUDGET })).status).toBe("updated");
    expect((await stateRow(t, scope)).dirty).toBe(true);
    expect((await rebuildState(t.sql, scope, deps())).status).toBe("updated");
    expect((await stateRow(t, scope)).dirty).toBe(false);
  } finally { await t.drop(); }
});

test("a rebuild uses the scope's last 40 summaries, oldest first, ten per call", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const all: bigint[] = [];
    for (let i = 1; i <= 45; i++) all.push(await addSummary(t, binding, { title: `S${i}`, day: 1 + (i % 28), facts: [`f${i}`] }));
    const prompts: string[] = [];
    const spy = async (input: ClaudeInput) => { prompts.push(input.prompt); return fakeRun("ok")(input); };
    expect((await rebuildState(t.sql, scope, { run: spy, budget: BUDGET })).status).toBe("updated");
    expect(prompts).toHaveLength(4);
    const st = await stateRow(t, scope);
    expect(ids(st)).toHaveLength(40);
    // Oldest first: each call's summaries are no newer than the next call's.
    const dates = prompts.map((p) => [...p.matchAll(/"to":"([^"]+)"/g)].map((m) => m[1]));
    const flat = dates.flat();
    expect(flat).toHaveLength(40);
    expect([...flat].sort()).toEqual(flat);
  } finally { await t.drop(); }
});
