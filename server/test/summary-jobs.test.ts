import { test, expect } from "bun:test";
import { authedApp } from "./helpers";
import { connect } from "../src/db";
import { boundFolder, ev, sess, ingest } from "./fixtures";
import { endSession } from "../src/ingest";
import {
  enqueueSummary, scheduleGrowingSessions, claimSummaryJob, completeSummaryJob, failSummaryJob, requeueDeadSummaries,
} from "../src/summarise/jobs";

const msgs = (id: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ev(id, from + i, i % 2 ? "assistant" : "user", `m${from + i}`));

test("ending a session queues a live job; imported sessions queue at low priority", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("live", binding.id), sess("imp", binding.id, { imported: true })], events: [] });
    await endSession(t.sql, "live", new Date().toISOString());
    await endSession(t.sql, "imp", new Date().toISOString());
    const rows = await t.sql`select session_id, priority from summary_jobs order by session_id`;
    expect(rows.map((r: any) => [r.session_id, r.priority])).toEqual([["imp", 1], ["live", 0]]);
    // imported sessions are also queued when their events arrive
    await ingest(t, { sessions: [sess("imp2", binding.id, { imported: true })], events: msgs("imp2", 1, 2) });
    const [j] = await t.sql`select priority from summary_jobs where session_id = 'imp2'`;
    expect(j.priority).toBe(1);
  } finally { await t.drop(); }
});

test("enqueue keeps the lower priority and the earlier due date", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("a", binding.id)] });
    const later = new Date(Date.now() + 3600_000), sooner = new Date(Date.now() + 60_000);
    await enqueueSummary(t.sql, "a", { priority: 1, dueAt: later });
    await enqueueSummary(t.sql, "a", { priority: 0, dueAt: sooner });
    await enqueueSummary(t.sql, "a", { priority: 1, dueAt: later });
    const [j] = await t.sql`select priority, due_at from summary_jobs where session_id = 'a'`;
    expect(j.priority).toBe(0);
    expect(Math.abs(j.due_at.getTime() - sooner.getTime())).toBeLessThan(1000);
  } finally { await t.drop(); }
});

test("claim prefers live jobs and never hands one job to two workers", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("imp", binding.id), sess("live1", binding.id), sess("live2", binding.id)] });
    await enqueueSummary(t.sql, "imp", { priority: 1 });
    await enqueueSummary(t.sql, "live1", { priority: 0 });
    await enqueueSummary(t.sql, "live2", { priority: 0 });
    const c1 = connect(t.url, { max: 1 }), c2 = connect(t.url, { max: 1 });
    let a, b;
    try { [a, b] = await Promise.all([claimSummaryJob(c1), claimSummaryJob(c2)]); } finally { await c1.close(); await c2.close(); }
    expect(a && b).toBeTruthy();
    expect(a!.sessionId).not.toBe(b!.sessionId);
    expect(new Set([a!.sessionId, b!.sessionId])).toEqual(new Set(["live1", "live2"]));
    expect((await claimSummaryJob(t.sql))!.sessionId).toBe("imp");
    expect(await claimSummaryJob(t.sql)).toBeNull();
  } finally { await t.drop(); }
});

test("jobs under a declined binding are never claimed", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("a", binding.id)] });
    await enqueueSummary(t.sql, "a", { priority: 0 });
    await t.sql`update bindings set status = 'declined', client_id = null, project_id = null where id = ${binding.id}`;
    expect(await claimSummaryJob(t.sql)).toBeNull();
    await t.sql`update bindings set status = 'active', client_id = ${binding.clientId} where id = ${binding.id}`;
    expect((await claimSummaryJob(t.sql))!.sessionId).toBe("a");
  } finally { await t.drop(); }
});

test("a resumed session gets a follow-up job covering only new events", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)], events: msgs("s", 1, 40) });
    await endSession(t.sql, "s", new Date().toISOString());
    const job = (await claimSummaryJob(t.sql))!;
    expect(job.coveredSeq).toBe(-1);
    // The worker records the summary it wrote, then completes the job.
    await t.sql`insert into summaries (session_id, kind, binding_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
      values ('s', 'session', ${binding.id}, 1, 40, now(), now(), 't', '{}', 'x', 'm')`;
    await completeSummaryJob(t.sql, "s", 40);
    expect(await t.sql`select 1 from summary_jobs where session_id = 's'`).toHaveLength(0);

    await ingest(t, { events: msgs("s", 41, 60).map((e) => ({ ...e, ts: new Date(Date.UTC(2026, 10, 2, 12, 0, e.seq)).toISOString() })) });
    await endSession(t.sql, "s", new Date().toISOString());
    const [j] = await t.sql`select covered_seq from summary_jobs where session_id = 's'`;
    expect(j.covered_seq).toBe(40);
    expect((await claimSummaryJob(t.sql))!.coveredSeq).toBe(40);
  } finally { await t.drop(); }
});

