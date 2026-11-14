## Answers to reviewer questions

My probe of the leaner design is at `/private/tmp/claude-501/-Volumes-Content-projects-Cerebro/b14abdbd-98d6-4749-9a6f-829bfb486107/scratchpad/review/pro/probe.ts` (throwaway DB, dropped). I did not re-run the reviewers' probes or `bun test`; I read their probe output and the code.

**Recall tools and scope**
- **Will list/open-session tools run in a project-locked folder? (SecA Q1)** Yes. The spec's "Tools for Claude" lists "open a time range / session" and "quote raw conversation spans". SA-2 stands and should be fixed server-side now.
- **Does "unbound → open" cover "server didn't recognise the folder"? (SecA Q2)** The spec says not bound → all clients, and the server cannot tell the two apart. The fix is to remove the accidental cases: server-side normalisation, an explicit `scope:"open"` when no repo is sent, and echoing the resolved binding id.
- **Recall in a declined folder? (SecA Q3)** The spec treats declined as "not bound", so search is allowed. The tools are installed per machine, so Claude can call them there; SA-10 is not moot.
- **Is semantic recall in small projects required at year five? (AdvA Q5)** Yes. Project-locked search is the main recall path under the owner's scoping rule.
- **Is `full=1` for whole sessions or narrow ranges? (SecB Q5)** Narrow ranges. The spec says "progressive disclosure … full text is fetched only on request" and "quote raw spans". A hard cap is right.

**Ingest contract (plan 2 is unwritten, so these are the contract I recommend fixing now)**
- **Event key scheme, import vs live, resume/fork, half-written lines (SecA Q6, AdvA Q1, AdvB Q7)**
  - Key = `<transcript entry uuid>:<content-block index>`, unique per session, not globally.
  - Import and live capture both read the transcript file, so they produce the same key.
  - A resumed or forked session that copies old messages keeps them under its own session id.
  - The client must only read newline-terminated transcript lines.
- **Client behaviour on 500 vs 4xx, batch size, timeout (SecB Q1)**
  - 2xx carries per-item results: dequeue accepted and duplicate items, quarantine rejected ones locally.
  - 5xx or network error: retry with backoff.
  - Whole-batch 4xx: split the batch in half and resend.
  - 401 `token_revoked`: stop and tell the owner.
  - Cap at 2,000 events and 8 MB per batch.
- **`sessions[]` in every batch, mixed sessions? (AdvA Q8)** Always include the session entry; batches may mix sessions. Per-item results make the blast radius one item.
- **Same session id from two machines? (SecA Q7)** Not expected, since transcripts are per machine. I recommend no strict ownership check either way (see SA-7).
- **Single event over 10 MB (AdvA Q6)** Covered by the owner decision on what "raw" includes, below.
- **Should `ended_at` clear on resume? (AdvA Q7)** Yes. Ingest should null `ended_at` when a later event arrives; plan 3 triggers on it.
- **Move one mis-filed session? (SecA Q8)** Not in the spec, but AB-7 needs it. Add `PATCH /v1/sessions/:id {bindingId}`.

**Capacity and hardware**
- **NVMe size (AdvA Q2, AdvB Q1)** 904 GB, 437 GB free, shared with media. Backup USB: 234 GB, 145 GB free.
- **Is bge-m3 benchmarked on the 2400GE? (SecB Q4, AdvA Q3)** No. It must be measured before plan 2 designs the import. All Zima figures in the reports are scaled from Macs.
- **Is 20M chunks intentional? (AdvB Q2)** It is the brief's planning ceiling. AdvB's own data implies about 3M chunks per 100 GB raw. Design for 3M and do not block 20M.
- **Memory limit on Zima? (SecB Q2)** Plan 4. It should have one: about 7 GB is available on the host for server, Postgres and Ollama together.
- **Is Ollama dedicated and configurable? (SecB Q3)** Plan 4. The spec makes the embedding model part of the Cerebro service, so use a dedicated container with a thread cap and `keep_alive`.
- **Is a second replica near-term? (AdvB Q9)** No; the brief says "should be possible later". Do only the cheap enablers: advisory lock on migrate and skip-locked claims.
- **Search during import, live sessions searchable promptly (SecB Q6, AdvA Q4, AdvB Q8)** The owner's intent is that catch-up is useful from the first session, and the spec puts live work ahead of the import backlog. So full-text must work immediately and live sessions must jump the embedding queue. Semantic search over the import may lag (owner decision 1).

