# Cerebro Summariser Implementation Plan (plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server distils raw conversations into dated summaries and a running "current state" per project, within a configurable share (default 20%) of the owner's Claude subscription, and the client uses them: the session-start brief shows the project state, recall searches summaries first, and opting a folder in builds an initial project history.

**Architecture:** A summariser loop inside the server process claims summary jobs (created when a session ends, when a long session grows, and for imported history at low priority), renders the session's events into a compact transcript, and runs headless Claude Code (`claude -p --model haiku --output-format json --json-schema …`) logged in with the owner's subscription. Results are stored as `summaries` (searchable by full text and vectors) and folded into one `project_states` document per scope. A token ledger over a rolling 5-hour window enforces the budget; usage-limit and login errors pause the loop without losing work.

**Tech Stack:** Bun/TypeScript server (existing), Postgres + pgvector (existing schema + migration 002), Claude Code CLI 2.1.x in the server image (installed by plan 4), Ollama bge-m3 embedder (existing), client plugin (feat/client-plugin).

**Spec:** `docs/superpowers/specs/2026-11-13-cerebro-design.md` — sections Summaries, Recall inside Claude Code (session-start brief), Catch-up for existing projects (step 2, initial history), project state (Data model), budget (owner decision: ~20%, configurable). Plan-3 items from review: `docs/reviews/2026-11-13/pro-codebase-verdicts.md` (summary provenance; regenerate state on re-bind).

## Global Constraints

- Summaries run on the server with the owner's Claude subscription via headless Claude Code, model alias `haiku`; never an API key. Every `claude` invocation sets `CEREBRO_HEADLESS=1`, `--tools ""`, `--strict-mcp-config`, `--no-session-persistence`, `--output-format json`, and a replacement `--system-prompt` (the default prompt costs ~0.18 USD-equivalent per call — measured).
- Budget: the summariser may use `SUMMARY_SHARE` (default `0.2`) of `SUBSCRIPTION_TOKENS_PER_5H` (owner-set; default `2_000_000`) in any rolling 5-hour window, counting input + output + cache-creation tokens from the CLI's `usage`. Over budget → wait, never drop work. Live sessions before imported history.
- A usage-limit error pauses the loop until the reset time the CLI reports (else 30 min); an auth/login error pauses it and is reported in `/v1/status` (`summariser.paused: { reason: "login", until: null }`); raw capture and search are never affected.
- Summaries and state never mix scopes: a summary belongs to one session (or one initial-history submission) and records its `binding_id`, `client_id`, `project_id` at creation; a re-bind, adopt or session move marks affected scopes dirty and their state is rebuilt from summaries now in scope.
- Model input excludes tool outputs except a 300-char preview, excludes Cerebro's own tool results (`tool_name` starting `mcp__cerebro__`) entirely, and is capped at 60 000 characters per call (longer ranges are split into consecutive summaries).
- Everything the model returns is untrusted text: parsed against a schema, length-capped per field, passed through `redactSecrets`, never executed.
- Every commit message ends with `Claude-Session: https://claude.ai/code/session_01LTKLaRsEuQTEb2o763vgdu`.

## Review Focus

1. **Subscription limit hit mid-backlog** (a big import plus a busy day) → the loop pauses until the reported reset, live sessions resume first, nothing is lost or summarised twice. Test in Task 4 and Task 5.
2. **Login expired on the server** → status says so, jobs wait, and after `claude auth login` everything catches up. Test in Task 3 and Task 7.
3. **Model returns malformed or hostile JSON** (missing fields, 50 KB "title", instructions to call tools, secrets echoed back) → job retried then dead-lettered; nothing unparsed stored; secrets redacted. Test in Task 5.
4. **A folder re-bound to another client after summaries exist** → the old client's state no longer mentions it; the new scope's state is rebuilt. Test in Task 6.
5. **A session resumed after it ended** (more events after `ended_at`) → a follow-up summary covers only the new range; no duplicate summary of the old range. Test in Task 2.

---

## File Structure

```
server/migrations/002_summaries.sql   summaries, summary_embeddings, summary_jobs, project_states, usage_ledger
server/src/summarise/jobs.ts          enqueue/claim/complete jobs; coverage tracking
server/src/summarise/render.ts        events → compact model input (caps, exclusions, splitting)
server/src/summarise/claude.ts        runClaude(): spawn the CLI, parse JSON, classify errors
server/src/summarise/budget.ts        rolling-window token ledger
server/src/summarise/prompts.ts       system prompts + JSON schemas (summary, state)
server/src/summarise/summarise.ts     summariseJob(): render → claude → validate → store → embed
server/src/summarise/state.ts         updateState(), rebuildState(), dirty scopes
server/src/summarise/loop.ts          startSummariser(): budget, priority, pause, status
server/src/http/routes/summaries.ts   GET /v1/state, GET /v1/summaries, POST /v1/summaries (initial history)
server/test/fakes/fake-claude.ts      deterministic stand-in for the CLI (env SUMMARISER_CMD)
client/src/brief.ts, client/src/mcp.ts, plugin/skills/cerebro/SKILL.md   client use of summaries/state
```