test("completing with uncovered events left re-dues the job in two hours", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)], events: msgs("s", 1, 10) });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    await claimSummaryJob(t.sql);
    await completeSummaryJob(t.sql, "s", 5);
    const [j] = await t.sql`select covered_seq, locked_until, due_at > now() + interval '119 minutes' as later from summary_jobs where session_id = 's'`;
    expect(j.covered_seq).toBe(5);
    expect(j.locked_until).toBeNull();
    expect(j.later).toBe(true);
  } finally { await t.drop(); }
});

test("growing sessions are scheduled by size or age", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    const old = (id: string, n: number) => msgs(id, 1, n).map((e) => ({ ...e, ts: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const fresh = (id: string, n: number) => msgs(id, 1, n).map((e) => ({ ...e, ts: new Date().toISOString() }));
    await ingest(t, {
      sessions: ["big", "oldish", "small", "oldsmall", "toolheavy"].map((id) => sess(id, binding.id)),
      events: [
        ...fresh("big", 150), ...old("oldish", 20), ...fresh("small", 19), ...old("oldsmall", 19),
        ...fresh("toolheavy", 10),
        ...Array.from({ length: 200 }, (_, i) => ev("toolheavy", 100 + i, "tool_call", "")),
      ],
    });
    expect(await scheduleGrowingSessions(t.sql)).toBe(2);
    const rows = await t.sql`select session_id from summary_jobs order by session_id`;
    expect(rows.map((r: any) => r.session_id)).toEqual(["big", "oldish"]);
    expect(await scheduleGrowingSessions(t.sql)).toBe(0);
  } finally { await t.drop(); }
});

test("retryable failures keep attempts at 0; five real failures dead-letter", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)] });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    await claimSummaryJob(t.sql);
    await failSummaryJob(t.sql, "s", "usage limit", { retryable: true });
    let [j] = await t.sql`select attempts, locked_until, dead, last_error, due_at > now() as later from summary_jobs where session_id = 's'`;
    expect([j.attempts, j.locked_until, j.dead, j.last_error, j.later]).toEqual([0, null, false, "usage limit", true]);

    for (let i = 1; i <= 5; i++) {
      await t.sql`update summary_jobs set due_at = now() where session_id = 's'`;
      expect((await claimSummaryJob(t.sql))!.sessionId).toBe("s");
      await failSummaryJob(t.sql, "s", `boom ${i}`, { retryable: false });
      [j] = await t.sql`select attempts, dead from summary_jobs where session_id = 's'`;
      expect(j.attempts).toBe(i);
      expect(j.dead).toBe(i === 5);
    }
    await t.sql`update summary_jobs set due_at = now()`;
    expect(await claimSummaryJob(t.sql)).toBeNull();
  } finally { await t.drop(); }
});

test("scheduling queues imported sessions at low priority", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, {
      sessions: [sess("imp", binding.id, { imported: true }), sess("live", binding.id)],
      events: [...msgs("imp", 1, 150), ...msgs("live", 1, 150)],
    });
    await t.sql`delete from summary_jobs`;
    expect(await scheduleGrowingSessions(t.sql)).toBe(2);
    const rows = await t.sql`select session_id, priority from summary_jobs order by session_id`;
    expect(rows.map((r: any) => [r.session_id, r.priority])).toEqual([["imp", 1], ["live", 0]]);
  } finally { await t.drop(); }
});

