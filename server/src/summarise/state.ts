import type { SQL } from "bun";
import { redactSecrets, storable } from "@cerebro/shared";
import { budgetState, canSpend, estimateTokens, record } from "./budget";
import type { runClaude } from "./claude";
import { STATE_SCHEMA, stateRequest } from "./prompts";

export { STATE_SCHEMA };

/** Summaries a rebuild reads: the scope's newest, folded oldest first. */
const REBUILD_WINDOW = 40;
/** Summaries per model call, and their serialised size per call (one larger summary goes alone). */
const BATCH_SIZE = 10;
const BATCH_CHARS = 40_000;
/** Cap on the rendered markdown `text`. */
const TEXT_MAX = 6000;
/** Allowance per call for the system prompt and the current state, for the up-front rebuild estimate. */
const CALL_OVERHEAD_CHARS = 8000;
const RETRY_LATER_MS = 30 * 60_000;
/** Compare-and-set attempts before giving up on a scope that keeps changing underneath. */
const MAX_ATTEMPTS = 3;

export interface StateDoc {
  overview: string;
  current_status: string;
  decisions: { text: string; date: string }[];
  open_threads: { text: string; since: string }[];
  resolved_recently: { text: string; date: string }[];
  facts: string[];
}

export interface StateDeps {
  run: typeof runClaude;
  budget: { share: number; windowTokens: number };
}

export type StateReason = "budget" | "usage_limit" | "login" | "timeout" | "bad_output" | "failed";

export interface StateResult {
  status: "updated" | "deferred" | "failed";
  /** Why the update was deferred or failed. */
  reason?: StateReason;
  /** When a deferred update can run again. */
  until?: Date | null;
  /** From the last successful Claude call, when there was one. */
  credentialExpiresAt?: string | null;
}

