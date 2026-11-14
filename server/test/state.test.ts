import { test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authedApp } from "./helpers";
import { boundFolder, ev, ingest, sess } from "./fixtures";
import { adoptSessions, moveSession } from "../src/bindings";
import { endSession } from "../src/ingest";
import { claimSummaryJob } from "../src/summarise/jobs";
import { summariseJob } from "../src/summarise/summarise";
import { budgetState, record } from "../src/summarise/budget";
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
  o: {
    title: string; day: number; facts?: string[]; open?: string[]; resolved?: string[]; decisions?: string[];
    sessionId?: string; big?: boolean;
  },
): Promise<bigint> {
  const full = (n: number, what: string) => Array.from({ length: n }, (_, i) => `${o.title} ${what} ${i} `.padEnd(300, "y"));
  const body = o.big
    ? {
      title: o.title, period: `2026-11-${o.day}`, overview: `Overview of ${o.title} `.padEnd(1200, "o"),
      decisions: full(20, "decision"), changes: full(20, "change"), facts: full(30, "fact"),
      open_threads: full(20, "open"), resolved_threads: full(20, "resolved"),
    }
    : {
      title: o.title, period: `2026-11-${o.day}`, overview: `Overview of ${o.title}`,
      decisions: o.decisions ?? [], changes: [], facts: o.facts ?? [], open_threads: o.open ?? [], resolved_threads: o.resolved ?? [],
    };
  const first = (seqBase += 10);
  // A distinct start per row: initial histories are unique per binding and period.
  const from = new Date(Date.UTC(2026, 10, o.day, 9, 0, first)).toISOString();
  const to = new Date(Date.UTC(2026, 10, o.day, 11)).toISOString();
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

/** Waits until some query in this test database is blocked on a lock; false after ~3 s. */
async function lockWaitSeen(t: any): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const [w] = await t.sql`
      select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`;
    if (w.n > 0) return true;
    await Bun.sleep(25);
  }
  return false;
}

