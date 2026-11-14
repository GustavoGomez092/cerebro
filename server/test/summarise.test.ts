import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { endSession } from "../src/ingest";
import { claimSummaryJob } from "../src/summarise/jobs";
import { runClaude, type ClaudeInput } from "../src/summarise/claude";
import { summariseJob, summaryEmbedText } from "../src/summarise/summarise";
import { SUMMARY_SCHEMA } from "../src/summarise/prompts";
import { scopeKey } from "../src/summarise/state";

const FAKE = "bun server/test/fakes/fake-claude.ts";
const fakeRun = (mode: string, extra: Record<string, string> = {}) => (input: ClaudeInput) =>
  runClaude(input, { ...process.env, SUMMARISER_CMD: FAKE, FAKE_CLAUDE_MODE: mode, ...extra } as NodeJS.ProcessEnv);
const BUDGET = { share: 0.2, windowTokens: 2_000_000 };

/** A bound project with one ended session of `n` messages, its job claimed. */
async function endedSession(t: any, n = 6) {
  const { client, project, binding } = await boundFolder(t, { project: "Web" });
  const events = Array.from({ length: n }, (_, i) =>
    ev("s1", i + 1, i % 2 ? "assistant" : "user", i % 2 ? `Done step ${i + 1}` : `Please do step ${i + 1}`));
  events.push(ev("s1", n + 1, "tool_call", "", { toolName: "mcp__cerebro__search", toolInput: { query: "q" } }));
  await ingest(t, { sessions: [sess("s1", binding.id)], events });
  await endSession(t.sql, "s1", new Date().toISOString());
  const job = await claimSummaryJob(t.sql);
  expect(job?.sessionId).toBe("s1");
  return { client, project, binding, job: job! };
}

const reclaim = async (t: any) => {
  await t.sql`update summary_jobs set due_at = now() where session_id = 's1'`;
  return (await claimSummaryJob(t.sql))!;
};

test("SUMMARY_SCHEMA caps every field", () => {
  const p = (SUMMARY_SCHEMA as any).properties;
  expect(p.title.maxLength).toBe(120);
  expect(p.overview.maxLength).toBe(1200);
  expect(p.facts.maxItems).toBe(30);
  expect(p.facts.items.maxLength).toBe(300);
  for (const k of ["decisions", "changes", "open_threads", "resolved_threads"]) {
    expect(p[k].maxItems).toBe(20);
    expect(p[k].items.maxLength).toBe(300);
  }
  expect((SUMMARY_SCHEMA as any).required).toEqual(expect.arrayContaining(["title", "period", "overview", "facts"]));
});

test("summaryEmbedText joins title, overview and facts", () => {
  expect(summaryEmbedText({ title: "T", body: { overview: "O", facts: ["a", "b"] } })).toBe("T\nO\na\nb");
  expect(summaryEmbedText({ title: "T", body: {} })).toBe("T");
});

test("a finished session yields one stored, embedded summary with its scope", async () => {
  const t = await authedApp();
  try {
    const { client, project, binding, job } = await endedSession(t);
    expect(await summariseJob(t.sql, t.embedder, job, { run: fakeRun("ok"), budget: BUDGET })).toBe("done");
    const rows = await t.sql`select * from summaries`;
    expect(rows).toHaveLength(1);
    const [s] = rows;
    expect(s.session_id).toBe("s1");
    expect(s.kind).toBe("session");
    expect(s.binding_id).toBe(binding.id);
    expect(s.client_id).toBe(client.id);
    expect(s.project_id).toBe(project.id);
    expect([s.first_seq, s.last_seq]).toEqual([1, 6]);
    expect(s.title).toBe("Fake summary of 6 messages");
    expect(s.model).toBe("claude-haiku-fake");
    expect(s.body.overview).toContain("Please do step 1");
    expect(s.text).toContain("Please do step 1");
    expect(s.ts_from.toISOString()).toBe(ev("s1", 1, "user", "").ts);
    expect(s.ts_to.toISOString()).toBe(ev("s1", 6, "user", "").ts);
    expect((await t.sql`select count(*)::int as n from summary_embeddings where summary_id = ${s.id}`)[0].n).toBe(1);
    const [fts] = await t.sql`select count(*)::int as n from summaries where tsv @@ to_tsquery('cerebro', 'step')`;
    expect(fts.n).toBe(1);
    expect((await t.sql`select sum(tokens)::int as n, min(kind) as kind from usage_ledger`)[0]).toEqual({ n: 22, kind: "summary" });
    const [st] = await t.sql`select * from project_states where scope = ${scopeKey(client.id, project.id)}`;
    expect(st.dirty).toBe(true);
    expect(st.client_id).toBe(client.id);
    expect(st.project_id).toBe(project.id);
    // the trailing cerebro call was considered covered: the job is done
    expect(await t.sql`select * from summary_jobs`).toHaveLength(0);
  } finally { await t.drop(); }
});

test("an embedder failure keeps the summary, un-embedded", async () => {
  const t = await authedApp();
  try {
    const { job } = await endedSession(t);
    const broken = { dims: 1024, embed: async () => { throw new Error("embedder down"); } };
    expect(await summariseJob(t.sql, broken, job, { run: fakeRun("ok"), budget: BUDGET })).toBe("done");
    expect(await t.sql`select id from summaries`).toHaveLength(1);
    expect(await t.sql`select * from summary_embeddings`).toHaveLength(0);
  } finally { await t.drop(); }
});

