import type { SQL } from "bun";
import { redactSecrets, storable } from "@cerebro/shared";
import { embedderFor, toVector, type Embedder } from "../embed/embedder";
import { budgetState, canSpend, estimateTokens, record } from "./budget";
import { HEALTH_PROBE, type runClaude } from "./claude";
import { completeSummaryJob, failSummaryJob, releaseSummaryJob } from "./jobs";
import { SUMMARY_CALL_SCHEMA, SUMMARY_SCHEMA, summaryRequest } from "./prompts";
import { renderRange, type EventRow } from "./render";
import { markScopesDirty, scopeKey } from "./state";

const MAX_EVENTS = 2000;
/** Characters of event text a job loads at most (about 2 MB as JS strings); the rest is due at once. */
const MAX_LOAD_CHARS = 1_000_000;
/** Transcript characters per model call by default. */
const MAX_PIECE_CHARS = 60_000;
/** Tool output and input loaded per event: rendering shows 300 characters after collapsing whitespace. */
const TOOL_TEXT_CHARS = 2000;
const EMBED_TIMEOUT_MS = 30_000;
const RETRY_LATER_MS = 30 * 60_000;
/** A job deferred by an outage is due again after this (the loop pauses and probes meanwhile). */
const OUTAGE_RETRY_MS = 5 * 60_000;

export interface SummaryBody {
  title: string;
  period: string;
  overview: string;
  decisions: string[];
  changes: string[];
  facts: string[];
  open_threads: string[];
  resolved_threads: string[];
}

export interface SummariseDeps {
  run: typeof runClaude;
  budget: { share: number; windowTokens: number };
  /** Characters of transcript per model call (default 60 000). */
  maxChars?: number;
  /** Events loaded per job (default 2000); a job stopped at the cap is due again at once. */
  maxEvents?: number;
  /** Characters of event text loaded per job (default 1 000 000); likewise due again at once past it. */
  maxLoadChars?: number;
  /**
   * Stop request (shutdown): checked between pieces. A call that fails once it is set (killed by the
   * caller's shutdown deadline) is not held against the job.
   */
  signal?: AbortSignal;
}

export type SummariseReason =
  | "budget" | "usage_limit" | "login" | "timeout" | "binding" | "bad_output" | "unavailable" | "failed" | "stopped";

export interface SummariseResult {
  status: "done" | "deferred" | "failed";
  /** Why the job was deferred or failed. */
  reason?: SummariseReason;
  /** When a deferred job is due again. */
  until?: Date | null;
  /** From the last successful Claude call, when there was one. */
  credentialExpiresAt?: string | null;
  /** State scope keys marked dirty by summaries stored in this run. */
  scopes: string[];
}

type Props = (typeof SUMMARY_SCHEMA)["properties"];
const LISTS = ["decisions", "changes", "facts", "open_threads", "resolved_threads"] as const;
const LIST_LABELS: Record<(typeof LISTS)[number], string> = {
  decisions: "Decisions", changes: "Changes", facts: "Facts", open_threads: "Open threads", resolved_threads: "Resolved threads",
};

/**
 * Model output is untrusted: redacted first (so a cut never leaves half a secret), then capped, then made
 * storable (no NUL, no unpaired surrogate — including one left by the cut).
 */
const clean = (s: string, max: number) => storable(redactSecrets(s).trim().slice(0, max)).trim();

/**
 * Checks model output against SUMMARY_SCHEMA: every field present with the right type, else null.
 * Over-long strings and lists are cut to the schema's caps; unknown keys are dropped.
 */
export function parseSummary(output: unknown): SummaryBody | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  const p: Props = SUMMARY_SCHEMA.properties;
  for (const k of ["title", "period", "overview"] as const) if (typeof o[k] !== "string") return null;
  for (const k of LISTS) {
    const v = o[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  }
  const title = clean(o.title as string, p.title.maxLength);
  if (!title) return null;
  const body = {
    title,
    period: clean(o.period as string, p.period.maxLength),
    overview: clean(o.overview as string, p.overview.maxLength),
  } as SummaryBody;
  for (const k of LISTS) {
    body[k] = (o[k] as string[])
      .slice(0, p[k].maxItems)
      .map((s) => clean(s, p[k].items.maxLength))
      .filter(Boolean);
  }
  return body;
}

