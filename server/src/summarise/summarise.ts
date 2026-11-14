import type { SQL } from "bun";
import { redactSecrets, storable } from "@cerebro/shared";
import { toVector, type Embedder } from "../embed/embedder";
import { budgetState, canSpend, estimateTokens, record } from "./budget";
import type { runClaude } from "./claude";
import { completeSummaryJob, failSummaryJob, releaseSummaryJob } from "./jobs";
import { SUMMARY_SCHEMA, summaryRequest } from "./prompts";
import { renderRange, type EventRow } from "./render";
import { markScopesDirty, scopeKey } from "./state";

const MAX_EVENTS = 2000;
const EMBED_TIMEOUT_MS = 30_000;
const RETRY_LATER_MS = 30 * 60_000;

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
  /**
   * Stop request (shutdown): checked between pieces. A call that fails once it is set (killed by the
   * caller's shutdown deadline) is not held against the job.
   */
  signal?: AbortSignal;
}

export type SummariseReason =
  | "budget" | "usage_limit" | "login" | "timeout" | "binding" | "bad_output" | "failed" | "stopped";

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
export async function embedSummary(sql: SQL, embedder: Embedder, id: unknown, text: string): Promise<boolean> {
  const ctl = new AbortController();
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
 * Summarises a claimed job's uncovered events (up to `maxEvents`), one model call per rendered piece.
 * Each piece's summary is stored (with the session's current binding scope) before the job is
 * completed, so a crash or a later deferral resumes after the last stored piece.
 *
 * - "done": everything loaded is covered; the job is completed (due again now if the event cap was hit).
 * - "deferred": budget, usage limit, login, an inactive binding or a stop request; no attempt is counted.
 * - "failed": timeout, bad model output or another failure (including a store error); counts towards
 *   dead-lettering. A timed-out (killed) call is charged its estimated tokens.
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

  const maxEvents = deps.maxEvents ?? MAX_EVENTS;
  const events: EventRow[] = await sql`
    select seq, ts, kind, text, tool_name, tool_input, meta from events
    where session_id = ${sessionId} and seq > ${job.coveredSeq}
    order by seq limit ${maxEvents}`;
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
    const run = await deps.run({ ...req, schema: SUMMARY_SCHEMA });
    if (!run.ok) {
      // A killed call reports no usage, but it may have spent: charge its estimate so the budget sees it.
      if (run.kind === "timeout") await record(sql, estimateTokens(req.systemPrompt.length + req.prompt.length), "summary");
      if (deps.signal?.aborted) return stopped();
      const error = `${run.kind}: ${run.message}`;
      const later = run.resetAt ?? new Date(Date.now() + RETRY_LATER_MS);
      if (run.kind === "usage_limit") return defer("usage_limit", error, later);
      if (run.kind === "auth") return defer("login", error, later);
      // A job that keeps timing out must dead-letter like any failing job, not retry forever.
      if (run.kind === "timeout") return fail("timeout", error);
      return fail(run.kind === "bad_output" ? "bad_output" : "failed", error);
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

  const hitCap = events.length >= maxEvents;
  await completeSummaryJob(sql, sessionId, events[events.length - 1].seq, { dueNow: hitCap });
  return result("done");
}
