import { test, expect } from "bun:test";
import { authedApp, freshDb } from "./helpers";
import { createToken } from "../src/auth";
import { buildServer } from "../src/main";
import { boundFolder, ev, ingest, sess } from "./fixtures";
import { fakeEmbedder } from "../src/embed/fake";
import { EmbedderError, type Embedder } from "../src/embed/embedder";
import { runClaude, type ClaudeInput } from "../src/summarise/claude";
import { record } from "../src/summarise/budget";
import { markScopesDirty, scopeKey } from "../src/summarise/state";
import { newSummariserState, startSummariser, type SummariserConfig } from "../src/summarise/loop";

const FAKE = "bun server/test/fakes/fake-claude.ts";
const CFG: SummariserConfig = { enabled: true, share: 0.2, windowTokens: 2_000_000, cmd: FAKE };
const BUDGET = { share: CFG.share, windowTokens: CFG.windowTokens };

/** A fake CLI whose mode can change mid-test; records every call's prompt. */
function fakeCli(mode = "ok", extra: Record<string, string> = {}) {
  const cli = {
    mode,
    calls: [] as ClaudeInput[],
    run: (input: ClaudeInput) => {
      cli.calls.push(input);
      return runClaude(input, { ...process.env, SUMMARISER_CMD: FAKE, FAKE_CLAUDE_MODE: cli.mode, ...extra } as NodeJS.ProcessEnv);
    },
  };
  return cli;
}