---

### Task 1: Schema for summaries, jobs, state and usage

**Files:** Create `server/migrations/002_summaries.sql`, `server/test/summaries-schema.test.ts`.

**Interfaces — Produces (tables):**
- `summaries(id bigserial pk, session_id text null references sessions, kind text check in ('session','history'), binding_id uuid not null references bindings, client_id uuid null, project_id uuid null, first_seq int null, last_seq int null, ts_from timestamptz not null, ts_to timestamptz not null, title text not null, body jsonb not null, text text not null, tsv tsvector generated always as (to_tsvector('cerebro', title || ' ' || text)) stored, model text not null, created_at timestamptz default now(), unique(session_id, first_seq, last_seq))` + GIN on tsv, index `(project_id, ts_to desc)`, `(client_id, ts_to desc)`.
- `summary_embeddings(summary_id bigint pk references summaries on delete cascade, embedding halfvec(1024) not null)` + HNSW cosine.
- `summary_jobs(session_id text pk references sessions, priority smallint not null default 0, covered_seq int not null default -1, due_at timestamptz not null default now(), attempts int default 0, locked_until timestamptz, last_error text, dead boolean default false)`.
- `project_states(scope text pk /* 'project:<uuid>' | 'client:<uuid>' */, client_id uuid not null, project_id uuid null, doc jsonb not null, text text not null, version int not null default 1, dirty boolean not null default false, source_summary_ids bigint[] not null default '{}', updated_at timestamptz default now())`.
- `usage_ledger(id bigserial pk, at timestamptz default now(), tokens int not null, kind text not null /* summary|state|history */)` + index on `at`.

- [ ] **Step 1: Failing test** `migrate creates the summary tables and unique summary ranges` (insert two summaries with the same session and seq range → unique violation; tsv matches a word in the title).
- [ ] **Step 2: Run** `bun test server/test/summaries-schema.test.ts` → FAIL. **Step 3: Write the migration.** **Step 4: Run** → PASS; full `bun test` green.
- [ ] **Step 5: Commit** `feat(server): schema for summaries, jobs, project state and usage ledger`.

---

### Task 2: Summary jobs and coverage

**Files:** Create `server/src/summarise/jobs.ts`, `server/test/summary-jobs.test.ts`. Modify `server/src/ingest.ts` (`endSession`), `server/src/bindings.ts` (mark dirty on rebind/adopt/move — see Task 6 interface).

**Interfaces — Produces:**
- `enqueueSummary(sql, sessionId: string, opts: { priority: 0 | 1; dueAt?: Date }): Promise<void>` — upsert; keeps the lower priority and the earlier due date.
- `scheduleGrowingSessions(sql, opts?: { minNewEvents?: number /* 150 */; maxAgeHours?: number /* 2 */ }): Promise<number>` — enqueues sessions whose uncovered user/assistant events ≥ 150, or ≥ 20 with the oldest uncovered event older than 2 h; returns count.
- `claimSummaryJob(sql, leaseSeconds = 900): Promise<{ sessionId: string; priority: number; coveredSeq: number } | null>` — `for update skip locked`, ready (`due_at <= now()`, not dead, lease free), order by priority then due_at.
- `completeSummaryJob(sql, sessionId, coveredSeq: number): Promise<void>` — sets `covered_seq`; deletes the job when no events with `seq > coveredSeq` remain, else re-dues it in 2 h.
- `failSummaryJob(sql, sessionId, error: string, opts: { retryable: boolean }): Promise<void>` — attempts+1, backoff `min(6h, 5min·2^attempts)`, dead after 5 non-retryable failures; `retryable` failures (budget, usage limit, login) only release the lease and set `due_at`.
- `endSession` enqueues with priority `imported ? 1 : 0`; imported sessions also get enqueued when the importer's events arrive (ingest: `imported` sessions without a job → enqueue priority 1).