test("over budget defers without calling claude", async () => {
  const t = await authedApp();
  try {
    const { job } = await endedSession(t);
    const spentAt = new Date(Date.now() - 3600_000);
    await t.sql`insert into usage_ledger (at, tokens, kind) values (${spentAt.toISOString()}, 5000, 'summary')`;
    let calls = 0;
    const run = async (input: ClaudeInput) => { calls++; return fakeRun("ok")(input); };
    expect(await summariseJob(t.sql, t.embedder, job, { run, budget: { share: 0.2, windowTokens: 10_000 } })).toBe("deferred");
    expect(calls).toBe(0);
    const [j] = await t.sql`select * from summary_jobs where session_id = 's1'`;
    expect(j.attempts).toBe(0);
    expect(j.locked_until).toBeNull();
    expect(Math.abs(j.due_at.getTime() - (spentAt.getTime() + 5 * 3600_000))).toBeLessThan(1000);
    expect(await t.sql`select * from summaries`).toHaveLength(0);
  } finally { await t.drop(); }
});

test("usage limit defers until the reported reset and records no tokens", async () => {
  const t = await authedApp();
  try {
    const { job } = await endedSession(t);
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const run = fakeRun("limit", { FAKE_CLAUDE_RESET_EPOCH: String(reset) });
    expect(await summariseJob(t.sql, t.embedder, job, { run, budget: BUDGET })).toBe("deferred");
    const [j] = await t.sql`select * from summary_jobs where session_id = 's1'`;
    expect(j.due_at.getTime()).toBe(reset * 1000);
    expect(j.attempts).toBe(0);
    expect(j.last_error).toContain("usage");
    expect(await t.sql`select * from usage_ledger`).toHaveLength(0);
    expect(await t.sql`select * from summaries`).toHaveLength(0);

    // a login failure has no reset time: retry in 30 minutes
    const again = await reclaim(t);
    expect(await summariseJob(t.sql, t.embedder, again, { run: fakeRun("auth"), budget: BUDGET })).toBe("deferred");
    const [k] = await t.sql`select * from summary_jobs where session_id = 's1'`;
    expect(k.attempts).toBe(0);
    expect(Math.abs(k.due_at.getTime() - (Date.now() + 30 * 60_000))).toBeLessThan(5000);
  } finally { await t.drop(); }
});

test("garbage output retries then dead-letters, storing nothing", async () => {
  const t = await authedApp();
  try {
    let { job } = await endedSession(t);
    const modes = ["garbage", "missing", "garbage", "notjson", "garbage"];
    for (const [i, mode] of modes.entries()) {
      if (i > 0) job = await reclaim(t);
      expect(await summariseJob(t.sql, t.embedder, job, { run: fakeRun(mode), budget: BUDGET })).toBe("failed");
      const [j] = await t.sql`select attempts, dead from summary_jobs where session_id = 's1'`;
      expect(j.attempts).toBe(i + 1);
    }
    const [j] = await t.sql`select dead, last_error from summary_jobs where session_id = 's1'`;
    expect(j.dead).toBe(true);
    expect(j.last_error).toBeTruthy();
    expect(await t.sql`select * from summaries`).toHaveLength(0);
    expect(await t.sql`select * from project_states`).toHaveLength(0);
  } finally { await t.drop(); }
});

test("secrets and 50 KB fields in model output are redacted and truncated", async () => {
  const t = await authedApp();
  try {
    const { job } = await endedSession(t);
    expect(await summariseJob(t.sql, t.embedder, job, { run: fakeRun("hostile"), budget: BUDGET })).toBe("done");
    const [s] = await t.sql`select * from summaries`;
    expect(s.title.length).toBeLessThanOrEqual(120);
    expect(s.body.title).toBe(s.title);
    expect(s.body.overview.length).toBeLessThanOrEqual(1200);
    expect(s.body.facts).toHaveLength(30);
    for (const f of s.body.facts) expect(f.length).toBeLessThanOrEqual(300);
    expect(s.body.instructions).toBeUndefined();
    const all = JSON.stringify(s.body) + s.title + s.text;
    expect(all).not.toContain("sk-ant-api03");
    expect(all).not.toContain("hunter2secret");
    expect(all).not.toContain("ghp_bbbb");
    expect(all).toContain("[REDACTED:");
    expect(s.text.length).toBeLessThan(20_000);
  } finally { await t.drop(); }
});

test("a long session becomes consecutive summaries, resuming after a deferral", async () => {
  const t = await authedApp();
  try {
    const { job } = await endedSession(t, 6);
    // a tiny piece size forces several pieces; the budget allows one call (estimate <= 4035, spend 1015)
    const opts = { maxChars: 120 };
    const budget = { share: 1, windowTokens: 4040 };
    const run = fakeRun("ok", { FAKE_CLAUDE_CACHE_CREATION: "1000" });
    expect(await summariseJob(t.sql, t.embedder, job, { run, budget, ...opts })).toBe("deferred");
    const first = await t.sql`select first_seq, last_seq from summaries order by first_seq`;
    expect(first).toHaveLength(1);
    // budget restored: the next claim continues after the stored piece
    await t.sql`delete from usage_ledger`;
    const next = await reclaim(t);
    expect(next.coveredSeq).toBe(first[0].last_seq);
    expect(await summariseJob(t.sql, t.embedder, next, { run: fakeRun("ok"), budget: BUDGET, ...opts })).toBe("done");
    const rows = await t.sql`select first_seq, last_seq from summaries order by first_seq`;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].first_seq).toBe(1);
    expect(rows.at(-1).last_seq).toBe(6);
    for (let i = 1; i < rows.length; i++) expect(rows[i].first_seq).toBe(rows[i - 1].last_seq + 1);
  } finally { await t.drop(); }
});
