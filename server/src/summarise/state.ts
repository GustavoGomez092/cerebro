import type { SQL } from "bun";
import { redactSecrets, storable } from "@cerebro/shared";
import { budgetState, canSpend, estimateTokens, record } from "./budget";
import type { runClaude } from "./claude";
import { STATE_SCHEMA, stateRequest } from "./prompts";

export { STATE_SCHEMA };

/** Summaries a rebuild reads: the scope's newest, folded oldest first. */
const REBUILD_WINDOW = 40;
/** Summaries per model call at most. */
const BATCH_SIZE = 10;
/** Model input per call (system prompt + prompt), as for transcripts. */
const MAX_INPUT_CHARS = 60_000;
/** Room always left for summaries in a call; a current state leaving less is shortened for that call. */
const MIN_SUMMARY_ROOM = 8000;
/** The prompt's wording varies a little with the number of summaries. */
const ENVELOPE_SLACK = 64;
/** Cap on the rendered markdown `text`. */
const TEXT_MAX = 6000;
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
  // Sorted, so two transactions marking overlapping scopes lock rows in the same order.
  for (const key of [...new Set(keys)].sort()) {
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

/**
 * For scopes whose set of summaries changed (summaries moved in or out): marks them dirty and empties
 * `source_summary_ids` with a version bump, so the next update rebuilds and one in flight loses its
 * compare-and-set. The old `doc`/`text` stay readable until then.
 */
export async function invalidateStates(sql: SQL, keys: string[]): Promise<void> {
  const sorted = [...new Set(keys)].sort();
  await touchRows(sql, sorted, true);
  if (sorted.length) {
    await sql`
      update project_states set source_summary_ids = '{}', version = version + 1
      where scope = any(${sql.array(sorted, "text")})`;
  }
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

const jsonLength = (v: unknown) => JSON.stringify(v).length;

/**
 * Shortens a summary's input to `room` serialised characters: `changes` goes first, then items from the
 * end of the longest list, then the overview (or text) and the title are cut. The dates are kept.
 */
function fitSummary(input: Record<string, unknown>, room: number): Record<string, unknown> {
  if (jsonLength(input) <= room) return input;
  const out: Record<string, unknown> = { ...input };
  delete out.changes;
  const lists = SUMMARY_LISTS.filter((k) => Array.isArray(out[k]));
  // Sizes tracked arithmetically: removing an item takes its JSON length plus a separating comma.
  const sizes = new Map<string, number[]>();
  const listChars = new Map<string, number>();
  for (const k of lists) {
    const v = [...(out[k] as string[])];
    out[k] = v;
    sizes.set(k, v.map(jsonLength));
    listChars.set(k, jsonLength(v));
  }
  let total = jsonLength(out);
  while (total > room) {
    let longest: string | null = null;
    for (const k of lists) {
      if ((out[k] as string[]).length && (!longest || listChars.get(k)! > listChars.get(longest)!)) longest = k;
    }
    if (!longest) break;
    const v = out[longest] as string[];
    const removed = sizes.get(longest)!.pop()! + (v.length > 1 ? 1 : 0);
    v.pop();
    listChars.set(longest, listChars.get(longest)! - removed);
    total -= removed;
  }
  for (const k of ["overview", "text", "title"]) {
    const over = jsonLength(out) - room;
    if (over <= 0) break;
    const s = out[k];
    if (typeof s === "string") out[k] = storable(s.slice(0, Math.max(0, s.length - over)));
  }
  return out;
}

const requestChars = (req: { systemPrompt: string; prompt: string }) => req.systemPrompt.length + req.prompt.length;

/** Input characters of a call carrying `doc` and no summaries yet. */
const baseChars = (sc: Scope, doc: StateDoc) => requestChars(stateRequest(doc, [], scopeLabel(sc))) + ENVELOPE_SLACK;

/**
 * The current state as sent to the model. Within the schema's caps it always leaves room for summaries,
 * unless its JSON is inflated by escaping; then it is shortened for the call, least important items
 * first (oldest resolved, facts, decisions, open threads), then the overview and status are halved.
 */
function fitState(sc: Scope, doc: StateDoc): StateDoc {
  const limit = MAX_INPUT_CHARS - MIN_SUMMARY_ROOM;
  if (baseChars(sc, doc) <= limit) return doc;
  const d: StateDoc = {
    ...doc, decisions: [...doc.decisions], open_threads: [...doc.open_threads],
    resolved_recently: [...doc.resolved_recently], facts: [...doc.facts],
  };
  const order = ["resolved_recently", "facts", "decisions", "open_threads"] as const;
  while (baseChars(sc, d) > limit) {
    const k = order.find((key) => d[key].length);
    if (k) d[k].shift();
    else if (d.overview || d.current_status) {
      d.overview = storable(d.overview.slice(0, d.overview.length >> 1));
      d.current_status = storable(d.current_status.slice(0, d.current_status.length >> 1));
    } else break;
  }
  return d;
}

/**
 * The next call's summaries from `rows` (oldest first): at most 10, within the room a call whose
 * state-only input is `baseLen` characters leaves under MAX_INPUT_CHARS. A first summary too big to fit
 * alone is shortened (fitSummary), so every call carries at least one.
 */
function nextBatch(baseLen: number, rows: SummaryRow[]): { inputs: Record<string, unknown>[]; chars: number } {
  const room = MAX_INPUT_CHARS - baseLen;
  const inputs: Record<string, unknown>[] = [];
  let chars = 0;
  for (const r of rows) {
    if (inputs.length >= BATCH_SIZE) break;
    let input = summaryInput(r);
    let size = jsonLength(input) + 1;
    if (chars + size > room) {
      if (inputs.length) break;
      input = fitSummary(input, room - 1);
      size = jsonLength(input) + 1;
    }
    inputs.push(input);
    chars += size;
  }
  return { inputs, chars };
}

const fill = (n: number) => "x".repeat(n);
const MAX_DOC: StateDoc = {
  overview: fill(1500),
  current_status: fill(800),
  decisions: Array.from({ length: 30 }, () => ({ text: fill(300), date: fill(40) })),
  open_threads: Array.from({ length: 30 }, () => ({ text: fill(300), since: fill(40) })),
  resolved_recently: Array.from({ length: 15 }, () => ({ text: fill(300), date: fill(40) })),
  facts: Array.from({ length: 40 }, () => fill(300)),
};

/**
 * Tokens a rebuild over `rows` may spend: its calls planned as if every call carried a state at the
 * schema's caps (the most a well-formed state leaves no less room than), each call at its real size.
 */
function rebuildEstimate(sc: Scope, rows: SummaryRow[]): number {
  const base = Math.min(baseChars(sc, MAX_DOC), MAX_INPUT_CHARS - MIN_SUMMARY_ROOM);
  let tokens = 0;
  for (let i = 0; i < rows.length;) {
    const b = nextBatch(base, rows.slice(i));
    tokens += estimateTokens(base + b.chars);
    i += b.inputs.length;
  }
  return tokens;
}

/**
 * The summaries a rebuild uses, oldest first, and their estimated cost: the scope's newest 40, or, when
 * that would cost more than half the budget window, the newest N that fit in half. So a rebuild always
 * finishes within one window and leaves the other half for live summaries. When even the newest one
 * alone costs more than half, it is used on its own.
 */
function rebuildPlan(sc: Scope, newestFirst: SummaryRow[], limit: number): { rows: SummaryRow[]; estimate: number } {
  const half = Math.floor(limit / 2);
  const plan = (n: number) => {
    const rows = newestFirst.slice(0, n).reverse();
    return { rows, estimate: rebuildEstimate(sc, rows) };
  };
  const full = plan(newestFirst.length);
  if (full.estimate <= half || newestFirst.length <= 1) return full;
  let best = plan(1);
  if (best.estimate > half) return best;
  // Cost grows with the number of summaries: the largest N within half the window.
  let lo = 2;
  let hi = newestFirst.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = plan(mid);
    if (p.estimate <= half) {
      best = p;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
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

/** How many of `ids` are summaries in this scope now. */
async function countInScope(sql: SQL, sc: Scope, ids: string[]): Promise<number> {
  const [row] = sc.projectId
    ? await sql.unsafe(`select count(*)::int as n from summaries where id = any($1::bigint[]) and project_id = $2`,
      [ids, sc.projectId])
    : await sql.unsafe(`select count(*)::int as n from summaries where id = any($1::bigint[]) and client_id = $2
       and project_id is null`, [ids, sc.clientId]);
  return row.n;
}

interface StateRow {
  version: number;
  dirtyGen: string;
  doc: StateDoc;
  sources: string[];
  /** Summaries the last rebuild deliberately left out to fit the budget. */
  excluded: string[];
}

/** The scope's state row (created empty when missing); null when the client or project is unknown. */
async function loadState(sql: SQL, sc: Scope): Promise<StateRow | null> {
  await touchRows(sql, [sc.key], false);
  const [row] = await sql`
    select version, dirty_gen::text as dirty_gen, doc, source_summary_ids::text[] as sources,
      excluded_summary_ids::text[] as excluded
    from project_states where scope = ${sc.key}`;
  if (!row) return null;
  return {
    version: row.version, dirtyGen: row.dirty_gen, doc: parseState(row.doc) ?? emptyDoc(),
    sources: row.sources, excluded: row.excluded,
  };
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

interface Folded {
  doc: StateDoc;
  /** How many of the pending summaries this call folded in. */
  count: number;
}

/**
 * One model call folding the next batch of `pending` (oldest first) into `current`, sized to stay within
 * MAX_INPUT_CHARS; a StateResult when it could not.
 */
async function foldNext(
  sql: SQL, deps: StateDeps, sc: Scope, current: StateDoc, pending: SummaryRow[], ctx: CallContext,
): Promise<Folded | StateResult> {
  const shown = fitState(sc, current);
  const batch = nextBatch(baseChars(sc, shown), pending);
  const req = stateRequest(shown, batch.inputs, scopeLabel(sc));
  const budget = await budgetState(sql, deps.budget);
  if (!canSpend(budget, estimateTokens(requestChars(req)))) return overBudget(budget.resumesAt);

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
  const doc = parseState(run.output);
  return doc ? { doc, count: batch.inputs.length } : { status: "failed", reason: "bad_output" };
}

const isResult = (v: Folded | StateResult): v is StateResult => "status" in v;
const failedScope: StateResult = { status: "failed", reason: "failed" };

/**
 * Folds new summaries into a scope's state: the given ids plus any of the scope's newest 40 not yet
 * folded, whatever their period (an imported session or an initial history stored after the state was
 * built; a summary whose update was lost), except those the last rebuild deliberately left out to fit
 * the budget. Oldest first, ≤ 10 and ≤ MAX_INPUT_CHARS per call.
 * Each call's result replaces `doc` and `text`, bumps `version` and appends to `source_summary_ids`,
 * committed only if no other update landed meanwhile (else the update starts over from the new state).
 * `dirty` is cleared when everything is folded and no new mark arrived while it ran.
 *
 * A scope with no state yet, one invalidated because summaries moved in or out (re-bind, adopt, session
 * move: invalidateStates), or whose sources have otherwise left it, is rebuilt instead.
 */
export async function updateState(sql: SQL, scope: string, newSummaryIds: bigint[], deps: StateDeps): Promise<StateResult> {
  const sc = parseScope(scope);
  if (!sc) return failedScope;
  const ctx: CallContext = {};
  attempts: for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const st = await loadState(sql, sc);
    if (!st) return failedScope;
    if (!st.sources.length || (await countInScope(sql, sc, st.sources)) < st.sources.length) {
      return rebuildState(sql, scope, deps);
    }
    const folded = new Set(st.sources);
    const excluded = new Set(st.excluded);
    const pending = new Map<string, SummaryRow>();
    for (const r of await newestSummaries(sql, sc, REBUILD_WINDOW)) {
      if (!folded.has(r.id) && !excluded.has(r.id)) pending.set(r.id, r);
    }
    for (const r of await summariesInScope(sql, sc, newSummaryIds.map(String))) {
      if (!folded.has(r.id)) pending.set(r.id, r);
    }
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
    for (let i = 0; i < rows.length;) {
      const out = await foldNext(sql, deps, sc, doc, rows.slice(i), ctx);
      if (isResult(out)) return done(ctx, out);
      const foldedIds = rows.slice(i, i + out.count).map((r) => r.id);
      i += out.count;
      const last = i >= rows.length;
      const [u] = await sql`
        update project_states set
          doc = ${JSON.stringify(out.doc)}::text::jsonb, text = ${renderState(out.doc)}, version = version + 1,
          source_summary_ids = source_summary_ids || ${foldedIds}::bigint[],
          dirty = case when ${last} and dirty_gen = ${st.dirtyGen}::bigint then false else dirty end,
          updated_at = now()
        where scope = ${sc.key} and version = ${version}
        returning version`;
      if (!u) continue attempts; // another update (or a re-bind's invalidation) landed first: start over
      version = u.version;
      doc = out.doc;
    }
    return done(ctx, { status: "updated" });
  }
  return done(ctx, failedScope);
}

/**
 * Rebuilds a scope's state from scratch out of its newest 40 summaries (oldest first, ≤ 10 and
 * ≤ MAX_INPUT_CHARS per call), for a dirty scope or one with no state. When those would cost more than
 * half the budget window, only the newest that fit in half are used (rebuildPlan); the rest are recorded
 * in `excluded_summary_ids` so later updates do not fold them back in one at a time. Nothing is spent
 * unless the remaining budget covers the whole planned rebuild, so it does not defer part-way through
 * its own spend. The one exception is a single summary costing more than the whole window: that estimate
 * is capped at the limit, so it can still run once the window is clear. Nothing is committed part-way:
 * a rebuild deferred mid-way by a usage limit, login or timeout is redone from scratch later, since a
 * partial state built from the oldest summaries would replace a newer brief. The result is committed
 * only if no update landed meanwhile (else it starts over); `dirty` is cleared only if no new mark
 * arrived while it ran.
 * A scope with no summaries gets an empty state, without a call.
 */
export async function rebuildState(sql: SQL, scope: string, deps: StateDeps): Promise<StateResult> {
  const sc = parseScope(scope);
  if (!sc) return failedScope;
  const ctx: CallContext = {};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const st = await loadState(sql, sc);
    if (!st) return failedScope;
    const newest = await newestSummaries(sql, sc, REBUILD_WINDOW);
    let rows: SummaryRow[] = [];
    if (newest.length) {
      const budget = await budgetState(sql, deps.budget);
      const planned = rebuildPlan(sc, newest, budget.limit);
      rows = planned.rows;
      if (!canSpend(budget, Math.min(planned.estimate, budget.limit))) return done(ctx, overBudget(budget.resumesAt));
    }
    let doc = emptyDoc();
    for (let i = 0; i < rows.length;) {
      const out = await foldNext(sql, deps, sc, doc, rows.slice(i), ctx);
      if (isResult(out)) return done(ctx, out);
      doc = out.doc;
      i += out.count;
    }
    const used = new Set(rows.map((r) => r.id));
    const [u] = await sql`
      update project_states set
        doc = ${JSON.stringify(doc)}::text::jsonb, text = ${renderState(doc)}, version = version + 1,
        source_summary_ids = ${[...used]}::bigint[],
        excluded_summary_ids = ${newest.filter((r) => !used.has(r.id)).map((r) => r.id)}::bigint[],
        dirty = dirty and dirty_gen <> ${st.dirtyGen}::bigint,
        updated_at = now()
      where scope = ${sc.key} and version = ${st.version}
      returning version`;
    if (u) return done(ctx, { status: "updated" });
  }
  return done(ctx, failedScope);
}