const stateRow = async (t: any, scope: string) => (await t.sql`select * from project_states where scope = ${scope}`)[0];
/** bigint ids in numeric order (a plain sort() would compare them as strings). */
const sortedIds = (xs: unknown[]) => xs.map((x) => BigInt(x as any)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const ids = (row: any) => sortedIds(row.source_summary_ids);

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

test("a scope that lost summaries to a re-bind stops serving its stale state at once; one that gained keeps its own", async () => {
  const t = await authedApp();
  try {
    const { client: A, binding: keep } = await boundFolder(t, { client: "Acme", repo: "github.com/acme/keep" });
    const { client: B, binding: other } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/other" });
    const mover = (await (await t.call("PUT", "/v1/bindings", {
      repo: "github.com/acme/moving", subpath: "", status: "active", clientId: A.id,
    })).json()).binding;
    const scopeA = scopeKey(A.id, null);
    const scopeB = scopeKey(B.id, null);
    await addSummary(t, keep, { title: "Keep work", day: 1, facts: ["Alpha stays with Acme"] });
    await addSummary(t, mover, { title: "Moving work", day: 2, facts: ["Beta project detail"] });
    await addSummary(t, other, { title: "Other work", day: 3, facts: ["Beta own fact"] });
    for (const scope of [scopeA, scopeB]) expect((await rebuildState(t.sql, scope, deps())).status).toBe("updated");
    const brief = async (repo: string) =>
      (await (await t.call("GET", `/v1/state?repo=${encodeURIComponent(repo)}&subpath=`)).json()).state;
    expect((await brief("github.com/acme/keep")).text).toContain("Beta project detail");

    await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/moving", subpath: "", status: "active", clientId: B.id, rebind: true });
    // Acme's other folders no longer get a brief describing the moved work, even before any rebuild runs.
    expect(await brief("github.com/acme/keep")).toBeNull();
    const a = await stateRow(t, scopeA);
    expect([a.text, a.doc, a.dirty]).toEqual(["", {}, true]);
    // Beta gained summaries: its own state stays readable until its rebuild.
    expect((await brief("github.com/beta/other")).text).toContain("Beta own fact");
    expect((await stateRow(t, scopeB)).dirty).toBe(true);

    expect((await rebuildState(t.sql, scopeA, deps())).status).toBe("updated");
    const rebuilt = await brief("github.com/acme/keep");
    expect(rebuilt.text).toContain("Alpha stays with Acme");
    expect(rebuilt.text).not.toContain("Beta project detail");
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
    // An outage is the loop's concern (it pauses and probes), not a failure of this scope.
    for (const mode of ["connection", "overloaded"]) {
      expect(await updateState(t.sql, scope, [s1], deps(mode))).toMatchObject({ status: "deferred", reason: "unavailable" });
    }
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
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    const all: bigint[] = [];
    for (let i = 1; i <= 45; i++) {
      all.push(await addSummary(t, binding, { title: `S${i}`, day: 1 + (i % 28), facts: [`f${i}`], sessionId: "s1" }));
    }
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

test("a scope receiving re-bound summaries is rebuilt, not folded into", async () => {
  const t = await authedApp();
  try {
    const { binding: old } = await boundFolder(t, { client: "Acme", repo: "github.com/acme/old" });
    const { client: B, binding: own } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/own" });
    const scopeB = scopeKey(B.id, null);
    const o1 = await addSummary(t, old, { title: "Old one", day: 1, facts: ["old fact one"] });
    const o2 = await addSummary(t, old, { title: "Old two", day: 2, facts: ["old fact two"] });
    const n1 = await addSummary(t, own, { title: "New one", day: 10, facts: ["new fact one"] });
    const n2 = await addSummary(t, own, { title: "Newest work", day: 11, facts: ["new fact two"] });
    expect((await updateState(t.sql, scopeB, [n1, n2], deps())).status).toBe("updated");
    const before = await stateRow(t, scopeB);

    await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/old", subpath: "", status: "active", clientId: B.id, rebind: true });
    const invalidated = await stateRow(t, scopeB);
    expect(invalidated.version).toBe(before.version + 1); // an in-flight update loses its compare-and-set
    expect(ids(invalidated)).toEqual([]);
    expect(invalidated.dirty).toBe(true);

    expect((await updateState(t.sql, scopeB, [], deps())).status).toBe("updated");
    const updated = await stateRow(t, scopeB);
    expect(updated.doc.current_status).toBe("Latest: Newest work"); // older work did not become current
    expect(ids(updated)).toEqual([o1, o2, n1, n2]);
    expect(updated.dirty).toBe(false);
    expect((await rebuildState(t.sql, scopeB, deps())).status).toBe("updated");
    const rebuilt = await stateRow(t, scopeB);
    expect(updated.doc).toEqual(rebuilt.doc);
    expect(updated.text).toBe(rebuilt.text);

    // A re-bind landing while an update waits on claude: the update starts over and rebuilds.
    const { client: C, binding: third } = await boundFolder(t, { client: "Gamma", repo: "github.com/gamma/x" });
    const g1 = await addSummary(t, third, { title: "Gamma work", day: 5, facts: ["gamma fact"] });
    const n3 = await addSummary(t, own, { title: "Latest", day: 12, facts: ["new fact three"] });
    let rebound = false;
    const rebinding = async (input: ClaudeInput) => {
      if (!rebound) {
        rebound = true;
        await t.call("PUT", "/v1/bindings", { repo: "github.com/gamma/x", subpath: "", status: "active", clientId: B.id, rebind: true });
      }
      return fakeRun("ok")(input);
    };
    expect((await updateState(t.sql, scopeB, [n3], { run: rebinding, budget: BUDGET })).status).toBe("updated");
    const after = await stateRow(t, scopeB);
    expect(ids(after)).toEqual([o1, o2, n1, n2, g1, n3]);
    expect(after.doc.facts).toContain("gamma fact");
    expect(after.doc.current_status).toBe("Latest: Latest");
    expect(scopeKey(C.id, null)).not.toBe(scopeB);
  } finally { await t.drop(); }
});

test("every state call stays within 60 000 input characters", async () => {
  const t = await authedApp();
  const rec = join(tmpdir(), `cerebro-state-calls-${crypto.randomUUID()}.jsonl`);
  const calls = () => readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l).chars as number);
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    const all: bigint[] = [];
    for (let i = 1; i <= 6; i++) all.push(await addSummary(t, binding, { title: `Big ${i}`, day: i, big: true, sessionId: "s1" }));

    // Maximal state back from every call, maximal summaries in: each call still fits.
    const prompts: string[] = [];
    const maxRun = (fill = "x") => async (input: ClaudeInput) => {
      prompts.push(input.prompt);
      return fakeRun("maxstate", { FAKE_CLAUDE_RECORD: rec, FAKE_CLAUDE_FILL: fill })(input);
    };
    expect((await rebuildState(t.sql, scope, { run: maxRun(), budget: BUDGET })).status).toBe("updated");
    expect(calls().length).toBeGreaterThanOrEqual(6);
    for (const n of calls()) expect(n).toBeLessThanOrEqual(60_000);
    expect(ids(await stateRow(t, scope))).toEqual(all);
    // A summary too big to fit next to the state loses `changes` first, but keeps its title and dates.
    const sent = prompts.slice(1).flatMap((p) => JSON.parse(p.split(/<state-[0-9a-f]{8}>\n/)[1].split(/\n<\/state-/)[0]).new_summaries);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.changes).toBeUndefined();
      expect(s.title).toMatch(/^Big \d$/);
      expect(s.to).toMatch(/^2026-11-0\dT/);
    }

    rmSync(rec);
    const more = await addSummary(t, binding, { title: "Big 7", day: 7, big: true, sessionId: "s1" });
    expect((await updateState(t.sql, scope, [more], { run: maxRun(), budget: BUDGET })).status).toBe("updated");
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toBeLessThanOrEqual(60_000);

    // A state whose JSON doubles when escaped (all quotes) is shortened for the call rather than overflowing it.
    rmSync(rec);
    expect((await rebuildState(t.sql, scope, { run: maxRun('"'), budget: BUDGET })).status).toBe("updated");
    for (const n of calls()) expect(n).toBeLessThanOrEqual(60_000);
    expect(ids(await stateRow(t, scope))).toEqual([...all, more]);
  } finally {
    if (existsSync(rec)) rmSync(rec);
    await t.drop();
  }
});