/** Searchable text of a summary (title is indexed separately). */
function bodyText(b: SummaryBody): string {
  const parts = [b.period, b.overview];
  for (const k of LISTS) if (b[k].length) parts.push(`${LIST_LABELS[k]}:\n${b[k].map((s) => `- ${s}`).join("\n")}`);
  return parts.filter(Boolean).join("\n\n");
}

/** The text embedded for a summary: title, overview and facts, one per line. */
export function summaryEmbedText(row: { title: string; body: { overview?: string; facts?: string[] } }): string {
  return [row.title, row.body.overview ?? "", ...(row.body.facts ?? [])].filter(Boolean).join("\n");
}

/**
 * Embeds `text`, the summaryEmbedText of summary `id`, and stores the vector only if the summary still
 * yields that text: a history replaced while its old text was being embedded must not get the old vector.
 * The row is share-locked while checking and writing, so a replacement in flight either commits first
 * (and the check fails) or waits for this write and then deletes the vector itself.
 * Best effort: a failure or timeout leaves the summary un-embedded (full-text search still finds it; the
 * summariser loop retries later). True when the vector was stored.
 */
export async function embedSummary(sql: SQL, embedder: Embedder, id: unknown, text: string, machine?: string | null): Promise<boolean> {
  const ctl = new AbortController();
  if (embedder.forMachine) {
    // On the machine that owns the work (EMBED_MACHINE_URLS): the session's uploader, else the given machine.
    if (machine === undefined) {
      const [row] = await sql`
        select m.name from summaries sm join sessions s on s.id = sm.session_id join machines m on m.id = s.machine_id
        where sm.id = ${id}`.catch(() => []);
      machine = row?.name ?? null;
    }
    embedder = embedderFor(embedder, machine ?? null, { storing: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error("embed timeout"));
      }, EMBED_TIMEOUT_MS);
    });
    const [vec] = await Promise.race([embedder.embed([text], ctl.signal), timeout]);
    return await sql.begin(async (tx) => {
      const [row] = await tx`select title, body from summaries where id = ${id} for share`;
      if (!row || summaryEmbedText(row) !== text) return false;
      await tx`
        insert into summary_embeddings (summary_id, embedding) values (${id}, ${toVector(vec)}::text::halfvec)
        on conflict (summary_id) do update set embedding = excluded.embedding`;
      return true;
    });
  } catch {
    // un-embedded; the loop's sweep retries
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The session's events after `coveredSeq` for summarising, in seq order: at most `maxEvents`, and only as
 * many as start within `maxLoadChars` of loaded text. Values are trimmed in SQL to what rendering can use
 * (messages to one piece, tool output and input to a little over their 300-character previews, `meta` to
 * its isMeta flag), so a session full of multi-MB tool output costs a job a few MB at most.
 * `hitCap` when more events may follow.
 */
export async function loadEvents(
  sql: SQL, sessionId: string, coveredSeq: number,
  opts: { maxEvents?: number; maxChars?: number; maxLoadChars?: number } = {},
): Promise<{ events: EventRow[]; hitCap: boolean }> {
  const maxEvents = opts.maxEvents ?? MAX_EVENTS;
  const maxLoad = opts.maxLoadChars ?? MAX_LOAD_CHARS;
  const rows = await sql`
    select seq, ts, kind, text, tool_name, tool_input_text, meta, before from (
      select *, sum(length(text) + coalesce(length(tool_input_text), 0)) over (order by seq) - length(text)
          - coalesce(length(tool_input_text), 0) as before
      from (
        select seq, ts, kind,
          case when kind in ('user', 'assistant') then left(text, ${opts.maxChars ?? MAX_PIECE_CHARS})
               else left(text, ${TOOL_TEXT_CHARS}) end as text,
          left(tool_name, ${TOOL_TEXT_CHARS}) as tool_name,
          left(tool_input::text, ${TOOL_TEXT_CHARS}) as tool_input_text,
          case when meta->'isMeta' = 'true'::jsonb then '{"isMeta": true}'::jsonb end as meta
        from events
        where session_id = ${sessionId} and seq > ${coveredSeq}
        order by seq limit ${maxEvents}) trimmed) sized
    where before < ${maxLoad}
    order by seq`;
  const events: EventRow[] = rows.map((r: any) => ({
    seq: r.seq, ts: r.ts, kind: r.kind, text: r.text, tool_name: r.tool_name, tool_input: null,
    tool_input_text: r.tool_input_text, meta: r.meta,
  }));
  const last = rows[rows.length - 1];
  const loaded = last ? Number(last.before) + last.text.length + (last.tool_input_text?.length ?? 0) : 0;
  return { events, hitCap: events.length >= maxEvents || loaded >= maxLoad };
}

/**
 * Summarises a claimed job's uncovered events (up to `maxEvents`), one model call per rendered piece.
 * Each piece's summary is stored (with the session's current binding scope) before the job is
 * completed, so a crash or a later deferral resumes after the last stored piece.
 *
 * - "done": everything loaded is covered; the job is completed (due again now if the event cap was hit).
 * - "deferred": budget, usage limit, login, an outage ("unavailable"), an inactive binding or a stop
 *   request; no attempt is counted.
 * - "failed": bad model output, a store error, or a timeout or other CLI failure while the CLI itself
 *   works; counts towards dead-lettering.
 *
 * A call that ran to its timeout (or was killed by a stop) is always charged its estimated tokens.
 *
 * A timeout or CLI failure is followed by a tiny probe call (HEALTH_PROBE): when the probe fails too, it is
 * an outage (network down, API overloaded, CLI missing), not the job's fault, so the job is deferred
 * without an attempt and never dead-letters however long the outage lasts.
 */
export async function summariseJob(
  sql: SQL,
  embedder: Embedder,
  job: { sessionId: string; priority: number; coveredSeq: number },
  deps: SummariseDeps,
): Promise<SummariseResult> {
  const { sessionId } = job;
  const scopes = new Set<string>();
  let credentialExpiresAt: string | null | undefined;
  const result = (status: SummariseResult["status"], extra: Partial<SummariseResult> = {}): SummariseResult => ({
    status,
    ...extra,
    ...(credentialExpiresAt !== undefined ? { credentialExpiresAt } : {}),
    scopes: [...scopes],
  });
  const defer = async (reason: SummariseReason, error: string, until: Date | null) => {
    await failSummaryJob(sql, sessionId, error, { retryable: true, ...(until ? { dueAt: until } : {}) });
    const [j] = await sql`select due_at from summary_jobs where session_id = ${sessionId}`;
    return result("deferred", { reason, until: until ?? j?.due_at ?? null });
  };
  const fail = async (reason: SummariseReason, error: string) => {
    await failSummaryJob(sql, sessionId, error, { retryable: false });
    return result("failed", { reason });
  };
  /** Stopped part-way (shutdown): stored pieces stay; the job is free and due as before, no attempt counted. */
  const stopped = async () => {
    await releaseSummaryJob(sql, sessionId);
    return result("deferred", { reason: "stopped", until: null });
  };
  const bindingActive = async () =>
    (await sql`
      select 1 from sessions s join bindings b on b.id = s.binding_id
      where s.id = ${sessionId} and b.status = 'active'`).length > 0;

  const { events, hitCap } = await loadEvents(sql, sessionId, job.coveredSeq, deps);
  if (!events.length) {
    await completeSummaryJob(sql, sessionId, job.coveredSeq);
    return result("done");
  }

  for (const piece of renderRange(events, deps.maxChars)) {
    if (deps.signal?.aborted) return stopped();
    // Checked before every call, so nothing is spent on a folder that was declined meanwhile.
    if (!(await bindingActive())) return defer("binding", "binding is not active", null);

    const state = await budgetState(sql, deps.budget);
    if (!canSpend(state, estimateTokens(piece.text.length))) {
      return defer("budget", "over budget", state.resumesAt ?? new Date(Date.now() + RETRY_LATER_MS));
    }

    const req = summaryRequest(piece);
    const run = await deps.run({ ...req, schema: SUMMARY_CALL_SCHEMA });
    if (!run.ok) {
      // A call killed at our timeout (or by a stop) reports no usage, but its input was very likely processed
      // and billed: charge its estimate so the budget sees it, whatever the probe below says. The probe decides
      // only whether the job is to blame (an attempt) or an outage pauses the loop. Over-charging only delays
      // work; under-charging would let a slow API spend the subscription unrecorded (N1). A call that reached
      // the model and then failed (bad output, an error envelope) is charged what it reported or an estimate,
      // so a failure on every call cannot spend the subscription unrecorded either (I2).
      const spent = run.kind === "timeout" ? estimateTokens(req.systemPrompt.length + req.prompt.length) : run.tokens ?? 0;
      if (spent > 0) await record(sql, spent, "summary");
      if (deps.signal?.aborted) return stopped();
      const error = `${run.kind}: ${run.message}`;
      const later = run.resetAt ?? new Date(Date.now() + RETRY_LATER_MS);
      if (run.kind === "usage_limit") return defer("usage_limit", error, later);
      if (run.kind === "auth") return defer("login", error, later);
      if (run.kind === "bad_output") return fail("bad_output", error);
      // Timeout, outage or unknown failure: does the CLI answer a known-good call right now?
      const health = await deps.run(HEALTH_PROBE);
      // A probe that times out too means an outage; the probe itself is not charged (nothing answered it).
      if (health.ok) {
        credentialExpiresAt = health.credentialExpiresAt;
        await record(sql, health.tokens, "summary");
      } else if (health.tokens) {
        await record(sql, health.tokens, "summary");
      }
      if (deps.signal?.aborted) return stopped();
      if (health.ok || health.kind === "bad_output") {
        // The CLI works, so this job is to blame: it must dead-letter like any failing job, not retry forever.
        return fail(run.kind === "timeout" ? "timeout" : "failed", error);
      }
      if (health.kind === "usage_limit") return defer("usage_limit", error, health.resetAt ?? later);
      if (health.kind === "auth") return defer("login", error, later);
      // An outage: not the job's fault, so no attempt is counted.
      return defer("unavailable", error, new Date(Date.now() + OUTAGE_RETRY_MS));
    }
    credentialExpiresAt = run.credentialExpiresAt;
    await record(sql, run.tokens, "summary");

    const body = parseSummary(run.output);
    if (!body) return fail("bad_output", "bad_output: model output does not match the summary schema");

    let stored: { id: unknown; scope: string } | "inactive" | null;
    try {
      stored = await sql.begin(async (tx) => {
        // A re-bind, adopt or session move re-scopes existing summaries, so it must not interleave with
        // this insert. Lock the session row first: a move or adopt in flight finishes first, and this then
        // reads the session's new binding (not the old one, which would discard a paid-for summary).
        // Then lock that binding: a re-bind in flight finishes first and this reads its new scope; one
        // starting later waits for this insert and moves the new summary with the rest.
        const [s] = await tx`select binding_id from sessions where id = ${sessionId} for share`;
        const [b] = s
          ? await tx`
              select id, client_id, project_id from bindings where id = ${s.binding_id} and status = 'active' for share`
          : [];
        if (!b) return "inactive" as const;
        const [row] = await tx`
          insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq,
            ts_from, ts_to, title, body, text, model)
          values (${sessionId}, 'session', ${b.id}, ${b.client_id}, ${b.project_id}, ${piece.firstSeq}, ${piece.lastSeq},
            ${piece.tsFrom}, ${piece.tsTo}, ${body.title}, ${JSON.stringify(body)}::text::jsonb, ${bodyText(body)},
            ${storable(run.model)})
          on conflict (session_id, first_seq, last_seq) do nothing
          returning id`;
        if (!row) return null;
        // A stored piece is progress: earlier failures no longer count towards dead-lettering. Otherwise a long
        // session (many pieces per load, attempts reset only when the whole load completes) dies of sporadic
        // failures spread over leases that each moved it forward.
        await tx`update summary_jobs set attempts = 0 where session_id = ${sessionId}`;
        const scope = scopeKey(b.client_id, b.project_id);
        await markScopesDirty(tx, [scope]);
        return { id: row.id, scope };
      });
    } catch (e) {
      // A store that keeps failing must dead-letter, not re-spend tokens on every lease.
      return fail("failed", `store failed: ${(e as Error).message}`.slice(0, 500));
    }
    if (stored === "inactive") return defer("binding", "binding is not active", null);
    if (stored) {
      scopes.add(stored.scope);
      await embedSummary(sql, embedder, stored.id, summaryEmbedText({ title: body.title, body }));
    }
  }

  await completeSummaryJob(sql, sessionId, events[events.length - 1].seq, { dueNow: hitCap });
  return result("done");
}
