import type { SQL } from "bun";
import { storable } from "@cerebro/shared";

const MAX_ATTEMPTS = 5;
const REDUE_HOURS = 2;
const MAX_ERROR_CHARS = 2000;

/**
 * Queues a session for summarising. One job per session: a repeat keeps the lower priority number
 * and the earlier due date. A new job starts from what earlier summaries already cover, so a
 * resumed session only summarises its new events. Dead jobs stay dead.
 */
export async function enqueueSummary(
  sql: SQL, sessionId: string, opts: { priority: 0 | 1; dueAt?: Date },
): Promise<void> {
  // "Now" is the database's clock: claims compare due_at with now(), and the app host's clock may run ahead.
  const dueAt = opts.dueAt?.toISOString() ?? null;
  await sql`
    insert into summary_jobs (session_id, priority, due_at, covered_seq)
    values (${sessionId}, ${opts.priority}, coalesce(${dueAt}::timestamptz, now()),
      (select coalesce(max(last_seq), -1) from summaries where session_id = ${sessionId} and kind = 'session'))
    on conflict (session_id) do update set
      priority = least(summary_jobs.priority, excluded.priority),
      due_at = least(summary_jobs.due_at, excluded.due_at)`;
}

/**
 * Queues sessions whose uncovered user/assistant events number at least `minNewEvents`, or at
 * least 20 with the oldest of them older than `maxAgeHours`. Sessions already queued are skipped.
 * Returns how many were queued.
 */
export async function scheduleGrowingSessions(
  sql: SQL, opts: { minNewEvents?: number; maxAgeHours?: number } = {},
): Promise<number> {
  const minNew = opts.minNewEvents ?? 150, maxAge = opts.maxAgeHours ?? 2;
  const rows = await sql`
    with cov as (
      select s.id, coalesce((select max(last_seq) from summaries m where m.session_id = s.id and m.kind = 'session'), -1) as covered
      from sessions s
      where not exists (select 1 from summary_jobs j where j.session_id = s.id)
    ), unc as (
      select cov.id, count(*) as n, min(e.ts) as oldest
      from cov join events e on e.session_id = cov.id and e.kind in ('user', 'assistant') and e.seq > cov.covered
      group by cov.id
    )
    insert into summary_jobs (session_id, priority, covered_seq)
    select unc.id, case when s.imported then 1 else 0 end, cov.covered
    from unc join cov using (id) join sessions s on s.id = unc.id
    where unc.n >= ${minNew}
       or (unc.n >= 20 and unc.oldest < now() - make_interval(hours => ${maxAge}))
    on conflict (session_id) do nothing
    returning session_id`;
  return rows.length;
}

/** Leases the next ready job (live before imported, then oldest due). Held (declined) bindings are skipped. */
export async function claimSummaryJob(
  sql: SQL, leaseSeconds = 900,
): Promise<{ sessionId: string; priority: number; coveredSeq: number } | null> {
  const rows = await sql`
    update summary_jobs set locked_until = now() + make_interval(secs => ${leaseSeconds}),
      covered_seq = greatest(covered_seq,
        (select coalesce(max(m.last_seq), -1) from summaries m where m.session_id = summary_jobs.session_id and m.kind = 'session'))
    where session_id = (
      select j.session_id from summary_jobs j
      join sessions s on s.id = j.session_id
      join bindings b on b.id = s.binding_id
      where not j.dead and j.due_at <= now() and (j.locked_until is null or j.locked_until < now())
        and b.status = 'active'
      order by j.priority, j.due_at
      limit 1
      for update of j skip locked)
    returning session_id, priority, covered_seq`;
  if (!rows.length) return null;
  const r = rows[0];
  return { sessionId: r.session_id, priority: r.priority, coveredSeq: r.covered_seq };
}

/**
 * Records coverage up to `coveredSeq`. Done (job deleted) when no user/assistant events remain beyond
 * it; else re-dued in 2 h, or at once with `dueNow` (by the database's now(), which claims compare with).
 * The job row is locked first, so an enqueue racing with this either lands before the count (and is seen)
 * or waits and re-creates the job afterwards.
 */
export async function completeSummaryJob(
  sql: SQL, sessionId: string, coveredSeq: number, opts: { dueNow?: boolean } = {},
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select 1 from summary_jobs where session_id = ${sessionId} for update`;
    const [{ n }] = await tx`
      select count(*)::int as n from events where session_id = ${sessionId} and kind in ('user', 'assistant') and seq > ${coveredSeq}`;
    if (n === 0) {
      await tx`delete from summary_jobs where session_id = ${sessionId}`;
      return;
    }
    await tx`
      update summary_jobs set covered_seq = greatest(covered_seq, ${coveredSeq}), attempts = 0, last_error = null,
        locked_until = null,
        due_at = case when ${opts.dueNow ?? false} then now() else now() + make_interval(hours => ${REDUE_HOURS}) end
      where session_id = ${sessionId}`;
  });
}

/**
 * Releases the lease after a failure. Retryable failures (budget, usage limit, login) do not count
 * as attempts (and use `dueAt` when given); the others back off exponentially and dead-letter after five.
 * The message is capped and made storable (it may echo CLI or model output), so recording never throws.
 */
export async function failSummaryJob(
  sql: SQL, sessionId: string, error: string, opts: { retryable: boolean; dueAt?: Date },
): Promise<void> {
  error = storable(error.slice(0, MAX_ERROR_CHARS));
  if (opts.retryable) {
    await sql`
      update summary_jobs set last_error = ${error}, locked_until = null,
        due_at = coalesce(${opts.dueAt?.toISOString() ?? null}::timestamptz, now() + make_interval(mins => least(360, 5 * power(2, attempts))::int))
      where session_id = ${sessionId}`;
    return;
  }
  await sql`
    update summary_jobs set attempts = attempts + 1, last_error = ${error}, locked_until = null,
      dead = attempts + 1 >= ${MAX_ATTEMPTS},
      due_at = now() + make_interval(mins => least(360, 5 * power(2, attempts + 1))::int)
    where session_id = ${sessionId}`;
}