test("a dirty mark arriving during an update keeps the scope dirty", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const s1 = await addSummary(t, binding, { title: "One", day: 1 });
    expect((await updateState(t.sql, scope, [s1], deps())).status).toBe("updated");
    const s2 = await addSummary(t, binding, { title: "Two", day: 2 });
    let marked = false;
    const marking = async (input: ClaudeInput) => {
      if (!marked) { marked = true; await markScopesDirty(t.sql, [scope]); }
      return fakeRun("ok")(input);
    };
    expect((await updateState(t.sql, scope, [s2], { run: marking, budget: BUDGET })).status).toBe("updated");
    let st = await stateRow(t, scope);
    expect(ids(st)).toEqual([s1, s2]);
    expect(st.dirty).toBe(true);
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    st = await stateRow(t, scope);
    expect(st.dirty).toBe(false);
  } finally { await t.drop(); }
});

test("a session move racing the summary store keeps the summary, in the new scope", async () => {
  const t = await authedApp();
  try {
    const { binding: root } = await boundFolder(t, { client: "Acme" });
    const { client: B, binding: target } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/x" });
    const events = Array.from({ length: 4 }, (_, i) => ev("s1", i + 1, i % 2 ? "assistant" : "user", `message ${i + 1}`));
    await ingest(t, { sessions: [sess("s1", root.id)], events });
    await endSession(t.sql, "s1", new Date().toISOString());
    const job = (await claimSummaryJob(t.sql))!;

    // A move is mid-transaction (session row updated, not committed) when the store reaches the session.
    const conn = await t.sql.reserve();
    let waited = false;
    try {
      await conn.unsafe("begin");
      await conn`update sessions set binding_id = ${target.id} where id = 's1'`;
      const run = summariseJob(t.sql, t.embedder, job, { run: fakeRun("ok"), budget: BUDGET });
      waited = await lockWaitSeen(t);
      await conn.unsafe("commit");
      expect(waited).toBe(true);
      expect((await run).status).toBe("done");
    } finally {
      conn.release();
    }
    const rows = await t.sql`select binding_id, client_id, project_id from summaries where session_id = 's1'`;
    expect(rows).toEqual([{ binding_id: target.id, client_id: B.id, project_id: null }]);
    expect((await stateRow(t, scopeKey(B.id, null))).dirty).toBe(true);
  } finally { await t.drop(); }
});

