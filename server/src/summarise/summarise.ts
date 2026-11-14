import type { SQL } from "bun";
import { redactSecrets } from "@cerebro/shared";
import { toVector, type Embedder } from "../embed/embedder";
import { budgetState, canSpend, estimateTokens, record } from "./budget";
import type { runClaude } from "./claude";
import { completeSummaryJob, failSummaryJob } from "./jobs";
import { SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, summaryPrompt } from "./prompts";
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
}

type Props = (typeof SUMMARY_SCHEMA)["properties"];
const LISTS = ["decisions", "changes", "facts", "open_threads", "resolved_threads"] as const;
const LIST_LABELS: Record<(typeof LISTS)[number], string> = {
  decisions: "Decisions", changes: "Changes", facts: "Facts", open_threads: "Open threads", resolved_threads: "Resolved threads",
};

/** Model output is untrusted: redacted first (so a cut never leaves half a secret), then capped. */
const clean = (s: string, max: number) => redactSecrets(s).trim().slice(0, max);

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

/** Best effort: a failure or timeout leaves the summary un-embedded (full-text search still finds it). */
async function embedSummary(sql: SQL, embedder: Embedder, id: unknown, text: string): Promise<void> {
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
    await sql`
      insert into summary_embeddings (summary_id, embedding) values (${id}, ${toVector(vec)}::text::halfvec)
      on conflict (summary_id) do update set embedding = excluded.embedding`;
  } catch {
    // un-embedded; nothing queued
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarises a claimed job's uncovered events (up to 2000), one model call per rendered piece.
 * Each piece's summary is stored (with the session's current binding scope) before the job is
 * completed, so a crash or a later deferral resumes after the last stored piece.
 *
 * - "done": everything loaded is covered; the job is completed.
 * - "deferred": over budget, usage limit, login or timeout; the job waits without losing an attempt.
 * - "failed": bad model output or another failure; counts towards dead-lettering.
 */
export async function summariseJob(
  sql: SQL,
  embedder: Embedder,
  job: { sessionId: string; priority: number; coveredSeq: number },
  deps: SummariseDeps,
): Promise<"done" | "deferred" | "failed"> {
  const { sessionId } = job;
  const events: EventRow[] = await sql`
    select seq, ts, kind, text, tool_name, tool_input, meta from events
    where session_id = ${sessionId} and seq > ${job.coveredSeq}
    order by seq limit ${MAX_EVENTS}`;
  if (!events.length) {
    await completeSummaryJob(sql, sessionId, job.coveredSeq);
    return "done";
  }

  for (const piece of renderRange(events, deps.maxChars)) {
    const state = await budgetState(sql, deps.budget);
    if (!canSpend(state, estimateTokens(piece.text.length))) {
      await failSummaryJob(sql, sessionId, "over budget", {
        retryable: true, dueAt: state.resumesAt ?? new Date(Date.now() + RETRY_LATER_MS),
      });
      return "deferred";
    }

    const run = await deps.run({ systemPrompt: SUMMARY_SYSTEM_PROMPT, prompt: summaryPrompt(piece), schema: SUMMARY_SCHEMA });
    if (!run.ok) {
      const error = `${run.kind}: ${run.message}`;
      if (run.kind === "usage_limit" || run.kind === "auth" || run.kind === "timeout") {
        await failSummaryJob(sql, sessionId, error, { retryable: true, dueAt: run.resetAt ?? new Date(Date.now() + RETRY_LATER_MS) });
        return "deferred";
      }
      await failSummaryJob(sql, sessionId, error, { retryable: false });
      return "failed";
    }
    await record(sql, run.tokens, "summary");

    const body = parseSummary(run.output);
    if (!body) {
      await failSummaryJob(sql, sessionId, "bad_output: model output does not match the summary schema", { retryable: false });
      return "failed";
    }

    const stored = await sql.begin(async (tx) => {
      const [b] = await tx`
        select b.id, b.client_id, b.project_id from sessions s join bindings b on b.id = s.binding_id
        where s.id = ${sessionId} and b.status = 'active'`;
      if (!b) return "inactive" as const;
      const [row] = await tx`
        insert into summaries (session_id, kind, binding_id, client_id, project_id, first_seq, last_seq,
          ts_from, ts_to, title, body, text, model)
        values (${sessionId}, 'session', ${b.id}, ${b.client_id}, ${b.project_id}, ${piece.firstSeq}, ${piece.lastSeq},
          ${piece.tsFrom}, ${piece.tsTo}, ${body.title}, ${JSON.stringify(body)}::text::jsonb, ${bodyText(body)}, ${run.model})
        on conflict (session_id, first_seq, last_seq) do nothing
        returning id`;
      if (row) await markScopesDirty(tx, [scopeKey(b.client_id, b.project_id)]);
      return row?.id ?? null;
    });
    if (stored === "inactive") {
      await failSummaryJob(sql, sessionId, "binding is not active", { retryable: true });
      return "deferred";
    }
    if (stored !== null) await embedSummary(sql, embedder, stored, summaryEmbedText({ title: body.title, body }));
  }

  await completeSummaryJob(sql, sessionId, events[events.length - 1].seq);
  return "done";
}