test("completing waits for the job lock so a concurrent enqueue's new events are not lost", async () => {
  const t = await authedApp();
  const a = connect(t.url, { max: 1 }), b = connect(t.url, { max: 1 });
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)], events: msgs("s", 1, 10) });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    let done: Promise<void> | undefined;
    await a.begin(async (tx) => {
      await tx`select 1 from summary_jobs where session_id = 's' for update`;
      done = completeSummaryJob(b, "s", 10);
      await Bun.sleep(300);
      await tx`insert into events (session_id, key, seq, ts, kind, text) values ('s', 's:11', 11, now(), 'user', 'late')`;
    });
    await done;
    const rows = await t.sql`select covered_seq from summary_jobs where session_id = 's'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].covered_seq).toBe(10);
  } finally { await a.close(); await b.close(); await t.drop(); }
});

test("claim never reports coverage behind the stored summaries", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)], events: msgs("s", 1, 60) });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    await t.sql`update summary_jobs set covered_seq = -1 where session_id = 's'`;
    await t.sql`insert into summaries (session_id, kind, binding_id, first_seq, last_seq, ts_from, ts_to, title, body, text, model)
      values ('s', 'session', ${binding.id}, 1, 40, now(), now(), 't', '{}', 'x', 'm')`;
    expect((await claimSummaryJob(t.sql))!.coveredSeq).toBe(40);
  } finally { await t.drop(); }
});

test("a retryable failure honours an explicit dueAt", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)] });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    await claimSummaryJob(t.sql);
    const at = new Date(Date.now() + 5 * 3600_000);
    await failSummaryJob(t.sql, "s", "limit", { retryable: true, dueAt: at });
    const [j] = await t.sql`select due_at from summary_jobs where session_id = 's'`;
    expect(Math.abs(j.due_at.getTime() - at.getTime())).toBeLessThan(1000);
  } finally { await t.drop(); }
});

test("ending a session and queueing its job are one transaction", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)] });
    await t.sql`create function fail_job() returns trigger language plpgsql as $$ begin raise exception 'nope'; end $$`;
    await t.sql`create trigger fail_job before insert on summary_jobs for each row execute function fail_job()`;
    await expect(endSession(t.sql, "s", new Date().toISOString())).rejects.toThrow();
    const [s] = await t.sql`select ended_at from sessions where id = 's'`;
    expect(s.ended_at).toBeNull();
  } finally { await t.drop(); }
});

test("failure messages with NUL, lone surrogates or great length are still recorded", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)] });
    await enqueueSummary(t.sql, "s", { priority: 0 });
    await claimSummaryJob(t.sql);
    await failSummaryJob(t.sql, "s", "a\u0000b \uD800 lone", { retryable: false });
    let [j] = await t.sql`select attempts, locked_until, last_error from summary_jobs where session_id = 's'`;
    expect(j.attempts).toBe(1);
    expect(j.locked_until).toBeNull();
    expect(j.last_error).toBe("a\uFFFDb \uFFFD lone");
    await failSummaryJob(t.sql, "s", "x\u0000".repeat(5000), { retryable: true });
    [j] = await t.sql`select last_error from summary_jobs where session_id = 's'`;
    expect(j.last_error.length).toBeLessThanOrEqual(2000);
    expect(j.last_error).not.toContain("\u0000");
  } finally { await t.drop(); }
});

test("a completion can leave the job due now by the database's clock", async () => {
  const t = await authedApp();
  try {
    const { binding } = await boundFolder(t);
    await ingest(t, { sessions: [sess("s", binding.id)], events: msgs("s", 1, 6) });
    await endSession(t.sql, "s", new Date().toISOString());
    const job = await claimSummaryJob(t.sql);
    await completeSummaryJob(t.sql, "s", 3, { dueNow: true });
    const [j] = await t.sql`select covered_seq, locked_until, due_at <= now() as due from summary_jobs where session_id = 's'`;
    expect(job?.sessionId).toBe("s");
    expect(j).toEqual({ covered_seq: 3, locked_until: null, due: true });
    expect((await claimSummaryJob(t.sql))?.sessionId).toBe("s");
  } finally { await t.drop(); }
});

/** Two dead summary jobs (s1, s2) and one live one (s3). */
async function deadJobs(t: any) {
  const { binding } = await boundFolder(t);
  await ingest(t, { sessions: ["s1", "s2", "s3"].map((id) => sess(id, binding.id)) });
  for (const id of ["s1", "s2", "s3"]) await enqueueSummary(t.sql, id, { priority: 0 });
  await t.sql`update summary_jobs set dead = true, attempts = 5, last_error = 'boom', due_at = now() + interval '6 hours'
    where session_id in ('s1', 's2')`;
}

test("requeueDeadSummaries revives dead summary jobs: attempts reset, due now, claimable", async () => {
  const t = await authedApp();
  try {
    await deadJobs(t);
    expect(await requeueDeadSummaries(t.sql)).toBe(2);
    const rows = await t.sql`
      select session_id, dead, attempts, last_error, locked_until, due_at <= now() as due from summary_jobs order by session_id`;
    expect(rows.map((r: any) => [r.session_id, r.dead, r.attempts, r.last_error, r.locked_until, r.due])).toEqual([
      ["s1", false, 0, null, null, true], ["s2", false, 0, null, null, true], ["s3", false, 0, null, null, true],
    ]);
    expect(await requeueDeadSummaries(t.sql)).toBe(0);
  } finally { await t.drop(); }
});

test("cli requeue-dead-summaries revives dead summary jobs; requeue-dead covers chunks and summaries", async () => {
  const t = await authedApp();
  try {
    await deadJobs(t);
    const env = { ...process.env, DATABASE_URL: t.url };
    let p = Bun.spawnSync(["bun", "server/src/cli.ts", "requeue-dead-summaries"], { env });
    expect(p.stdout.toString()).toContain("requeued 2 summary job(s)");
    expect((await t.sql`select count(*)::int as n from summary_jobs where dead`)[0].n).toBe(0);

    await t.sql`update summary_jobs set dead = true, attempts = 5 where session_id = 's1'`;
    p = Bun.spawnSync(["bun", "server/src/cli.ts", "requeue-dead"], { env });
    const out = p.stdout.toString();
    expect(out).toContain("requeued 0 chunk(s)");
    expect(out).toContain("requeued 1 summary job(s)");
    expect((await t.sql`select count(*)::int as n from summary_jobs where dead`)[0].n).toBe(0);
  } finally { await t.drop(); }
});