test("a rebuild too big for the budget shrinks to the newest summaries and leaves room for live work", async () => {
  const t = await authedApp();
  const rec = join(tmpdir(), `cerebro-state-calls-${crypto.randomUUID()}.jsonl`);
  const calls = () => (existsSync(rec) ? readFileSync(rec, "utf8").trim().split("\n").filter(Boolean).length : 0);
  try {
    const SMALL = { share: 1, windowTokens: 200_000 };
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    const all: bigint[] = [];
    for (let i = 0; i < 40; i++) all.push(await addSummary(t, binding, { title: `Big ${i}`, day: 1 + (i >> 1), big: true, sessionId: "s1" }));
    // Tokens reported in proportion to the input, as the real CLI does.
    const run = fakeRun("maxstate", { FAKE_CLAUDE_TOKENS: "input", FAKE_CLAUDE_RECORD: rec });

    const res = await rebuildState(t.sql, scope, { run, budget: SMALL });
    expect(res.status).toBe("updated"); // finished in one go: no deferral part-way through its own spend
    const st = await stateRow(t, scope);
    const used = ids(st);
    expect(used.length).toBeGreaterThan(0);
    expect(used.length).toBeLessThan(40);
    expect(used).toEqual(all.slice(40 - used.length)); // the newest ones
    expect(calls()).toBe(used.length);
    const excluded = sortedIds((await stateRow(t, scope)).excluded_summary_ids);
    expect(excluded).toEqual(all.slice(0, 40 - used.length)); // recorded as deliberately left out
    const spent = (await budgetState(t.sql, SMALL)).used;
    expect(spent).toBeLessThanOrEqual(100_000); // at most half the window

    // The summaries left out are not folded in afterwards, one costly call at a time.
    expect((await updateState(t.sql, scope, [], { run, budget: SMALL })).status).toBe("updated");
    expect(calls()).toBe(used.length);

    // Live work still fits in the same window.
    const live = await addSummary(t, binding, { title: "Live", day: 25, big: true, sessionId: "s1" });
    expect((await updateState(t.sql, scope, [live], { run, budget: SMALL })).status).toBe("updated");
    expect(ids(await stateRow(t, scope))).toContain(live);

    // A rebuild whose estimate exceeds what remains does not start at all.
    await record(t.sql, 150_000, "summary");
    const n = calls();
    expect(await rebuildState(t.sql, scope, { run, budget: SMALL })).toMatchObject({ status: "deferred", reason: "budget" });
    expect(calls()).toBe(n);
  } finally {
    if (existsSync(rec)) rmSync(rec);
    await t.drop();
  }
});

test("adopt and move wait for a re-bind of their target and use its new scope", async () => {
  const t = await authedApp();
  try {
    const { binding: root } = await boundFolder(t, { client: "Acme" });
    const B = await (await t.call("POST", "/v1/clients", { name: "Beta" })).json();
    const C = await (await t.call("POST", "/v1/clients", { name: "Gamma" })).json();
    await ingest(t, {
      sessions: [sess("s1", root.id, { subpath: "apps/web" }), sess("s2", root.id, { subpath: "apps/web" })], events: [],
    });
    const s1 = await addSummary(t, root, { title: "Web one", day: 1, sessionId: "s1" });
    const s2 = await addSummary(t, root, { title: "Web two", day: 2, sessionId: "s2" });
    const web = (await (await t.call("PUT", "/v1/bindings", {
      repo: root.repo, subpath: "apps/web", status: "active", clientId: B.id,
    })).json()).binding;

    /** Runs `op` while a re-bind of `web` to `clientId` is mid-transaction, committing it once `op` waits. */
    const duringRebind = async <T>(clientId: string, op: () => Promise<T>): Promise<T> => {
      const conn = await t.sql.reserve();
      try {
        await conn.unsafe("begin");
        await conn`update bindings set client_id = ${clientId}, project_id = null, updated_at = now() where id = ${web.id}`;
        const pending = op();
        expect(await lockWaitSeen(t)).toBe(true);
        await conn.unsafe("commit");
        return await pending;
      } finally {
        conn.release();
      }
    };
    const scopeOf = async (id: bigint) =>
      (await t.sql`select client_id, project_id from summaries where id = ${id}`)[0];

    // The adopt was asked for while `web` belonged to Beta, but the re-bind to Gamma lands first.
    // (Only s1 lies under apps/web's adopt rule here; s2 is moved explicitly below.)
    await t.sql`update sessions set subpath = 'other' where id = 's2'`;
    expect(await duringRebind(C.id, () => adoptSessions(t.sql, web.id))).toBe(1);
    expect(await scopeOf(s1)).toEqual({ client_id: C.id, project_id: null });
    expect((await stateRow(t, scopeKey(C.id, null))).dirty).toBe(true);

    expect(await duringRebind(B.id, () => moveSession(t.sql, "s2", web.id))).toBe(true);
    expect(await scopeOf(s2)).toEqual({ client_id: B.id, project_id: null });
    expect((await stateRow(t, scopeKey(B.id, null))).dirty).toBe(true);
  } finally { await t.drop(); }
});