**Secrets and transport**
- **Is a redaction CLI compatible with "raw forever"? (SecA Q5)** Yes. "Secrets at rest" is an anti-goal, and the spec's marker "preserves the fact a secret was there".
- **Will the travelling Mac flush off-LAN? (SecA Q4)** It will try, since the spec's background flush runs "when reachable". See owner decision 6.

**OWNER DECISION NEEDED**
1. **Embedding capacity (AdvB Q3, AdvA Q3).** Scaled estimates put a 5,000-session import at 7–14 days of all cores on Zima.
   - (a) Throttle the embedder on Zima and accept that semantic search over imported history fills in over days or weeks, with full-text available immediately.
   - (b) Let a Mac act as embedding worker for bulk imports.
   - (c) Pick a smaller multilingual model.
   - Default: (a), after a benchmark on Zima; the queue design below leaves (b) open without building it.
2. **Queued uploads for a since-declined folder (AdvB Q6).** Keep them (stored and flagged, since they were recorded while opted in) or discard them. Default: keep, because "lost memory" is an anti-goal and declining is not a delete request.
3. **Monorepo adoption (AdvB Q5).** When a more specific subfolder binding is added, should the skill offer to move past sessions recorded under it? Default: offer and never auto-move; ruling 4 stays the default behaviour.
4. **What "raw" includes (AdvB Q4, AdvA Q6).** Default: every textual field of the transcript entry (uuids, tool_use_id, model, sidechain flags, thinking text) goes in a `meta` column. Image bytes become a placeholder. A single event over 8 MB is truncated with a marker and its original length.
5. **Disk budget (AdvB Q1, AdvA Q2).** How much of the 437 GB may Cerebro use, and are embeddings in backups? Default: 150 GB budget reported in status, and embeddings dumped separately and less often than events.
6. **Off-LAN protection for the travelling Mac (SecA Q4).** Default: the plugin checks an instance id from `/health` before sending the token or any body. Internal-CA HTTPS or Tailscale-only are the stronger options if you want them.

## Verdicts

AA = Adversarial A, AB = Adversarial B. S/M/L sizes are in the fix list.

**Search**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| AA-1, AB-4 | CONCEDE-REGRADE Important | Real: `search.ts:60-70` filters after the HNSW scan, and both probes show 1–12 of 50 for small scopes. It is a query-only fix with no data loss, so not Critical. Fix: count in-scope chunks with `limit 50001`; below that do exact kNN through the sessions join, else HNSW. My probe: count ≤7 ms, exact kNN 26 ms at 5k and 136 ms at 50k. Denormalising `binding_id` onto chunks is not needed and would weaken ruling 1. |
| AA-4, AB-11 | CONCEDE Important | `'simple'` plus AND-everything (`001_init.sql:75`, `search.ts:62`) returns 0 for natural questions. Fix: custom config (simple + unaccent), tsv also over a delimiter- and camelCase-split copy of the text, stop words dropped in code, AND first then OR-prefix fallback. My probe: this fixes all reported cases except "fixing"→"fixed", which I would leave to the vector leg. No stemmer (English/Spanish mix); `pg_trgm` is over-engineered. |
| SB-6, AA-9 | CONCEDE Important | Unbounded `ts_rank` and no timeout are real. Fix: rank only the newest 5,000 matches (my probe: 12 ms vs 132 ms on 101k matches), `set local statement_timeout` with a per-leg degraded flag, and pre-filter sessions by date overlap for date windows. RUM/BM25 extensions are over-engineered. `chunks_session_idx` is redundant with the unique index (`001_init.sql:77-79`); replace it. |
| SB-1, AA-5 (contention), AB-3 | CONCEDE-REGRADE Important (AB-3 was Critical) | `Promise.race` without abort at `search.ts:37` is real; so is the shared queue. Fix: pass an AbortSignal, small character-budgeted embed batches, an in-process "search waiting" gate the worker yields to, and `keep_alive: -1`. A second Ollama instance and a query-vector cache are over-engineered. |
| AA-5 (coupling) | CONCEDE Important | `embedding … not null` (`001_init.sql:76`) means nothing is full-text searchable until embedded. Fix: chunks exist without vectors (see schema reshape). |
| AA-13 | CONCEDE Minor | `set local hnsw.ef_search = 100`, sort candidates by distance, add `, c.id` tie-break. |
| AA-14 | CONCEDE Minor (part), DISPUTE (part) | Concede 400 on `from > to` and a `started_at` index with a cursor on `/sessions`. Dispute date-only `to` (zod already requires a full datetime) and search cursors past 50 (progressive disclosure). |
| AB-18 | CONCEDE Minor | Add `matched` and `distance` to each hit and collapse parts of the same event. Cheap contract addition now. |
| AB-19 | CONCEDE Minor, defer | Do not change chunk composition until the Zima benchmark. The embed queue below allows full-text-only chunks later. |