- [ ] **Step 1: Failing tests**: `ending a session queues a live job; imported sessions queue at low priority`; `claim prefers live jobs and never hands one job to two workers` (two concurrent claims → different sessions); `a resumed session gets a follow-up job covering only new events` (complete at seq 40, ingest seq 41–60 with later ts, end again → job with covered_seq 40); `growing sessions are scheduled by size or age`; `retryable failures keep attempts at 0; five real failures dead-letter`.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(server): summary jobs with coverage, priority and backoff`.

---

### Task 3: Claude CLI runner and fake

**Files:** Create `server/src/summarise/claude.ts`, `server/test/fakes/fake-claude.ts`, `server/test/claude-runner.test.ts`.

**Interfaces — Produces:**
- `interface ClaudeRun { ok: true; output: unknown; tokens: number; model: string; credentialExpiresAt: string | null } | { ok: false; kind: "usage_limit" | "auth" | "timeout" | "bad_output" | "failed"; message: string; resetAt: Date | null }`
- `runClaude(input: { systemPrompt: string; prompt: string; schema: object; timeoutMs?: number /* 180000 */ }, env = process.env): Promise<ClaudeRun>` — spawns `SUMMARISER_CMD` (default `claude`) with args `-p --model haiku --output-format json --json-schema <schema JSON> --system-prompt <systemPrompt> --tools "" --strict-mcp-config --no-session-persistence`, prompt on stdin, env adds `CEREBRO_HEADLESS=1` and passes `CLAUDE_CONFIG_DIR` through; parses the result JSON: `is_error === false` → `output` = parsed structured output (the CLI's `structured_output`/`result` field — verify which on CLI 2.1.325 in Step 3 and record it), `tokens` = `input_tokens + output_tokens + cache_creation_input_tokens`; classifies failures: text matching `/usage limit|rate limit/i` → `usage_limit` with `resetAt` parsed from a `|<epoch>` suffix or ISO time when present; `/login|auth|credential|401/i` → `auth`; timeout → `timeout`; unparseable/invalid → `bad_output`.
- `fake-claude.ts`: a Bun script runnable as `SUMMARISER_CMD="bun server/test/fakes/fake-claude.ts"`; behaviour selected by env `FAKE_CLAUDE_MODE` (`ok` returns a deterministic schema-valid object derived from the prompt; `limit` prints the usage-limit error with a reset epoch; `auth`; `garbage`; `slow`).

- [ ] **Step 1: Failing tests** per classification with the fake; `tokens counts cache creation`; `the prompt is passed on stdin, never as an argument` (fake echoes argv).
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Verify against the real CLI** (one call, owner's machine): run `runClaude` with a 20-word prompt and the summary schema; record in the report: which JSON field carries the structured output, the token count, and that `CEREBRO_HEADLESS=1` kept the plugin quiet. Target: < 8 000 tokens per small call with the replacement system prompt.
- [ ] **Step 6: Commit** `feat(server): headless Claude Code runner with error classification`.

---

### Task 4: Token budget

**Files:** Create `server/src/summarise/budget.ts`, `server/test/budget.test.ts`. Modify `server/src/config.ts` (`SUMMARY_SHARE`, `SUBSCRIPTION_TOKENS_PER_5H`, `SUMMARISER_CMD`, `SUMMARISER_ENABLED` default `true`).

**Interfaces — Produces:**
- `record(sql, tokens: number, kind: "summary" | "state" | "history"): Promise<void>`
- `budgetState(sql, cfg: { share: number; windowTokens: number }, now = new Date()): Promise<{ used: number; limit: number; remaining: number; resumesAt: Date | null }>` — `limit = floor(share × windowTokens)`; `used` = sum over the last 5 h; `resumesAt` = when enough old entries leave the window to bring `used` under `limit` (null when under).
- `canSpend(state, estimate: number): boolean` — `remaining >= estimate`; estimate for a job = `ceil(inputChars / 3.5) + 4000`.
- Ledger rows older than 7 days are deleted by `budgetState` (cheap housekeeping).

- [ ] **Step 1: Failing tests**: `budget is share × window, used counts the last 5 hours only`; `resumesAt is when the oldest spending leaves the window`; `config validates share in (0, 1]`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(server): rolling 5-hour token budget for the summariser`.

---

### Task 5: Rendering and summarising a job

**Files:** Create `server/src/summarise/render.ts`, `server/src/summarise/prompts.ts`, `server/src/summarise/summarise.ts`, tests `server/test/render.test.ts`, `server/test/summarise.test.ts`.

