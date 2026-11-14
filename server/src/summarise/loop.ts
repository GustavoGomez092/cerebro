import type { SQL } from "bun";
import type { Config } from "../config";
import { pgState } from "../db";
import type { Embedder } from "../embed/embedder";
import { budgetState, estimateTokens, record } from "./budget";
import { HEALTH_PROBE, runClaude, type ClaudeInput } from "./claude";
import { claimSummaryJob, releaseSummaryJob, scheduleGrowingSessions } from "./jobs";
import { updateState, type StateResult } from "./state";
import { embedSummary, summariseJob, summaryEmbedText, type SummariseResult } from "./summarise";

export type SummariserConfig = Config["summariser"];
export type PauseReason = "budget" | "usage_limit" | "login" | "unavailable" | "disabled";

/** What /v1/status reports about the summariser (plus backlog and budget, read from the database). */
export interface SummariserState {
  enabled: boolean;
  paused: null | { reason: PauseReason; until: string | null };
  /** When a job or state update last ran. */
  lastRunAt: string | null;
  /** The last failure as "<where>: <class>" (never model, CLI or transcript text). */
  lastError: string | null;
  credentialExpiresAt: string | null;
}

export const newSummariserState = (enabled: boolean): SummariserState => ({
  enabled,
  paused: enabled ? null : { reason: "disabled", until: null },
  lastRunAt: null,
  lastError: null,
  credentialExpiresAt: null,
});

export interface SummariserDeps {
  /** The CLI runner (default: runClaude with SUMMARISER_CMD from the config). */
  run?: typeof runClaude;
  /** State object to report through (shared with /v1/status). */
  state?: SummariserState;
  /** Clock for pauses, login probes and the embedding sweep (tests move it). */
  now?: () => Date;
  /** Pause between ticks (default 30 s). */
  tickMs?: number;
  /** No timer: ticks run only when `tick()` is called (tests). */
  manual?: boolean;
  /** How long stop() lets a Claude call in flight finish before killing it (default 20 s). */
  stopDeadlineMs?: number;
  log?: (line: string) => void;
}

export interface Summariser {
  state: SummariserState;
  /** Runs one tick now (after the one in progress, if any). */
  tick(): Promise<void>;
  /**
   * Stops ticking: work stops at the next piece or batch; a Claude call still running after the deadline
   * is killed (its job is freed, or its lease expires, and it is redone later).
   */
  stop(): Promise<void>;
}

const TICK_MS = 30_000;
/** A paused-for-login loop retries the login this often, with a tiny call. */
const PROBE_MS = 15 * 60_000;
/** Summaries left without an embedding (embedder down when they were stored) are retried this often. */
const SWEEP_MS = 10 * 60_000;
const SWEEP_BATCH = 8;
/** A summary whose embedding fails is skipped by the sweep for this long (doubling up to a day). */
const SWEEP_BACKOFF_MIN_MS = 60 * 60_000;
const SWEEP_BACKOFF_MAX_MS = 24 * 3600_000;
/** Known-good text: if it fails too, the embedder is down and no summary is to blame. */
const EMBED_CANARY = "cerebro embedder health check";
const STOP_DEADLINE_MS = 20_000;
/** After killing the call in flight, how long stop() waits for the job to record that it stopped. */
const STOP_SETTLE_MS = 2_000;
/** Jobs per tick before dirty scopes get their turn (the next tick then follows at once). */
const JOBS_PER_TICK = 10;
const DIRTY_PER_TICK = 2;
/** Share of the budget window that dirty-scope rebuilds leave for live summaries. */
const LIVE_RESERVE = 0.25;
const SCOPE_BACKOFF_MIN_MS = 5 * 60_000;
const SCOPE_BACKOFF_MAX_MS = 6 * 3600_000;
const RETRY_LATER_MS = 30 * 60_000;
/** An outage pause before the next probe: 2 min, doubling up to 30 min while the probes keep failing. */
const OUTAGE_MIN_MS = 2 * 60_000;
const OUTAGE_MAX_MS = 30 * 60_000;