**Schema and storage**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| AA-2, AB-6 | CONCEDE (before data) | 7.8 KB/row HNSW is measured. Fix: `chunk_embeddings(chunk_id, embedding halfvec(1024))` with a halfvec HNSW index; my probe measured 2.73 KB/row index and 5.6 KB/row all-in (about 17 GB at 3M chunks). Store model and dims in a one-row settings table and refuse to start on mismatch, which also closes the deferred EMBED_DIMS item. Binary quantisation and a per-row `model` column are over-engineered now; the separate table makes both additive later. |
| AB-5 | CONCEDE-REGRADE Important (before data) | True: `ingest.ts` schema strips unknown fields and nothing else keeps them. Fix: `events.meta jsonb` and `sessions.meta jsonb`, with unknown fields passed through into `meta`. A full `raw jsonb` duplicates the text, and dedicated `tool_use_id`/`parent_key` columns can be promoted from `meta` later. |
| AB-7 | CONCEDE-REGRADE Important (before data) | The server stores only absolute `cwd`, so it cannot compute what to move. Fix: `sessions.repo` and `sessions.subpath` at ingest, plus `PATCH /v1/sessions/:id`. The adopt-under-binding action is one UPDATE; the skill offer is plan 2. |
| SA-5 | CONCEDE Important (before data) | `key text not null unique` (`001_init.sql:53`) lets one session's key swallow another's. Fix: `unique (session_id, key)`. |
| AB-15 | CONCEDE, plan 4 | Sizing is right for the old schema. Now: `compression lz4` on `events.text` in the migration, and immutable events (below). Plan 4: dump embeddings separately. Append-only segment export is over-engineered at 3M chunks. |
| AA-12 | CONCEDE Minor | Closed by removing `events.indexed`. |
| AB-20 | Agree, no change | Do not partition. |

**Ingest**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| SA-6, SB-4, AA-3, AB-9 | CONCEDE Important | Reproduced by three reviewers. Fix: NUL-strip and `toWellFormed()` every string, bound timestamp years, cap `toolInput` depth, validate each event individually and return `rejected:[{key, code}]` while committing the rest. Any remaining Postgres data error becomes a whole-batch 422 and the client bisects. Savepoints per event are over-engineered. The declined-while-offline case follows owner decision 2. |
| SB-3, AA-8 | CONCEDE Important | One round trip per event at `ingest.ts:41-48`. Fix: one `unnest` insert, 2,000-event cap, explicit pool size, a small ingest semaphore, connection-level `statement_timeout` and `idle_in_transaction_session_timeout`. My probe: 2,000 events plus 1,500 chunks in 378 ms, replay 38 ms. A separate ingest pool is unnecessary. |
| AA-15 | CONCEDE Minor | Use `greatest(last_event_at, batch max)`. |
| SB-9 | CONCEDE Minor | 64 KB body limit on non-ingest routes, `= any($1)` instead of `in (…)`, advisory lock on migrate. |

**Indexing**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| SB-2, AA-7, AB-8 | CONCEDE Important | All-or-nothing per session at `indexer.ts:42-57` is real. Leaner than the reviewers' `index_jobs`: chunk inside the ingest transaction for the events that insert returned, and queue each chunk in `embed_queue(chunk_id, priority, attempts, next_attempt_at, last_error)`. A worker claims rows with `for update skip locked`, commits per small batch, and retries a failed batch item by item. Also cap indexable text per event at about 32k characters. This removes `events.indexed`, the in-memory backoff, and the deferred double-indexing and chunk-key-drop items. |
| AA-6, AB-2 | CONCEDE-REGRADE Important (AB-2 was Critical) | `order by min(id)` at `indexer.ts:32` is strict FIFO. There is no data loss, and with chunk-at-ingest live sessions are full-text searchable at once. Fix: queue priority, live before imported. |
| AB-1 | CONCEDE-REGRADE Important | The direction is right but the Zima numbers are scaled, not measured. Fix: full-text first, priority, a thread cap on Ollama (plan 4), and a benchmark. A remote worker is owner decision 1; do not build it now. |
| SB-8 | CONCEDE Minor | Status reports queue depth, oldest age, dead-lettered chunks and last embedder success. One global "embedder down" pause. `Number.isFinite` check on vectors. |