/** The state scope a summary belongs to: its project when it has one, else its client. */
export function scopeKey(clientId: string, projectId: string | null): string {
  return projectId ? `project:${projectId}` : `client:${clientId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Scope {
  key: string;
  projectId: string | null;
  clientId: string | null;
}

function parseScope(key: string): Scope | null {
  const [kind, id] = key.split(":", 2);
  if (!id || !UUID.test(id)) return null;
  if (kind === "project") return { key, projectId: id, clientId: null };
  if (kind === "client") return { key, projectId: null, clientId: id };
  return null;
}

/** Creates each scope's state row when missing; with `dirty`, flags it and counts the mark. */
async function touchRows(sql: SQL, keys: string[], dirty: boolean): Promise<void> {
  const onConflict = dirty
    ? "do update set dirty = true, dirty_gen = project_states.dirty_gen + 1"
    : "do nothing";
  for (const key of new Set(keys)) {
    const sc = parseScope(key);
    if (!sc) continue;
    const owner = sc.projectId
      ? "select p.client_id, p.id from projects p where p.id = $2"
      : "select c.id, null::uuid from clients c where c.id = $2";
    await sql.unsafe(
      `insert into project_states (scope, client_id, project_id, doc, text, dirty, dirty_gen)
       select $1, o.*, '{}'::jsonb, '', $3, $4 from (${owner}) as o
       on conflict (scope) ${onConflict}`,
      [key, sc.projectId ?? sc.clientId, dirty, dirty ? 1 : 0]);
  }
}

/**
 * Flags scopes for a state update, creating an empty state row for a scope that has none yet.
 * Every mark bumps `dirty_gen`, so an update running meanwhile leaves the flag set.
 * Keys naming an unknown client or project are ignored.
 */
export async function markScopesDirty(sql: SQL, keys: string[]): Promise<void> {
  await touchRows(sql, keys, true);
}

const emptyDoc = (): StateDoc => ({
  overview: "", current_status: "", decisions: [], open_threads: [], resolved_recently: [], facts: [],
});

/**
 * Model output is untrusted: redacted first (so a cut never leaves half a secret), then capped, then made
 * storable (no NUL, no unpaired surrogate — including one left by the cut).
 */
const clean = (s: string, max: number) => storable(redactSecrets(s).trim().slice(0, max)).trim();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type P = (typeof STATE_SCHEMA)["properties"];
type DatedKey = "decisions" | "open_threads" | "resolved_recently";
const DATED: { key: DatedKey; date: "date" | "since" }[] = [
  { key: "decisions", date: "date" }, { key: "open_threads", date: "since" }, { key: "resolved_recently", date: "date" },
];

/**
 * Checks model output against STATE_SCHEMA: every field present with the right type, else null.
 * Over-long strings and lists are cut to the schema's caps; unknown keys are dropped.
 */
export function parseState(output: unknown): StateDoc | null {
  if (!isObj(output)) return null;
  const p: P = STATE_SCHEMA.properties;
  if (typeof output.overview !== "string" || typeof output.current_status !== "string") return null;
  const facts = output.facts;
  if (!Array.isArray(facts) || facts.some((f) => typeof f !== "string")) return null;
  for (const { key, date } of DATED) {
    const v = output[key];
    if (!Array.isArray(v) || v.some((x) => !isObj(x) || typeof x.text !== "string" || typeof x[date] !== "string")) return null;
  }
  const doc: StateDoc = {
    ...emptyDoc(),
    overview: clean(output.overview, p.overview.maxLength),
    current_status: clean(output.current_status, p.current_status.maxLength),
    facts: (facts as string[]).slice(0, p.facts.maxItems).map((f) => clean(f, p.facts.items.maxLength)).filter(Boolean),
  };
  for (const { key, date } of DATED) {
    const items = p[key].items.properties as Record<string, { maxLength: number }>;
    (doc[key] as Record<string, string>[]) = (output[key] as Record<string, string>[])
      .slice(0, p[key].maxItems)
      .map((x) => ({ text: clean(x.text, items.text.maxLength), [date]: clean(x[date], items[date].maxLength) }))
      .filter((x) => x.text);
  }
  return doc;
}

/** The state as markdown for the session-start brief, at most 6000 characters, cut at a line end. */
export function renderState(doc: StateDoc): string {
  const sections: [string, string[]][] = [
    ["Overview", doc.overview ? [doc.overview] : []],
    ["Current status", doc.current_status ? [doc.current_status] : []],
    ["Open threads", doc.open_threads.map((t) => `- ${t.text}${t.since ? ` (since ${t.since})` : ""}`)],
    ["Decisions", doc.decisions.map((d) => `- ${d.date ? `${d.date}: ` : ""}${d.text}`)],
    ["Resolved recently", doc.resolved_recently.map((d) => `- ${d.date ? `${d.date}: ` : ""}${d.text}`)],
    ["Facts", doc.facts.map((f) => `- ${f}`)],
  ];
  const text = sections
    .filter(([, lines]) => lines.length)
    .map(([h, lines]) => `## ${h}\n${lines.join("\n")}`)
    .join("\n\n");
  if (text.length <= TEXT_MAX) return text;
  const cut = text.slice(0, TEXT_MAX);
  const end = cut.lastIndexOf("\n");
  return storable(end > 0 ? cut.slice(0, end) : cut).trimEnd();
}

interface SummaryRow {
  id: string;
  ts_from: Date;
  ts_to: Date;
  title: string;
  body: unknown;
  text: string;
}

const SUMMARY_LISTS = ["decisions", "changes", "facts", "open_threads", "resolved_threads"] as const;

/** What the model sees of a summary: its dates, title and structured body (or its text when it has none). */
function summaryInput(r: SummaryRow): Record<string, unknown> {
  const b = isObj(r.body) ? r.body : {};
  const out: Record<string, unknown> = {
    from: new Date(r.ts_from).toISOString(), to: new Date(r.ts_to).toISOString(), title: r.title,
  };
  if (typeof b.overview === "string") out.overview = b.overview;
  else out.text = r.text;
  for (const k of SUMMARY_LISTS) {
    const v = b[k];
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
  }
  return out;
}

/** Splits summaries (oldest first) into model calls of ≤ 10 summaries and ≤ 40 000 serialised characters. */
function batches(rows: SummaryRow[]): { rows: SummaryRow[]; inputs: Record<string, unknown>[]; chars: number }[] {
  const out: { rows: SummaryRow[]; inputs: Record<string, unknown>[]; chars: number }[] = [];
  for (const r of rows) {
    const input = summaryInput(r);
    const size = JSON.stringify(input).length;
    const cur = out[out.length - 1];
    if (cur && cur.rows.length < BATCH_SIZE && cur.chars + size <= BATCH_CHARS) {
      cur.rows.push(r);
      cur.inputs.push(input);
      cur.chars += size;
    } else {
      out.push({ rows: [r], inputs: [input], chars: size });
    }
  }
  return out;
}