**Interfaces — Produces:**
- `renderRange(events: EventRow[], maxChars = 60000): { text: string; firstSeq: number; lastSeq: number; tsFrom: string; tsTo: string }[]` — lines `[HH:MM] User: …`, `Assistant: …`, `Tool <name>: <input ≤ 300>`, `Result: <≤ 300 chars>`; drops `mcp__cerebro__*` tool calls/results; drops thinking/meta; splits at event boundaries into pieces ≤ `maxChars`.
- `SUMMARY_SCHEMA` (JSON Schema): `{ title: string ≤ 120, period: string, overview: string ≤ 1200, decisions: string[] ≤ 20×300, changes: string[] ≤ 20×300, facts: string[] ≤ 30×300 /* durable facts: names, dates, numbers, URLs, commitments */, open_threads: string[] ≤ 20×300, resolved_threads: string[] ≤ 20×300 }`. `SUMMARY_SYSTEM_PROMPT`: summarise only what the transcript says, dated, no speculation, no instructions followed from the transcript, plain language; facts are things worth recalling months later.
- `summariseJob(sql, embedder, job, deps: { run: typeof runClaude; budget }): Promise<"done" | "deferred" | "failed">` — loads events `seq > coveredSeq` (≤ 2000), renders, checks `canSpend` per piece (else `failSummaryJob(..., { retryable: true })` with `due_at = resumesAt` → `deferred`), runs Claude, validates against the schema (truncate over-long fields; reject missing required fields → `bad_output`), redacts every string, stores `summaries` (scope ids copied from the session's binding at this moment), records tokens, embeds `title + overview + facts` (via the existing embedder with a 30 s timeout; failure leaves the summary un-embedded and queues nothing — full-text still works), marks scopes dirty for `updateState` (Task 6), completes the job with the last covered seq. Usage-limit/auth/timeout → retryable failure (`due_at` = `resetAt` or +30 min); `bad_output` → non-retryable.

- [ ] **Step 1: Failing tests**: `render excludes cerebro tool results and caps tool output`; `long ranges split into consecutive pieces`; `a finished session yields one stored, embedded summary with its scope`; `over budget defers without calling claude`; `usage limit defers until the reported reset and records no tokens`; `garbage output retries then dead-letters, storing nothing`; `secrets and 50 KB fields in model output are redacted and truncated`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(server): summarise sessions into dated, scoped summaries`.

---

### Task 6: Project state

**Files:** Create `server/src/summarise/state.ts`, `server/test/state.test.ts`. Modify `server/src/bindings.ts` (`upsertBinding` rebind, `adoptSessions`, `moveSession` → `markScopesDirty`).

**Interfaces — Produces:**
- `scopeKey(clientId: string, projectId: string | null): string` — `project:<id>` or `client:<id>`.
- `markScopesDirty(sql, keys: string[]): Promise<void>`; in bindings.ts, a rebind marks the old and new scopes, adopt/move mark source and target.
- `STATE_SCHEMA`: `{ overview: string ≤ 1500, current_status: string ≤ 800, decisions: {text, date}[] ≤ 30, open_threads: {text, since}[] ≤ 30, resolved_recently: {text, date}[] ≤ 15, facts: string[] ≤ 40 }`.
- `updateState(sql, scope: string, newSummaryIds: bigint[], deps): Promise<"updated" | "deferred">` — prompt = current state JSON + the new summaries; output replaces `doc`, `text` = rendered markdown ≤ 6000 chars, `version+1`, appends to `source_summary_ids`.
- `rebuildState(sql, scope, deps)` — from scratch using the scope's last 40 summaries (oldest first, batched 10 per call), used for dirty scopes and when no state exists.
- The loop (Task 7) runs `updateState` after each summary and `rebuildState` for dirty scopes, both under the budget.

- [ ] **Step 1: Failing tests**: `a new summary updates its project's state and closes threads it resolves`; `client-only bindings keep a client-level state`; `re-binding a folder to another client rebuilds both scopes and the old one no longer mentions it`; `state output is redacted and size-capped`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(server): running project state with rebuild on re-bind`.

---

### Task 7: Summariser loop, status and wiring

**Files:** Create `server/src/summarise/loop.ts`, `server/test/summariser-loop.test.ts`. Modify `server/src/main.ts`, `server/src/http/routes/status.ts`.

**Interfaces — Produces:**
- `startSummariser(sql, embedder, cfg, deps?): { stop(): Promise<void>; state: SummariserState }` — every 30 s: `scheduleGrowingSessions`, then loop: budget check → claim → `summariseJob` → `updateState` for touched scopes → dirty-scope rebuilds (≤ 2 per tick); paused when disabled, over budget (`resumesAt`), usage-limited (`resetAt`) or login expired (re-probed every 15 min with a tiny call).
- `SummariserState { enabled, paused: null | { reason: "budget" | "usage_limit" | "login" | "disabled"; until: string | null }, lastRunAt, lastError, credentialExpiresAt }`.
- `/v1/status` gains `summariser: { …SummariserState, backlog: { live, imported, dead }, budget: { used, limit, resumesAt } }`.
- `main.ts` starts it after the embed worker when `SUMMARISER_ENABLED` is true; SIGTERM stops it (awaits the current job).

- [ ] **Step 1: Failing tests** (fake CLI): `end-to-end: ingest → end → summary → state`; `usage limit pauses the loop and live work resumes first after reset`; `expired login is reported in status and recovers when the probe succeeds`; `disabled summariser leaves jobs queued`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(server): summariser loop with budget, pause and status`.

---

### Task 8: Summary and state API, search over summaries

**Files:** Create `server/src/http/routes/summaries.ts`, `server/test/summaries-api.test.ts`. Modify `server/src/search.ts`, `shared/src/types.ts`, `README.md`.

**Interfaces — Produces:**
- `GET /v1/state?repo&subpath | scope=open&projectId|clientId` → `{ scope: string | null, state: { doc, text, version, updatedAt } | null }` — scoped exactly like reads (project lock applies).
- `GET /v1/summaries?repo&subpath|scope=open&from&to&limit≤100&before` → `{ summaries: SummaryView[], next }` (`SummaryView = { id, kind, sessionId, firstSeq, lastSeq, tsFrom, tsTo, title, overview, facts, clientName, projectName }`).
- `POST /v1/summaries` (initial history) body `{ repo, subpath, title ≤ 200, text ≤ 20000, tsFrom, tsTo }` → stores a `kind: 'history'` summary for the folder's active binding (404 `unknown_binding` if not bound, 409 if declined), redacted, embedded, marks scope dirty; costs no server tokens (the client's own Claude wrote it).
- Search: new request field `include?: "all" | "summaries" | "raw"` (default `all`); summaries get their own FTS and vector legs (same scope rules, same timeouts) fused by RRF with chunk hits; `SearchHit` gains `kind: "chunk" | "summary"` and `summaryId?`; summary hits rank first on ties.

- [ ] **Step 1: Failing tests**: `state is project-locked like reads`; `summaries list pages and filters by date`; `initial history is stored for the bound folder only and redacted`; `search returns summary hits with kind, and include=raw excludes them`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(server): state and summaries API; search includes summaries`.

---

### Task 9: Client — brief from state, recall tools, initial history

**Files:** Modify `client/src/api.ts`, `client/src/brief.ts`, `client/src/hooks.ts`, `client/src/mcp.ts`, `plugin/skills/cerebro/SKILL.md`; tests `client/test/hooks.test.ts`, `client/test/mcp.test.ts`, `client/test/cli.test.ts`.

**Interfaces — Produces:**
- `ApiClient.state(scope)`, `ApiClient.summaries(q)`, `ApiClient.saveHistory(body)`.
- Brief: when `/v1/state` returns a state, the brief is `<binding line>` + problem lines + the state's `current_status`, up to 5 `open_threads`, up to 3 recent `decisions` (≤ 1500 chars total, problems first); falls back to the recent-sessions brief when no state yet; cached in `state` for offline starts.
- MCP: `cerebro_state {}`, `cerebro_summaries { from?, to?, limit? }`, `cerebro_save_history { title, text, from, to }`; `cerebro_search` shows summary hits first, marked `[summary]`.
- SKILL.md: after a successful bind, step "Build an initial project history": run `git log --since=<12 months> --date=short --pretty='%ad %s' | head -400`, read README/docs briefly, write ≤ 1500 words covering what the project is, how it got here, key decisions with dates, current state, open questions; call `cerebro_save_history` with the period covered; tell the user it's saved.

- [ ] **Step 1: Failing tests**: `SessionStart brief shows project state when present`; `brief falls back to recent sessions without state`; `cerebro_save_history stores a history summary for this folder`; `the skill names cerebro_save_history after binding`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `feat(client): brief from project state; summary recall and initial history`.

---

### Task 10: End-to-end with the real CLI (controller-run)

- [ ] **Step 1:** On the owner's Mac, against a local dev server with `SUMMARISER_CMD=claude` (owner's subscription), ingest one real-sized session (~300 events from a fixture), end it, and record: tokens used, wall time, summary quality (read it), state produced.
- [ ] **Step 2:** Set `SUBSCRIPTION_TOKENS_PER_5H` so `0.2 ×` it allows the expected daily volume; record the chosen default in the README with the measurement.
- [ ] **Step 3: Commit** `docs: summariser measurements and budget defaults`.