**Read API, scope, auth**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| SB-5, AA-10, AB-12 | CONCEDE Important | `read.ts:40-50` loads full text then truncates in JS. Fix: `left(text, 2001)` in SQL, default limit 200 with a seq cursor, byte cap on `full=1`. The indexer half disappears with chunk-at-ingest. |
| SA-1, AB-13 | CONCEDE Important | The server never calls `normalizeRemote` (it is only used in `shared/test`). Fix: normalise in upsert, resolve, repoint and `scopeFor`, skipping `path:` identities. Require `repo` or explicit `scope:"open"`, and echo the resolved binding id. |
| SA-2 | CONCEDE Important | Ruling 2 exempted reads by id, but `GET /v1/sessions` is an enumeration and plan 2 will expose it to Claude. Fix: accept `repo`/`subpath` on both read routes and apply `scopeFor`; the plugin always sends them. Ruling 2 still holds for callers that omit them. |
| SA-10 | CONCEDE Minor | `search.ts:14` makes a declined subfolder open. Fix: resolve the nearest active ancestor for scope. |
| SA-9 | DISPUTE server change; plan 2 | Document that the plugin derives subpath from the real path. No server code. |
| SA-8 | CONCEDE Minor | Reject `path:X:` writes where X is not the caller's machine name; the plugin takes its name from `/v1/status`. |
| AB-10 | CONCEDE Important | `bindings.ts:52-54` overwrites silently. Fix: 409 when an existing binding's scope would change unless `rebind: true`, plus an append-only `binding_history`. The project-state follow-on is plan 3. |
| SA-7 | CONCEDE Minor (part), DISPUTE (part) | Concede `machines.last_used_at`, one access-log line per request, and `binding_history`. Dispute session-ownership enforcement and a `machine_tokens` table: one owner, and a stolen token can still create sessions and re-bind. |
| SA-4 | CONCEDE Important, mostly plan 2 | No purge path exists. Fix: one redaction function in `shared/` run on client and at server ingest (including `cbr_` tokens), and `cli.ts redact` that rewrites events and re-chunks. A warning line in `token create` output. |
| SA-3 | CONCEDE-REGRADE Minor now, plans 2/4 | Server now: an instance id in `/health`. Plan 2: preflight check and dequeue only on a well-formed result. TLS with a pinned CA is owner decision 6. |
| SA-11 | CONCEDE Minor | `app.onError` logging code, route and machine only. |
| AB-16 | CONCEDE Important (part), DISPUTE (part) | Concede one error shape `{error: code, message}`, `token_revoked` vs `unauthorized`, `apiVersion` in `/health`, and the bug at `app.ts:20` (`ok: true` on a 503). Dispute a separate `/ready`, request ids and `minClient`; status plus the access log cover them. |

**Ops and container**

| IDs | Verdict | Justification and right-sized fix |
|---|---|---|
| AA-11, AB-14 | CONCEDE Important (part), DISPUTE (part) | Concede the advisory lock (AA reproduced the race 5 of 5), a `-- no-transaction` marker for concurrent index builds, and `lock_timeout`. Dispute a background backfill framework and a separate migrate command. `shm_size` and memory settings are plan 4. |
| SB-7 | CONCEDE Minor | Now: `.env*` in `.dockerignore`, `bun --no-install`. Plan 4: digest pin, healthcheck, explicit model tag. A model-digest check at startup is over-engineered. |
| AB-17 | CONCEDE, plan 4 | Postgres tuning belongs in the deployment compose. |

The eight deferred items in the brief: three close for free under this design (double-indexing, chunk-key drop, EMBED_DIMS check). Ingest deadlock is mitigated by sorted multi-row inserts. The rest stay deferred.

## Consolidated fix list

No data exists yet, so every schema item is an edit to `001_init.sql`, not a migration.