/** An injectable clock starting at the real time. */
function clock() {
  let t = Date.now();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

const MIN = 60_000;
const quiet = () => {};

/** A loop-ready app: /v1/status reports the summariser through `state`. */
async function setup(cfg: SummariserConfig = CFG, opts: { embedder?: Embedder } = {}) {
  const state = newSummariserState(cfg.enabled);
  const t = await authedApp({ embedder: opts.embedder, deps: { summariser: { state, budget: { share: cfg.share, windowTokens: cfg.windowTokens } } } });
  return { t, state };
}

/** Ingests a session of `n` messages (each mentioning `word`) and ends it over HTTP. */
async function endedSession(t: any, bindingId: string, id: string, word: string, opts: { imported?: boolean; n?: number } = {}) {
  const n = opts.n ?? 4;
  const events = Array.from({ length: n }, (_, i) =>
    ev(id, i + 1, i % 2 ? "assistant" : "user", i % 2 ? `Done ${word} step ${i + 1}` : `Please do ${word} step ${i + 1}`));
  await ingest(t, { sessions: [sess(id, bindingId, opts.imported ? { imported: true } : {})], events });
  const res = await t.call("POST", `/v1/sessions/${id}/end`, { endedAt: new Date().toISOString() });
  expect(res.status).toBe(200);
}

const status = async (t: any) => (await (await t.call("GET", "/v1/status")).json()).summariser;
/** Calls made to summarise a transcript (not to fold a state or probe the login). */
const summaryCalls = (calls: ClaudeInput[]) => calls.filter((c) => "title" in ((c.schema as any).properties ?? {}));

test("end-to-end: ingest → end → summary → state", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { client, project, binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "pelican");
    expect((await status(t)).backlog).toEqual({ live: 1, imported: 0, dead: 0 });

    await loop.tick();

    const [summary] = await t.sql`select id, title, project_id from summaries where session_id = 's1'`;
    expect(summary.project_id).toBe(project.id);
    expect(await t.sql`select 1 from summary_embeddings where summary_id = ${summary.id}`).toHaveLength(1);
    const [st] = await t.sql`select text, dirty, source_summary_ids::text[] as ids from project_states where scope = ${scopeKey(client.id, project.id)}`;
    expect(st.text).toContain("pelican");
    expect(st.dirty).toBe(false);
    expect(st.ids).toEqual([String(summary.id)]);
    expect(await t.sql`select * from summary_jobs`).toHaveLength(0);

    const s = await status(t);
    expect(s).toMatchObject({
      enabled: true, paused: null, lastError: null, credentialExpiresAt: "2030-01-01T00:00:00.000Z",
      backlog: { live: 0, imported: 0, dead: 0 },
      budget: { limit: 400_000, resumesAt: null },
    });
    expect(typeof s.lastRunAt).toBe("string");
    expect(s.budget.used).toBeGreaterThan(0);
    expect(Object.keys(s).sort()).toEqual(
      ["backlog", "budget", "credentialExpiresAt", "enabled", "lastError", "lastRunAt", "paused"]);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("usage limit pauses the loop and live work resumes first after reset", async () => {
  const { t, state } = await setup();
  const c = clock();
  const reset = new Date(Math.ceil((c.now().getTime() + 60 * MIN) / 1000) * 1000);
  const cli = fakeCli("limit", { FAKE_CLAUDE_RESET_EPOCH: String(reset.getTime() / 1000) });
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "old", "archive", { imported: true });

    await loop.tick();
    expect(cli.calls).toHaveLength(1);
    expect(state.paused).toEqual({ reason: "usage_limit", until: reset.toISOString() });
    expect((await status(t)).paused).toEqual({ reason: "usage_limit", until: reset.toISOString() });

    // Live work arriving during the pause waits too: nothing is claimed or spent.
    await endedSession(t, binding.id, "live", "heron");
    c.advance(30 * MIN);
    await loop.tick();
    expect(cli.calls).toHaveLength(1);
    const jobs = await t.sql`select session_id, attempts, dead from summary_jobs order by session_id`;
    expect(jobs).toEqual([
      { session_id: "live", attempts: 0, dead: false }, { session_id: "old", attempts: 0, dead: false },
    ]);
    expect((await status(t)).backlog).toEqual({ live: 1, imported: 1, dead: 0 });

    // After the reset (the database's due dates travel with the clock), live work goes first.
    c.advance(31 * MIN);
    await t.sql`update summary_jobs set due_at = now() - interval '1 second'`;
    cli.mode = "ok";
    await loop.tick();
    expect(state.paused).toBeNull();
    const order = summaryCalls(cli.calls.slice(1)).map((x) => (x.prompt.includes("heron") ? "live" : "old"));
    expect(order).toEqual(["live", "old"]);
    expect(await t.sql`select * from summary_jobs`).toHaveLength(0);
    expect((await t.sql`select session_id from summaries order by session_id`).map((r: any) => r.session_id)).toEqual(["live", "old"]);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("expired login is reported in status and recovers when the probe succeeds", async () => {
  const { t, state } = await setup();
  const c = clock();
  const cli = fakeCli("auth");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");

    await loop.tick();
    expect(cli.calls).toHaveLength(1);
    expect(state.paused).toEqual({ reason: "login", until: null });
    const s = await status(t);
    expect(s.paused.reason).toBe("login");
    expect(s.lastError).toBe("summary: login");
    const [job] = await t.sql`select attempts, dead, locked_until from summary_jobs where session_id = 's1'`;
    expect(job).toEqual({ attempts: 0, dead: false, locked_until: null });

    // Logged in again, but the probe only runs every 15 minutes.
    cli.mode = "ok";
    c.advance(10 * MIN);
    await loop.tick();
    expect(cli.calls).toHaveLength(1);

    c.advance(6 * MIN);
    await loop.tick();
    const probe = cli.calls[1];
    expect(probe.prompt.length).toBeLessThan(100); // a tiny call, no transcript
    expect(state.paused).toBeNull();
    expect(await t.sql`select 1 from summaries where session_id = 's1'`).toHaveLength(1);
    expect(await t.sql`select * from summary_jobs`).toHaveLength(0);
    expect((await status(t)).paused).toBeNull();
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("a login probe that still fails keeps the loop paused", async () => {
  const { t, state } = await setup();
  const c = clock();
  const cli = fakeCli("auth");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");
    await loop.tick();
    c.advance(16 * MIN);
    await loop.tick();
    expect(cli.calls).toHaveLength(2);
    expect(state.paused).toEqual({ reason: "login", until: null });
    expect(await t.sql`select 1 from summaries`).toHaveLength(0);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("an outage pauses the loop as unavailable without dead-lettering, and it resumes when a probe succeeds", async () => {
  const { t, state } = await setup();
  const c = clock();
  const cli = fakeCli("connection");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");
    await endedSession(t, binding.id, "s2", "heron");

    await loop.tick();
    expect(cli.calls).toHaveLength(2); // the summary call, then a probe that fails too
    expect(state.paused?.reason).toBe("unavailable");
    const firstUntil = Date.parse(state.paused!.until!);
    expect(firstUntil).toBeGreaterThan(c.now().getTime());
    const s = await status(t);
    expect(s.paused.reason).toBe("unavailable");
    expect(s.lastError).toBe("summary: unavailable");

    // Paused: nothing runs before `until`.
    await loop.tick();
    expect(cli.calls).toHaveLength(2);

    // A long outage (a day): only a tiny probe now and then, backing off; no job ever charged an attempt.
    let probes = 0;
    let lastGap = 0;
    for (let i = 0; i < 48; i++) {
      c.advance(30 * MIN);
      const before = cli.calls.length;
      await loop.tick();
      for (const call of cli.calls.slice(before)) expect(call.prompt.length).toBeLessThan(100);
      probes += cli.calls.length - before;
      expect(state.paused?.reason).toBe("unavailable");
      lastGap = Date.parse(state.paused!.until!) - c.now().getTime();
    }
    expect(probes).toBeGreaterThan(10);
    expect(probes).toBeLessThanOrEqual(48);
    expect(lastGap).toBeLessThanOrEqual(30 * MIN);
    const jobs = await t.sql`select session_id, attempts, dead from summary_jobs order by session_id`;
    expect(jobs).toEqual([
      { session_id: "s1", attempts: 0, dead: false }, { session_id: "s2", attempts: 0, dead: false },
    ]);
    expect((await status(t)).backlog).toEqual({ live: 2, imported: 0, dead: 0 });

    // Back online: the next probe succeeds and both sessions are summarised.
    cli.mode = "ok";
    c.advance(31 * MIN);
    await loop.tick();
    expect(state.paused).toBeNull();
    expect(await t.sql`select * from summary_jobs`).toHaveLength(0);
    expect((await t.sql`select session_id from summaries order by session_id`).map((r: any) => r.session_id)).toEqual(["s1", "s2"]);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("disabled summariser leaves jobs queued", async () => {
  const cfg = { ...CFG, enabled: false };
  const { t, state } = await setup(cfg);
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, cfg, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");
    await loop.tick();
    expect(cli.calls).toHaveLength(0);
    const [job] = await t.sql`select attempts, locked_until from summary_jobs where session_id = 's1'`;
    expect(job).toEqual({ attempts: 0, locked_until: null });
    const s = await status(t);
    expect(s).toMatchObject({ enabled: false, paused: { reason: "disabled", until: null }, backlog: { live: 1, imported: 0, dead: 0 } });
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("over budget pauses until the window frees up, without claiming", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");
    await record(t.sql, 400_000, "summary");
    await loop.tick();
    expect(cli.calls).toHaveLength(0);
    expect(state.paused?.reason).toBe("budget");
    const [{ at }] = await t.sql`select at from usage_ledger`;
    expect(state.paused?.until).toBe(new Date(at.getTime() + 5 * 3600_000).toISOString());
    const s = await status(t);
    expect(s.budget).toEqual({ used: 400_000, limit: 400_000, resumesAt: state.paused!.until });
    const [job] = await t.sql`select attempts, locked_until from summary_jobs`;
    expect(job).toEqual({ attempts: 0, locked_until: null });
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("errors in status name the failure class, never model or transcript text", async () => {
  const { t, state } = await setup();
  const cli = fakeCli("notjson");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await endedSession(t, binding.id, "s1", "osprey");
    await loop.tick();
    expect(state.lastError).toBe("summary: bad_output");
    expect(state.paused).toBeNull(); // a bad answer does not stop other work
    const [job] = await t.sql`select attempts from summary_jobs`;
    expect(job.attempts).toBe(1);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

/** A history summary in a binding's scope, dirty and not yet in any state. */
async function dirtyScope(t: any, binding: any, title: string) {
  await t.sql`
    insert into summaries (kind, binding_id, client_id, project_id, ts_from, ts_to, title, body, text, model)
    values ('history', ${binding.id}, ${binding.clientId}, ${binding.projectId}, now() - interval '2 days', now() - interval '1 day',
      ${title}, ${JSON.stringify({ title, overview: `About ${title}`, facts: [`${title} fact`] })}::text::jsonb, ${`About ${title}`}, 'client')`;
  const scope = scopeKey(binding.clientId, binding.projectId);
  await markScopesDirty(t.sql, [scope]);
  return scope;
}

test("dirty scopes are rebuilt two per tick, keeping a quarter of the budget for live work", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const scopes: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      const { binding } = await boundFolder(t, { client: `C${name}`, project: name, repo: `github.com/acme/${name}` });
      scopes.push(await dirtyScope(t, binding, name));
    }
    const dirty = async () => (await t.sql`select scope from project_states where dirty`).length;

    await loop.tick();
    expect(cli.calls).toHaveLength(2);
    expect(await dirty()).toBe(1);
    await loop.tick();
    expect(cli.calls).toHaveLength(3);
    expect(await dirty()).toBe(0);

    // With more than three quarters of the window spent, dirty scopes wait; live summaries still run.
    const { binding: b4 } = await boundFolder(t, { client: "CFour", project: "Four", repo: "github.com/acme/four" });
    await dirtyScope(t, b4, "Four");
    const { binding: b5 } = await boundFolder(t, { client: "CFive", project: "Five", repo: "github.com/acme/five" });
    await endedSession(t, b5.id, "live", "heron");
    await record(t.sql, 310_000, "summary");
    const before = cli.calls.length;
    await loop.tick();
    const calls = cli.calls.slice(before);
    expect(summaryCalls(calls)).toHaveLength(1);
    expect(calls.some((x) => x.prompt.includes("Four"))).toBe(false);
    expect(await dirty()).toBe(1);
    expect(state.paused).toBeNull();
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("a scope invalidated by a re-bind is rebuilt before imported jobs, after live ones", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding: imp } = await boundFolder(t, { client: "Importer", project: "Big", repo: "github.com/acme/big" });
    for (let i = 1; i <= 12; i++) await endedSession(t, imp.id, `imp${i}`, `import${i}`, { imported: true });
    const { binding: live } = await boundFolder(t, { client: "Live", project: "Now", repo: "github.com/acme/now" });
    await endedSession(t, live.id, "live1", "heron");
    // A folder bound to client A by mistake, then re-bound to client B: both scopes are invalidated.
    const { client: B } = await boundFolder(t, { client: "Beta", repo: "github.com/beta/home" });
    const mover = (await (await t.call("PUT", "/v1/bindings", {
      repo: "github.com/acme/moving", subpath: "", status: "active", clientId: (await boundFolder(t, { client: "Acme", repo: "github.com/acme/keep" })).client.id,
    })).json()).binding;
    await dirtyScope(t, mover, "Zanzibar");
    await t.call("PUT", "/v1/bindings", { repo: "github.com/acme/moving", subpath: "", status: "active", clientId: B.id, rebind: true });
    const scopeB = scopeKey(B.id, null);
    expect((await t.sql`select dirty from project_states where scope = ${scopeB}`)[0].dirty).toBe(true);

    await loop.tick();
    const kinds = cli.calls.map((c) =>
      c.prompt.includes("Zanzibar") ? "rebuild" : summaryCalls([c]).length ? (c.prompt.includes("heron") ? "live" : "import") : "state");
    const firstImport = kinds.indexOf("import");
    expect(kinds.indexOf("live")).toBe(0);
    expect(kinds.indexOf("rebuild")).toBeGreaterThan(0);
    expect(firstImport).toBeGreaterThan(kinds.indexOf("rebuild"));
    expect((await t.sql`select dirty, text from project_states where scope = ${scopeB}`)[0]).toMatchObject({ dirty: false });
    expect((await t.sql`select text from project_states where scope = ${scopeB}`)[0].text).toContain("Zanzibar");
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("N2: imports stop at three quarters of the share, so dirty rebuilds and live work are never starved by them", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding: imp } = await boundFolder(t, { client: "Importer", project: "Big", repo: "github.com/acme/big" });
    for (let i = 1; i <= 6; i++) await endedSession(t, imp.id, `imp${i}`, `import${i}`, { imported: true });
    const { binding: other } = await boundFolder(t, { client: "Other", project: "Moved", repo: "github.com/acme/moved" });
    const scope = await dirtyScope(t, other, "Zanzibar");
    const kind = (c: ClaudeInput) =>
      c.prompt.includes("Zanzibar") ? "rebuild" : summaryCalls([c]).length ? (c.prompt.includes("heron") ? "live" : "import") : "state";

    // An import has kept spend at 80% of the share (limit 400k; three quarters is 300k).
    await record(t.sql, 320_000, "summary");
    await loop.tick();
    // Imports wait at 75%, without pausing the loop or counting an attempt.
    expect(cli.calls.map(kind)).toEqual([]);
    expect(state.paused).toBeNull();
    expect(await t.sql`select 1 from summary_jobs where attempts > 0 or dead`).toHaveLength(0);
    expect(await t.sql`select 1 from summary_jobs where priority > 0`).toHaveLength(6);
    // Live work still has the last quarter.
    const { binding: live } = await boundFolder(t, { client: "Live", project: "Now", repo: "github.com/acme/now" });
    await endedSession(t, live.id, "live1", "heron");
    await loop.tick();
    expect(cli.calls.map(kind).filter((k) => k !== "state")).toEqual(["live"]);

    // Spend drops below three quarters: the dirty scope's rebuild goes before any import.
    await t.sql`delete from usage_ledger`;
    await record(t.sql, 250_000, "summary");
    await t.sql`update summary_jobs set due_at = now()`;
    const before = cli.calls.length;
    await loop.tick();
    const after = cli.calls.slice(before).map(kind);
    expect(after.indexOf("rebuild")).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("import")).toBeGreaterThan(after.indexOf("rebuild"));
    expect((await t.sql`select dirty from project_states where scope = ${scope}`)[0].dirty).toBe(false);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("an import of many sessions folds its summaries into the state in batches, not one call per summary", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { client: "Importer", project: "Big", repo: "github.com/acme/big" });
    const N = 24;
    for (let i = 1; i <= N; i++) await endedSession(t, binding.id, `imp${i}`, `import${i}`, { imported: true });
    for (let i = 0; i < 10; i++) await loop.tick();
    expect(await t.sql`select 1 from summary_jobs`).toHaveLength(0);
    expect(summaryCalls(cli.calls)).toHaveLength(N);
    const stateCalls = cli.calls.filter((c) => "current_status" in ((c.schema as any).properties ?? {}));
    expect(stateCalls.length).toBeGreaterThan(0);
    expect(stateCalls.length).toBeLessThanOrEqual(5);
    const [st] = await t.sql`select dirty, cardinality(source_summary_ids)::int as n from project_states
      where scope = ${scopeKey(binding.clientId, binding.projectId)}`;
    expect(st).toEqual({ dirty: false, n: N });
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("a scope whose update fails is not retried every tick", async () => {
  const { t, state } = await setup();
  const c = clock();
  const cli = fakeCli("notjson");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await dirtyScope(t, binding, "One");
    await loop.tick();
    expect(cli.calls).toHaveLength(1);
    expect(state.lastError).toBe("state: bad_output");
    await loop.tick();
    expect(cli.calls).toHaveLength(1);
    cli.mode = "ok";
    c.advance(6 * MIN);
    await loop.tick();
    expect(cli.calls).toHaveLength(2);
    expect((await t.sql`select dirty from project_states`)[0].dirty).toBe(false);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("summaries left without an embedding are retried every 10 minutes", async () => {
  let up = false;
  let embedCalls = 0;
  const base = fakeEmbedder();
  const flaky: Embedder = {
    dims: 1024,
    embed: async (texts, signal) => {
      embedCalls++;
      if (!up) throw new EmbedderError("down", { transient: true });
      return base.embed(texts, signal);
    },
  };
  const { t, state } = await setup(CFG, { embedder: flaky });
  const c = clock();
  const cli = fakeCli();
  const loop = startSummariser(t.sql, flaky, CFG, { run: cli.run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    await t.sql`
      insert into summaries (kind, binding_id, client_id, project_id, ts_from, ts_to, title, body, text, model, created_at)
      values ('history', ${binding.id}, ${binding.clientId}, ${binding.projectId}, now() - interval '2 days', now() - interval '1 day',
        'Kingfisher', ${JSON.stringify({ title: "Kingfisher", overview: "About kingfishers", facts: [] })}::text::jsonb,
        'About kingfishers', 'client', now() - interval '5 minutes')`;
    const embedded = async () => (await t.sql`select 1 from summary_embeddings`).length;

    await loop.tick();
    expect(embedCalls).toBe(2); // the summary, then a known-good text: the embedder is down
    expect(await embedded()).toBe(0);
    up = true;
    c.advance(5 * MIN);
    await loop.tick();
    expect(embedCalls).toBe(2);
    c.advance(6 * MIN);
    await loop.tick();
    expect(embedCalls).toBe(3); // not held back: the embedder was to blame, not the summary
    expect(await embedded()).toBe(1);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("stop waits for the job in flight and runs nothing after it", async () => {
  const { t, state } = await setup();
  const cli = fakeCli();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const inFlight = new Promise<void>((r) => { started = r; });
  const run = async (input: ClaudeInput) => {
    started();
    await gate;
    return cli.run(input);
  };
  const { binding } = await boundFolder(t, { project: "Web" });
  await endedSession(t, binding.id, "s1", "osprey");
  await endedSession(t, binding.id, "s2", "plover");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run, state, tickMs: 20, log: quiet });
  try {
    await inFlight;
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    release();
    await stopping;
    const n = cli.calls.length;
    expect(await t.sql`select 1 from summaries`).toHaveLength(1);
    await Bun.sleep(100);
    expect(cli.calls.length).toBe(n);
  } finally {
    release();
    await loop.stop();
    await t.drop();
  }
});

test("stop kills a call still running at the deadline and charges no attempt", async () => {
  const { t, state } = await setup();
  const cli = fakeCli("slow");
  let started!: () => void;
  const inFlight = new Promise<void>((r) => { started = r; });
  const run = (input: ClaudeInput) => { started(); return cli.run(input); };
  const { binding } = await boundFolder(t, { project: "Web" });
  await endedSession(t, binding.id, "s1", "osprey");
  const loop = startSummariser(t.sql, t.embedder, CFG, { run, state, tickMs: 20, stopDeadlineMs: 300, log: quiet });
  try {
    await inFlight;
    const begun = Date.now();
    await loop.stop();
    expect(Date.now() - begun).toBeLessThan(5000);
    const [j] = await t.sql`select attempts, dead from summary_jobs where session_id = 's1'`;
    expect(j).toEqual({ attempts: 0, dead: false });
    expect(await t.sql`select 1 from summaries`).toHaveLength(0);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("a summary that never embeds does not hold back newer ones", async () => {
  const base = fakeEmbedder();
  const picky: Embedder = {
    dims: 1024,
    embed: async (texts, signal) => {
      if (texts.some((x) => x.includes("Poison"))) throw new EmbedderError("rejected");
      return base.embed(texts, signal);
    },
  };
  const { t, state } = await setup(CFG, { embedder: picky });
  const c = clock();
  const loop = startSummariser(t.sql, picky, CFG, { run: fakeCli().run, state, now: c.now, manual: true, log: quiet });
  try {
    const { binding } = await boundFolder(t, { project: "Web" });
    for (const [i, title] of ["Poison", "Kingfisher"].entries()) {
      await t.sql`
        insert into summaries (kind, binding_id, client_id, project_id, ts_from, ts_to, title, body, text, model, created_at)
        values ('history', ${binding.id}, ${binding.clientId}, ${binding.projectId}, now() - interval '2 days' + ${i} * interval '1 hour',
          now() - interval '1 day', ${title}, ${JSON.stringify({ title, overview: `About ${title}`, facts: [] })}::text::jsonb,
          ${`About ${title}`}, 'client', now() - interval '5 minutes')`;
    }
    await loop.tick();
    const embedded = await t.sql`select s.title from summary_embeddings e join summaries s on s.id = e.summary_id`;
    expect(embedded.map((r: any) => r.title)).toEqual(["Kingfisher"]);
  } finally {
    await loop.stop();
    await t.drop();
  }
});

test("the server reports its summariser settings in status", async () => {
  const db = await freshDb();
  const built = await buildServer({
    DATABASE_URL: db.url, EMBED_URL: "http://127.0.0.1:9", SUMMARISER_ENABLED: "false", SUMMARY_SHARE: "0.5",
    SUBSCRIPTION_TOKENS_PER_5H: "1000000",
  });
  const log = console.log;
  console.log = () => {}; // the app's access log
  try {
    const { token } = await createToken(db.sql, "test-mac");
    const res = await built.app.request("/v1/status", { headers: { Authorization: `Bearer ${token}` } });
    expect((await res.json()).summariser).toEqual({
      enabled: false, paused: { reason: "disabled", until: null }, lastRunAt: null, lastError: null, credentialExpiresAt: null,
      backlog: { live: 0, imported: 0, dead: 0 }, budget: { used: 0, limit: 500_000, resumesAt: null },
    });
  } finally {
    console.log = log;
    await built.sql.close();
    await db.drop();
  }
});