/**
 * Runs the summariser in the background: every 30 s it queues growing sessions, then claims and
 * summarises jobs one at a time (live before imported), folds each new live summary into its scope's
 * state, and updates up to two dirty scopes (re-binds, histories, imported summaries, batched), which may
 * use at most three quarters of the budget window. Dirty scopes are updated before the first imported
 * job of a tick, so imports never starve them. Single-flight throughout: one Claude call at a time, ever.
 *
 * Pauses (reported in `state.paused`): over budget until the window frees up; a usage limit until the
 * reset the CLI reports; an expired login until a tiny probe call (every 15 min) succeeds; an outage
 * ("unavailable": CLI missing, network down, API overloaded) until a probe succeeds, probing after 2 min,
 * then backing off to every 30 min. Outages never count against a job, so a long one dead-letters
 * nothing. Raw capture and search are never affected. A disabled summariser leaves its jobs queued.
 */
export function startSummariser(sql: SQL, embedder: Embedder, cfg: SummariserConfig, deps: SummariserDeps = {}): Summariser {
  const state = deps.state ?? newSummariserState(cfg.enabled);
  const baseRun = deps.run ?? ((input: ClaudeInput) => runClaude(input, { ...process.env, SUMMARISER_CMD: cfg.cmd }));
  /** Graceful stop: jobs and state updates check it between calls. */
  const stopping = new AbortController();
  /** Hard stop at the deadline: kills the call in flight. */
  const killing = new AbortController();
  const run = (input: ClaudeInput) => baseRun({ ...input, signal: killing.signal });
  const signal = stopping.signal;
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((l: string) => console.log(l));
  const budget = { share: cfg.share, windowTokens: cfg.windowTokens };
  const dirtyBudget = { share: cfg.share * (1 - LIVE_RESERVE), windowTokens: cfg.windowTokens };

  let stopped = false;
  let lastProbeAt = 0;
  let lastSweepAt: number | null = null;
  /** Jobs deferred by a login failure or an outage: due again as soon as a probe succeeds. */
  const probeDeferred = new Set<string>();
  let outageMs = OUTAGE_MIN_MS;
  const scopeBackoff = new Map<string, { until: number; ms: number }>();
  /** Summaries whose embedding failed, skipped by the sweep until `until`. */
  const sweepBackoff = new Map<string, { until: number; ms: number }>();

  const pause = (reason: PauseReason, until: Date | null) => {
    state.paused = { reason, until: until ? until.toISOString() : null };
    if (reason === "login") lastProbeAt = clock().getTime();
    log(JSON.stringify({ level: "info", msg: "summariser paused", reason, until: state.paused.until }));
  };
  /** Pauses for an outage; each consecutive one waits twice as long before the next probe (up to 30 min). */
  const pauseOutage = () => {
    const ms = outageMs;
    outageMs = Math.min(OUTAGE_MAX_MS, outageMs * 2);
    pause("unavailable", new Date(clock().getTime() + ms));
  };
  const resume = () => {
    log(JSON.stringify({ level: "info", msg: "summariser resumed", reason: state.paused?.reason }));
    state.paused = null;
  };
  const noteRun = (r: { credentialExpiresAt?: string | null }) => {
    state.lastRunAt = new Date().toISOString();
    if (r.credentialExpiresAt) state.credentialExpiresAt = r.credentialExpiresAt;
  };

  /**
   * Acts on a job or state result: pauses for budget, usage limit or login (true when it did); records
   * other failures in lastError. Timeouts, bad output and inactive bindings never stop the loop; a stop
   * request ends the pass (true) without an error.
   */
  const handle = (where: "summary" | "state", r: SummariseResult | StateResult): boolean => {
    if (r.status !== "deferred" && r.status !== "failed") return false;
    const reason = r.reason ?? "failed";
    if (reason === "stopped") return true;
    if (reason === "budget") {
      pause("budget", r.until ?? new Date(clock().getTime() + RETRY_LATER_MS));
      return true;
    }
    if (reason === "binding") return false;
    state.lastError = `${where}: ${reason}`;
    if (reason === "usage_limit") {
      pause("usage_limit", r.until ?? new Date(clock().getTime() + RETRY_LATER_MS));
      return true;
    }
    if (reason === "login") {
      pause("login", null);
      return true;
    }
    if (reason === "unavailable") {
      pauseOutage();
      return true;
    }
    return false;
  };

  /**
   * Whether work may run now; lifts a pause whose time has come. A login or outage pause is lifted only
   * after a good probe (a login one every 15 min; an outage one at its `until`, backing off meanwhile).
   */
  const mayRun = async (): Promise<boolean> => {
    const p = state.paused;
    if (!p) return true;
    const now = clock().getTime();
    if (p.reason === "disabled") {
      resume();
      return true;
    }
    if (p.reason === "budget" || p.reason === "usage_limit") {
      if (p.until && now < Date.parse(p.until)) return false;
      resume();
      return true;
    }
    if (p.reason === "login" ? now - lastProbeAt < PROBE_MS : !!p.until && now < Date.parse(p.until)) return false;
    lastProbeAt = now;
    const probe = await run(HEALTH_PROBE);
    // Any answer from the model (even one off-schema) means the CLI and the login work. A probe that times
    // out is not charged: nothing answered it.
    if (!probe.ok && probe.kind !== "bad_output") {
      if (probe.kind === "usage_limit") {
        pause("usage_limit", probe.resetAt ?? new Date(now + RETRY_LATER_MS));
      } else if (probe.kind === "auth") {
        if (p.reason !== "login") pause("login", null);
      } else if (p.reason === "unavailable") {
        pauseOutage();
      } else {
        state.lastError = `probe: ${probe.kind}`;
      }
      return false;
    }
    if (probe.ok) {
      await record(sql, probe.tokens, "summary");
      noteRun(probe);
    }
    outageMs = OUTAGE_MIN_MS;
    resume();
    if (probeDeferred.size) {
      await sql`
        update summary_jobs set due_at = now()
        where session_id = any(${sql.array([...probeDeferred], "text")}) and (locked_until is null or locked_until < now())`;
      probeDeferred.clear();
    }
    return true;
  };

  /**
   * Embeds a few summaries that have no vector yet (stored while the embedder was down). When one fails
   * and a known-good text embeds fine, that summary is to blame: it is skipped for an hour (doubling up to
   * a day), so it never holds back newer ones. When the known-good text fails too, the embedder is down:
   * the sweep ends and everything is retried next time.
   */
  const sweepEmbeddings = async () => {
    const now = clock().getTime();
    if (lastSweepAt !== null && now - lastSweepAt < SWEEP_MS) return;
    lastSweepAt = now;
    const skip = [...sweepBackoff].filter(([, b]) => now < b.until).map(([id]) => id);
    // Older than a minute: a summary stored just now is still being embedded by whoever stored it.
    const rows = await sql`
      select s.id::text as id, s.title, s.body from summaries s
      where not exists (select 1 from summary_embeddings e where e.summary_id = s.id)
        and s.created_at < now() - interval '1 minute'
        and s.id <> all(${skip}::bigint[])
      order by s.id limit ${SWEEP_BATCH}`;
    for (const r of rows) {
      if (stopped) return;
      if (await embedSummary(sql, embedder, r.id, summaryEmbedText(r))) {
        sweepBackoff.delete(r.id);
        continue;
      }
      if (!(await embedder.embed([EMBED_CANARY]).then(() => true, () => false))) return;
      const ms = Math.min(SWEEP_BACKOFF_MAX_MS, Math.max(SWEEP_BACKOFF_MIN_MS, (sweepBackoff.get(r.id)?.ms ?? 0) * 2));
      sweepBackoff.set(r.id, { until: now + ms, ms });
    }
  };

  /**
   * Updates up to two dirty scopes (folding, or rebuilding when needed), each only while the spend stays
   * within three quarters of the window. A scope that fails backs off (5 min, doubling up to 6 h).
   */
  const updateDirtyScopes = async () => {
    // Invalidated scopes (a re-bind or move: no sources) first; they may be serving nothing meanwhile.
    const rows = await sql`
      select scope from project_states where dirty
      order by cardinality(source_summary_ids) = 0 desc, updated_at, scope`;
    let done = 0;
    for (const { scope } of rows) {
      if (done >= DIRTY_PER_TICK || stopped) return;
      const now = clock().getTime();
      const backoff = scopeBackoff.get(scope);
      if (backoff && now < backoff.until) continue;
      if ((await budgetState(sql, dirtyBudget)).remaining <= 0) return;
      done++;
      const r = await updateState(sql, scope, [], { run, budget: dirtyBudget, signal });
      noteRun(r);
      if (r.status === "updated") {
        scopeBackoff.delete(scope);
        continue;
      }
      // Out of the rebuild share: the rest of the window stays for live summaries.
      if (r.reason === "budget") return;
      if (handle("state", r)) return;
      const ms = Math.min(SCOPE_BACKOFF_MAX_MS, Math.max(SCOPE_BACKOFF_MIN_MS, (backoff?.ms ?? 0) * 2));
      scopeBackoff.set(scope, { until: now + ms, ms });
    }
  };

  /** One pass; true when jobs remain that this pass left for the next. */
  const tick = async (): Promise<boolean> => {
    if (!cfg.enabled) {
      state.paused = { reason: "disabled", until: null };
      return false;
    }
    await sweepEmbeddings();
    if (!(await mayRun())) return false;
    await scheduleGrowingSessions(sql);
    let dirtyDone = false;
    for (let n = 0; !stopped; n++) {
      if (n >= JOBS_PER_TICK) {
        await updateDirtyScopes();
        return true;
      }
      const b = await budgetState(sql, budget);
      if (b.resumesAt) {
        pause("budget", b.resumesAt);
        return false;
      }
      const job = await claimSummaryJob(sql);
      if (!job) break;
      // Dirty scopes (a re-bind's rebuild above all) go before imported history, so a long import
      // never starves them: give the job back, update them, then carry on.
      if (job.priority > 0 && !dirtyDone) {
        dirtyDone = true;
        await releaseSummaryJob(sql, job.sessionId);
        await updateDirtyScopes();
        if (state.paused) return false;
        continue;
      }
      const res = await summariseJob(sql, embedder, job, { run, budget, signal });
      noteRun(res);
      if (res.status === "deferred" && (res.reason === "login" || res.reason === "unavailable")) probeDeferred.add(job.sessionId);
      if (res.status === "done") outageMs = OUTAGE_MIN_MS;
      if (handle("summary", res)) return false;
      // Imported history waits for the dirty-scope pass, which folds up to 10 summaries per call:
      // one state call per imported summary would spend a whole window on a single opt-in.
      if (job.priority > 0) continue;
      for (const scope of res.scopes) {
        const r = await updateState(sql, scope, [], { run, budget, signal });
        noteRun(r);
        if (handle("state", r)) return false;
      }
    }
    if (!stopped) await updateDirtyScopes();
    return false;
  };

  let current: Promise<boolean> = Promise.resolve(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runTick = () => {
    current = current.then(() => (stopped ? false : tick())).catch((e) => {
      // Class and SQLSTATE only: error messages can quote stored conversation text.
      const code = pgState(e);
      state.lastError = `loop: ${(e as Error)?.name ?? "Error"}${code ? ` ${code}` : ""}`;
      log(JSON.stringify({ level: "error", msg: "summariser", error: (e as Error)?.name ?? "Error", pg: code }));
      return false;
    });
    return current;
  };
  const schedule = (delay: number) => {
    if (stopped || deps.manual) return;
    timer = setTimeout(async () => schedule((await runTick()) ? 0 : deps.tickMs ?? TICK_MS), delay);
  };
  schedule(0);

  return {
    state,
    async tick() { await runTick(); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      stopping.abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((r) => { deadline = setTimeout(() => r("late"), deps.stopDeadlineMs ?? STOP_DEADLINE_MS); });
      const outcome = await Promise.race([current, late]);
      clearTimeout(deadline);
      if (outcome !== "late") return;
      killing.abort();
      log(JSON.stringify({ level: "info", msg: "summariser stop deadline: call in flight killed" }));
      await Promise.race([current, Bun.sleep(STOP_SETTLE_MS)]);
    },
  };
}