1. **Schema reshape (BEFORE DATA, size M)**
   - **Changes:**
     - `events`: `unique (session_id, key)`, `meta jsonb`, lz4 on `text`, drop `indexed`.
     - `sessions`: add `repo`, `subpath`, `meta`, and a `started_at` index.
     - `chunks`: no embedding column, new tsv config, redundant index replaced.
     - New tables: `chunk_embeddings` (halfvec), `embed_queue`, `binding_history`, a one-row settings table; add `machines.last_used_at`.
   - **Closes:** AA-2, AB-6, AB-5, AB-7 (columns), SA-5, AA-12, AB-15 (lz4), AA-5 (coupling).
   - **Tests:** same key in two sessions stores both; unknown event fields land in `meta`; startup refuses a model or dims mismatch; a chunk is full-text searchable with no embedding row.

2. **Ingest contract (depends on 1, size M)**
   - **Changes:** sanitise all strings, bound timestamps and depth, per-item `rejected`, `unnest` insert, 2,000-event cap, chunk in the same transaction, `greatest()` for `last_event_at`, clear `ended_at` on new events, pool size, semaphore, timeouts.
   - **Closes:** SA-6, SB-4, AA-3, AB-9, SB-3, AA-8, AA-15, SB-9 (part).
   - **Tests:** every poison input from `sec-b/poison.ts` returns 200 with the bad item rejected and the rest stored; a 2,000-event batch finishes under a second; `/health` answers during 10 concurrent batches; replay inserts nothing and creates no chunks.

3. **Embed worker (depends on 1–2, size M)**
   - **Changes:** replace `indexer.ts` with a queue worker (skip-locked claim, commit per batch, per-item retry, persisted attempts, live before imported, global embedder-down pause, yield to searches, text cap per event).
   - **Closes:** SB-2, AA-6, AA-7, AB-2, AB-8, SB-1/AB-3 (worker side), SB-8, AB-1 (server side).
   - **Tests:** one poison chunk dead-letters while the rest embed; a restart keeps attempts; two workers never embed the same chunk; a live chunk is embedded before 3,000 queued import chunks.

4. **Search (depends on 1 and 3, size M)**
   - **Changes:** count then exact-or-HNSW, AbortSignal, full-text AND→OR-prefix with stop words, bounded ranking, statement timeout with per-leg degraded flags, `ef_search`, tie-breaks, hit fields, `from > to` 400.
   - **Closes:** AA-1, AB-4, AA-4, AB-11, SB-6, AA-9, AA-13, AA-14, AB-18, SB-1 (abort).
   - **Tests:** a 100-chunk project among 100k returns 50 vector candidates; the AA-4 query table returns hits; a timed-out embed aborts its fetch.

5. **Scope and read API (independent of 1–4, size M)**
   - **Changes:** server-side `normalizeRemote`, explicit open scope, echoed binding id, nearest-active-ancestor scope, scoped and paginated reads, SQL truncation, `PATCH /sessions/:id`, rebind guard with history, `path:` prefix check.
   - **Closes:** SA-1, AB-13, SA-2, SA-10, SA-8, SB-5, AA-10, AB-12, AB-10, AB-7 (endpoint).
   - **Tests:** every spelling from `sec-a/probe.test.ts` section 1 stays locked; a locked list omits other projects and a locked read of a foreign session is 404; 150 × 1 MB tool results read without RSS growth.

6. **Auth, errors, ops (independent of 1–4, size S)**
   - **Changes:** error shape and `onError`, `token_revoked`, `/health` fix with `apiVersion` and instance id, access log, `last_used_at`, migrate advisory lock and no-transaction marker, body limits, `.dockerignore`.
   - **Closes:** AB-16, SA-11, SA-7 (part), AA-11, AB-14 (part), SB-9, SB-7 (part), SA-3 (server part).
   - **Tests:** two concurrent `migrate()` calls both succeed; a revoked token gets `token_revoked`; a DB-down `/health` returns `ok: false`.

**Plan 2 (client plugin):** key scheme and complete-line reads; batch split and bisect; health preflight (SA-3); shared redactor plus `cli.ts redact` (SA-4); real-path subpath (SA-9); adoption offer (AB-7); oversize-event rule.

**Plan 3 (summariser):** provenance of summaries and regenerating project state after a re-bind (AB-10 follow-on).

**Plan 4 (Zima deploy):**
- Benchmark bge-m3 on the 2400GE. This gates plan 2's import design, so run it first.
- Ollama thread cap, `keep_alive`, parallel slots.
- Memory limits, `shm_size`, Postgres tuning (AB-17).
- Backup scheme with embeddings dumped separately (AB-15).
- Image digest pin and healthcheck (SB-7).