test("summaries stored after the state exists are folded in, however old their period", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await addSummary(t, binding, { title: "Recent", day: 20, facts: ["recent fact"] });
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");

    // An imported session from long before anything folded so far, summarised now.
    await ingest(t, { sessions: [sess("imp", binding.id, { startedAt: "2026-10-01T09:00:00.000Z" })], events: [] });
    const imported = await addSummary(t, binding, { title: "Imported", day: 1, sessionId: "imp", facts: ["imported fact"] });
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    let st = await stateRow(t, scope);
    expect(ids(st)).toContain(imported);
    expect(st.doc.facts).toContain("imported fact");
    expect(st.dirty).toBe(false);

    // An initial history covering an even older period, posted by the client.
    const res = await t.call("POST", "/v1/summaries", {
      repo: binding.repo, subpath: "", title: "How it began", text: "Started as a weekend prototype",
      tsFrom: "2026-09-01T00:00:00.000Z", tsTo: "2026-09-30T00:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const history = BigInt((await res.json()).summary.id);
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    st = await stateRow(t, scope);
    expect(ids(st)).toContain(history);
    expect(st.dirty).toBe(false);
  } finally { await t.drop(); }
});

test("re-sending a history period puts its new text in the state", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const post = (text: string) => t.call("POST", "/v1/summaries", {
      repo: binding.repo, subpath: "", title: "History", text,
      tsFrom: "2026-09-01T00:00:00.000Z", tsTo: "2026-09-30T00:00:00.000Z",
    });
    expect((await post("First draft about zebras")).status).toBe(201);
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    expect((await stateRow(t, scope)).text).toContain("zebras");

    expect((await post("Second draft about giraffes")).status).toBe(200); // same period: replaced in place
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    const st = await stateRow(t, scope);
    expect(st.text).toContain("giraffes");
    expect(st.text).not.toContain("zebras");
  } finally { await t.drop(); }
});

test("initial histories always inform a rebuild, however many later summaries there are", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const history = await addSummary(t, binding, { title: "How it began", day: 1, facts: ["Started as a weekend prototype"] });
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    for (let i = 0; i < 45; i++) await addSummary(t, binding, { title: `Later ${i}`, day: 2 + (i % 27), sessionId: "s1" });
    const prompts: string[] = [];
    const spy = async (input: ClaudeInput) => { prompts.push(input.prompt); return fakeRun("ok")(input); };
    expect((await rebuildState(t.sql, scope, { run: spy, budget: BUDGET })).status).toBe("updated");
    expect(prompts.some((p) => p.includes("How it began"))).toBe(true);
    const st = await stateRow(t, scope);
    expect(ids(st)).toContain(history);
    expect(ids(st)).toHaveLength(41); // the newest 40 plus the history
    expect(st.doc.facts).toContain("Started as a weekend prototype");
    expect(sortedIds(st.excluded_summary_ids)).not.toContain(history);
  } finally { await t.drop(); }
});