const SUMMARY_COLS = "id::text as id, ts_from, ts_to, title, body, text";

/** The scope's newest summaries, newest first. */
async function newestSummaries(sql: SQL, sc: Scope, limit: number): Promise<SummaryRow[]> {
  return sc.projectId
    ? sql.unsafe(`select ${SUMMARY_COLS} from summaries where project_id = $1 order by ts_to desc, id desc limit $2`,
      [sc.projectId, limit])
    : sql.unsafe(`select ${SUMMARY_COLS} from summaries where client_id = $1 and project_id is null
       order by ts_to desc, id desc limit $2`, [sc.clientId, limit]);
}

/** Those of `ids` that are summaries in this scope now. */
async function summariesInScope(sql: SQL, sc: Scope, ids: string[]): Promise<SummaryRow[]> {
  if (!ids.length) return [];
  return sc.projectId
    ? sql.unsafe(`select ${SUMMARY_COLS} from summaries where id = any($1::bigint[]) and project_id = $2`,
      [ids, sc.projectId])
    : sql.unsafe(`select ${SUMMARY_COLS} from summaries where id = any($1::bigint[]) and client_id = $2 and project_id is null`,
      [ids, sc.clientId]);
}

interface StateRow {
  version: number;
  dirtyGen: string;
  doc: StateDoc;
  sources: string[];
}

/** The scope's state row (created empty when missing); null when the client or project is unknown. */
async function loadState(sql: SQL, sc: Scope): Promise<StateRow | null> {
  await touchRows(sql, [sc.key], false);
  const [row] = await sql`
    select version, dirty_gen::text as dirty_gen, doc, source_summary_ids::text[] as sources
    from project_states where scope = ${sc.key}`;
  if (!row) return null;
  return { version: row.version, dirtyGen: row.dirty_gen, doc: parseState(row.doc) ?? emptyDoc(), sources: row.sources };
}

const scopeLabel = (sc: Scope) => (sc.projectId ? "this project" : "this client's work outside any project");

interface CallContext {
  credentialExpiresAt?: string | null;
}

const done = (ctx: CallContext, r: StateResult): StateResult =>
  ctx.credentialExpiresAt !== undefined ? { ...r, credentialExpiresAt: ctx.credentialExpiresAt } : r;

const overBudget = (resumesAt: Date | null): StateResult => ({
  status: "deferred", reason: "budget", until: resumesAt ?? new Date(Date.now() + RETRY_LATER_MS),
});

/** One model call folding `inputs` into `current`; a StateResult when it could not. */
async function fold(
  sql: SQL, deps: StateDeps, sc: Scope, current: StateDoc, inputs: Record<string, unknown>[], ctx: CallContext,
): Promise<StateDoc | StateResult> {
  const req = stateRequest(current, inputs, scopeLabel(sc));
  const budget = await budgetState(sql, deps.budget);
  if (!canSpend(budget, estimateTokens(req.systemPrompt.length + req.prompt.length))) return overBudget(budget.resumesAt);

  const run = await deps.run({ ...req, schema: STATE_SCHEMA });
  if (!run.ok) {
    const later = run.resetAt ?? new Date(Date.now() + RETRY_LATER_MS);
    if (run.kind === "usage_limit") return { status: "deferred", reason: "usage_limit", until: later };
    if (run.kind === "auth") return { status: "deferred", reason: "login", until: later };
    if (run.kind === "timeout") return { status: "deferred", reason: "timeout", until: later };
    return { status: "failed", reason: run.kind === "bad_output" ? "bad_output" : "failed" };
  }
  ctx.credentialExpiresAt = run.credentialExpiresAt;
  await record(sql, run.tokens, "state");
  return parseState(run.output) ?? { status: "failed", reason: "bad_output" };
}

const isResult = (v: StateDoc | StateResult): v is StateResult => "status" in v;
const failedScope: StateResult = { status: "failed", reason: "failed" };

/**
 * Folds new summaries into a scope's state: the given ids plus any of the scope's newest 40 not yet
 * folded (so a summary whose update was lost is picked up), oldest first, ≤ 10 per model call.
 * Each call's result replaces `doc` and `text`, bumps `version` and appends to `source_summary_ids`,
 * committed only if no other update landed meanwhile (else the update starts over from the new state).
 * `dirty` is cleared when everything is folded and no new mark arrived while it ran.
 *
 * A scope with no state yet, or whose state was built from summaries that have since left it (re-bind,
 * adopt, session move), is rebuilt instead.
 */
export async function updateState(sql: SQL, scope: string, newSummaryIds: bigint[], deps: StateDeps): Promise<StateResult> {
  const sc = parseScope(scope);
  if (!sc) return failedScope;
  const ctx: CallContext = {};
  attempts: for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const st = await loadState(sql, sc);
    if (!st) return failedScope;
    if (!st.sources.length || (await summariesInScope(sql, sc, st.sources)).length < st.sources.length) {
      return rebuildState(sql, scope, deps);
    }
    const folded = new Set(st.sources);
    const pending = new Map<string, SummaryRow>();
    const newest = await newestSummaries(sql, sc, REBUILD_WINDOW);
    const asked = await summariesInScope(sql, sc, newSummaryIds.map(String));
    for (const r of [...newest, ...asked]) if (!folded.has(r.id)) pending.set(r.id, r);
    const rows = [...pending.values()].sort(
      (a, b) => new Date(a.ts_to).getTime() - new Date(b.ts_to).getTime() || Number(BigInt(a.id) - BigInt(b.id)));

    if (!rows.length) {
      await sql`
        update project_states set dirty = false
        where scope = ${sc.key} and version = ${st.version} and dirty_gen = ${st.dirtyGen}::bigint`;
      return done(ctx, { status: "updated" });
    }

    let doc = st.doc;
    let version = st.version;
    const parts = batches(rows);
    for (const [i, part] of parts.entries()) {
      const out = await fold(sql, deps, sc, doc, part.inputs, ctx);
      if (isResult(out)) return done(ctx, out);
      const last = i === parts.length - 1;
      const [u] = await sql`
        update project_states set
          doc = ${JSON.stringify(out)}::text::jsonb, text = ${renderState(out)}, version = version + 1,
          source_summary_ids = source_summary_ids || ${part.rows.map((r) => r.id)}::bigint[],
          dirty = case when ${last} and dirty_gen = ${st.dirtyGen}::bigint then false else dirty end,
          updated_at = now()
        where scope = ${sc.key} and version = ${version}
        returning version`;
      if (!u) continue attempts; // another update landed first: start over from it
      version = u.version;
      doc = out;
    }
    return done(ctx, { status: "updated" });
  }
  return done(ctx, failedScope);
}

/**
 * Rebuilds a scope's state from scratch out of its newest 40 summaries (oldest first, ≤ 10 per call),
 * for a dirty scope or one with no state. Nothing is spent unless the budget covers the whole rebuild.
 * The result is committed only if no update landed meanwhile (else it starts over); `dirty` is cleared
 * only if no new mark arrived while it ran. A scope with no summaries gets an empty state, without a call.
 */
export async function rebuildState(sql: SQL, scope: string, deps: StateDeps): Promise<StateResult> {
  const sc = parseScope(scope);
  if (!sc) return failedScope;
  const ctx: CallContext = {};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const st = await loadState(sql, sc);
    if (!st) return failedScope;
    const rows = (await newestSummaries(sql, sc, REBUILD_WINDOW)).reverse();
    const parts = batches(rows);
    if (parts.length) {
      const budget = await budgetState(sql, deps.budget);
      const estimate = parts.reduce((n, p) => n + estimateTokens(p.chars + CALL_OVERHEAD_CHARS), 0);
      if (!canSpend(budget, estimate)) return done(ctx, overBudget(budget.resumesAt));
    }
    let doc = emptyDoc();
    for (const part of parts) {
      const out = await fold(sql, deps, sc, doc, part.inputs, ctx);
      if (isResult(out)) return done(ctx, out);
      doc = out;
    }
    const [u] = await sql`
      update project_states set
        doc = ${JSON.stringify(doc)}::text::jsonb, text = ${renderState(doc)}, version = version + 1,
        source_summary_ids = ${rows.map((r) => r.id)}::bigint[],
        dirty = dirty and dirty_gen <> ${st.dirtyGen}::bigint,
        updated_at = now()
      where scope = ${sc.key} and version = ${st.version}
      returning version`;
    if (u) return done(ctx, { status: "updated" });
  }
  return done(ctx, failedScope);
}