test("an update folds a history outside the newest 40", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    for (let i = 0; i < 41; i++) await addSummary(t, binding, { title: `Later ${i}`, day: 2 + (i % 27), facts: [`later ${i}`], sessionId: "s1" });
    expect((await rebuildState(t.sql, scope, deps())).status).toBe("updated");
    // Posted afterwards, covering a period older than everything in the window.
    const history = await addSummary(t, binding, { title: "How it began", day: 1, facts: ["Started as a weekend prototype"] });
    expect((await updateState(t.sql, scope, [], deps())).status).toBe("updated");
    const st = await stateRow(t, scope);
    expect(ids(st)).toContain(history);
    expect(st.doc.facts).toContain("Started as a weekend prototype");
    expect(st.dirty).toBe(false);
  } finally { await t.drop(); }
});

test("histories too big for the window keep the seed and the newest, and stay out afterwards", async () => {
  const t = await authedApp();
  const rec = join(tmpdir(), `cerebro-state-calls-${crypto.randomUUID()}.jsonl`);
  const calls = () => (existsSync(rec) ? readFileSync(rec, "utf8").trim().split("\n").filter(Boolean).length : 0);
  try {
    const SMALL = { share: 1, windowTokens: 200_000 };
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    const histories: bigint[] = [];
    for (let i = 0; i < 8; i++) histories.push(await addSummary(t, binding, { title: `History ${i}`, day: 1 + i, big: true }));
    const run = fakeRun("maxstate", { FAKE_CLAUDE_TOKENS: "input", FAKE_CLAUDE_RECORD: rec });

    expect((await rebuildState(t.sql, scope, { run, budget: SMALL })).status).toBe("updated");
    expect((await budgetState(t.sql, SMALL)).used).toBeLessThanOrEqual(100_000); // at most half the window
    const st = await stateRow(t, scope);
    const used = ids(st);
    expect(used[0]).toBe(histories[0]); // the seed
    expect(used.length).toBeGreaterThan(1);
    expect(used.length).toBeLessThan(8);
    expect(used.slice(1)).toEqual(histories.slice(8 - (used.length - 1))); // then the newest
    expect(sortedIds(st.excluded_summary_ids)).toEqual(histories.slice(1, 8 - (used.length - 1)));

    // The histories left out are not folded back in one costly call at a time.
    const n = calls();
    expect((await updateState(t.sql, scope, [], { run, budget: SMALL })).status).toBe("updated");
    expect(calls()).toBe(n);
  } finally {
    if (existsSync(rec)) rmSync(rec);
    await t.drop();
  }
});

test("I2: a state call that reached the model and failed is charged", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await addSummary(t, binding, { title: "One", day: 1, facts: ["fact one"] });
    for (const [mode, reason] of [["notjson", "bad_output"], ["schemafail", "failed"]]) {
      await t.sql`delete from usage_ledger`;
      expect(await rebuildState(t.sql, scope, deps(mode))).toMatchObject({ status: "failed", reason });
      expect(await t.sql`select tokens, kind from usage_ledger`).toEqual([{ tokens: 22, kind: "state" }]);
    }
  } finally { await t.drop(); }
});

test("a state call that times out is charged its estimated spend", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await addSummary(t, binding, { title: "One", day: 1, facts: ["fact one"] });
    const slow = (input: ClaudeInput) => fakeRun("slow")({ ...input, timeoutMs: 200 });
    expect(await rebuildState(t.sql, scope, { run: slow, budget: BUDGET })).toMatchObject({ status: "deferred", reason: "timeout" });
    const rows = await t.sql`select tokens, kind from usage_ledger`;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("state");
    expect(rows[0].tokens).toBeGreaterThan(4000);
  } finally { await t.drop(); }
});

test("a stop signal ends a rebuild between calls without committing", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    const scope = scopeKey(client.id, project.id);
    await ingest(t, { sessions: [sess("s1", binding.id)], events: [] });
    for (let i = 0; i < 15; i++) await addSummary(t, binding, { title: `S${i}`, day: 1 + i, sessionId: "s1" });
    const stop = new AbortController();
    let calls = 0;
    const run = async (input: ClaudeInput) => { calls++; stop.abort(); return fakeRun("ok")(input); };
    expect(await rebuildState(t.sql, scope, { run, budget: BUDGET, signal: stop.signal }))
      .toMatchObject({ status: "deferred", reason: "stopped" });
    expect(calls).toBe(1);
    const st = await stateRow(t, scope);
    expect(ids(st)).toHaveLength(0);
    expect(st.dirty).toBe(true);
  } finally { await t.drop(); }
});
