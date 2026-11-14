## Findings

**B-1 — Critical — Processing architecture / capacity — spec "Local embedding model (CPU)", plan Task 6, ruling 8**
- **Scenario:** Opting in this Mac's history alone (25k chunks) takes 28–54 h of all four cores on the 2400GE. A 5,000-session import (about 155k chunks) takes 7–14 days. Re-embedding after a model or chunker change takes 140–270 days at 3M chunks and 2.5–5 years at 20M. The indexer has no throttle, so it starves the other ~20 containers for the whole period (anti-goal "Endangering existing services").
- **Evidence:** Measured on the Mac (Ollama at about 700% CPU, 1.5 GB RSS); the Zima figures are scaled, not measured.
- **Fix (now, while cheap):**
  - Make embedding a claimable job (see B-8) so a worker can run on any machine. A Mac with native Ollama can do bulk import and re-embed while Zima handles only the live trickle.
  - Cap the Zima embedder (`cpus`, Ollama `num_thread`).
  - Measure real chunks/s on Zima before plan 2 designs the import.
  - Stop embedding tool-call JSON (see B-19); it is about a third of the load.

**B-2 — Critical — Processing / prioritisation — `server/src/indexer.ts:29-32` (`order by min(id)`)**
- **Scenario:** The indexer is strict FIFO, so after a history import every live session queues behind the whole backlog. Today's conversation is not searchable for days, which contradicts the spec's "live before import backlog" intent.
- **Evidence:** Reproduced with `$P/evprobe.ts`: with 3,000 imported sessions pending, a new live session is position 3001 of 3001.
- **Fix:** Order by `(sessions.imported asc, newest first)`, or put an explicit priority on the job row and reserve a share of each tick for live sessions.

**B-3 — Critical — Search availability — ruling 7 + `server/src/search.ts:34`, `server/src/indexer.ts:44-46`**
- **Scenario:** A query embedding waits behind the in-flight indexer batch on the same Ollama. On Zima a batch is 30–60 s, so every search during any backlog (days, per B-1) times out at 3 s and silently becomes full-text only. Full-text is itself weak for natural-language queries (B-11).
- **Evidence:** `$P/throughput.ts`: query embed took 6.7–9.3 s while a batch of 8 was in flight, against 92–120 ms idle, on the M4.
- **Fix:**
  - Have the indexer send one chunk per request and yield to a "search waiting" gate.
  - Raise the query timeout to cover one chunk on the target CPU, or run a second runner for queries.
  - Send `keep_alive: -1` so the first query after idle does not pay a model load.

**B-4 — Critical — Search correctness at scale — rulings 1 and 6, `server/src/search.ts:56-70`**
- **Scenario:** Project scope is a join filter applied after the HNSW scan. For a project that is a small share of all chunks, the iterative scan gives up at about 20k tuples and returns whatever it found. At 3M+ chunks a small project gets close to zero vector hits, and `degraded` stays false.
- **Evidence:** `$P/searchprobe.ts`: a project with 60 of 100k chunks returned 12 of 50 in 440 ms after scanning 18,660 tuples. An exact scan of the same scope returned 50 of 50 in 31 ms.
- **Fix (keeps ruling 1):** When the scope is selective (in-scope chunk count below about 50–100k, tracked per binding or estimated), skip HNSW and do exact kNN over `chunks where session_id in (scope)`. Use HNSW only for open or large scopes. Report a short vector list in the response.
- **Related:** There is no index on `chunks(ts_from/ts_to)`; the date-filtered query fell back to a full scan and sort in the probe.

**B-5 — Critical (must change now) — Data model / "raw forever" — `server/migrations/001_init.sql` events, `shared/src/types.ts` IngestEvent, `server/src/http/routes/ingest.ts:20-28`**
- **Scenario:** The "raw" record keeps only `kind/text/tool_name/tool_input`. The original transcript entry is discarded: message uuid and parentUuid, the tool_use_id that links a result to its call, sidechain/subagent flags, model, usage, thinking blocks, images, git branch, and Claude Code version. zod also silently strips unknown fields, so a newer plugin sending more loses it without error. Local transcripts are then cleaned up, so none of this is recoverable. Plan 3 will want these fields.
- **Evidence:** Code reading only.
- **Fix:**
  - Add `raw jsonb` (the secret-stripped original entry) or at least `meta jsonb` to events, and `tool_use_id` and `parent_key`.
  - Add `meta jsonb` to sessions (branch, version, parent session).
  - Make the ingest schema `.passthrough()` into `meta` rather than strip.
  - It costs one column now and is impossible later.

**B-6 — Critical (must change now) — Data model / vector storage — `001_init.sql` chunks (`embedding vector(1024) not null`, single HNSW)**
- **Scenario A, size:** One 1024-dim float4 vector fills an 8 KB HNSW page. The index is 25 GB at 3M chunks and 164 GB at 20M, on a 16 GB box shared with 20 containers, so every search and insert is random disk I/O. Chunks heap plus HNSW is about 50 GB at 3M and about 335 GB at 20M.
- **Scenario B, model identity:** There is no model or chunker version on a chunk. Changing `EMBED_MODEL` to another 1024-dim model mixes vector spaces with no error. A different dimension needs a rewrite of the largest table, and `not null` forbids a gradual re-embed.
- **Evidence:** Sizes measured (`$P/dbprobe2.ts`); the rest is from the schema.
- **Fix:**
  - Split into `chunks(id, session_id, seqs, ts, text, tsv, chunker_version)` and `chunk_embeddings(chunk_id, model, embedding halfvec(1024))`.
  - Use a `halfvec` HNSW index (2.7 KB/row: 8 GB at 3M).
  - Past roughly 5M chunks, switch to a `bit(1024)` binary-quantised index (434 B/row) with a halfvec re-rank.
  - Refuse to start if the configured model differs from the stored one.
  - **Fine until:** about 300–500k chunks as it is today (the index still fits in page cache).

**B-7 — Critical (must change now) — Data model / client leakage — ruling 4, `sessions.cwd`, `server/src/ingest.ts:26-32`**
- **Scenario:** The owner binds a monorepo root to client A, works for weeks in `apps/clientB`, then adds a subfolder binding to client B. The old sessions stay under client A permanently and surface in A's project searches. There is no API to move a session, and the server could not compute which sessions to move because it stores only the absolute `cwd`, not the repo-relative subpath.
- **Evidence:** Code reading only.
- **Fix:**
  - Store `sessions.repo` and `sessions.subpath` (repo-relative) at ingest.
  - Add `POST /v1/bindings/:id/adopt` (re-home sessions whose subpath falls under a new, more specific binding; the opt-in skill offers it) and `PATCH /v1/sessions/:id {bindingId}`.
  - Ruling 4 can stay the default, but the escape hatch needs these columns from day one.

**B-8 — Important — Processing architecture — ruling 8, `server/src/indexer.ts` (in-memory `Backoff`, `events.indexed`)**
- **Scenario:**
  - Vectors are written only after all of a session's (up to 500) events are embedded. One timeout on the last batch discards everything, and on a slow or contended CPU this can livelock. I saw 2 m+ requests against the 120 s timeout while other reviewers shared the dev Ollama.
  - One poison chunk blocks its session forever, retried every 10 minutes with no dead-letter and no visibility.
  - A restart forgets all backoff.
  - A second replica makes the deferred double-indexing certain.
  - `events.indexed` rewrites every event row once (WAL and vacuum on the largest table), and makes a re-index a 10M-row update.
- **Evidence:** Code reading, plus the observed request times.
- **Fix:**
  - Add an `index_jobs(session_id pk, priority, attempts, next_attempt_at, last_error, locked_until)` table, upserted by ingest and claimed with `for update skip locked`.
  - Commit per embed batch.
  - Bisect a failing batch to isolate the bad chunk and mark it failed.
  - Surface failed jobs in `/v1/status`.
  - This also gives B-1's remote worker and B-2's priority. Cost is about a day now.
  - **Fine until:** the single-container version holds until the first large import.

**B-9 — Important — API contract (plan 2 offline queue) — `server/src/ingest.ts:23-38`, `server/src/http/routes/ingest.ts`, ruling 3**
- **Scenario A:** The travelling Mac holds unsent sessions for folder X. Meanwhile X is declined from another Mac; this is allowed because the server sees no history. On return every batch touching X gets a 422 `binding_declined` for the whole batch, so the queue is blocked or the data is dropped (anti-goal "Lost memory").
- **Scenario B:** One bad item (a timestamp without an offset, a key over 500 chars) returns 400 for the entire batch, and only the first offender is reported.
- **Scenario C:** A single event over 10 MB can never be ingested.
- **Evidence:** Code reading only.
- **Fix:**
  - Return per-item results (`accepted`, `duplicates`, `rejected:[{key|sessionId, code}]`) and commit the good items.
  - Accept events for a since-declined binding and flag the session for the owner.
  - Document a maximum event size and a client-side split rule.
  - Document that the key is globally unique, and decide whether it should be `(session_id, key)`.

**B-10 — Important — Data model / API — `server/src/bindings.ts:52-60` (PUT is create-or-overwrite)**
- **Scenario:** Two Macs opt the same repo into different clients (one offline, or a stale skill run). The last writer silently moves the entire history to another client, with no precondition and no audit trail.
- **Evidence:** Code reading only.
- **Fix:** Make PUT create-only (409 returning the existing binding). Re-binding requires `expectedUpdatedAt` or an explicit `rebind: true`. Add an append-only `binding_history` table.
- **Plan 3 follow-on:** A project state document distilled from a binding that later moves away still contains the other client's content. Record which bindings and sessions each summary came from, and regenerate state on re-bind.

**B-11 — Important (must change now) — Search quality — `001_init.sql` tsv `'simple'`, `server/src/search.ts:62`**
- **Scenario:** `websearch_to_tsquery('simple')` ANDs every word, including stopwords, with no stemming or accent folding. Against a chunk containing the right content: "how did we fix the pricing bug" does not match, nor do `deploy` (text has "deployed"), `cancion` (text has "canción"), or `indexer` (stored as the single token `server/src/indexer.ts`). Claude's natural-language queries therefore get almost nothing from full-text, and during B-3 full-text is the only leg.
- **Cost:** Ranked full-text is unbounded: "the" took 668 ms and "error" 91 ms per 100k chunks, linear, so seconds to minutes at target. There is no `statement_timeout`.
- **Evidence:** `$P/fts.ts`, `$P/searchprobe.ts`.
- **Fix:**
  - Use a custom config (`unaccent` plus a simple or light stemmer, stopwords removed) and also index path and identifier sub-tokens.
  - Query with OR semantics ranked by `ts_rank_cd`, falling back from AND.
  - Bound the candidate set and set a statement timeout.
  - **Why now:** tsv is a stored generated column, so changing it later rewrites the whole chunks table.

**B-12 — Important — API contract — `server/src/read.ts:40-51`, `server/src/http/routes/read.ts`**
- **Scenario:** `GET /sessions/:id/events` has no limit or cursor. It loads every event's full text and truncates tool_results in JavaScript afterwards. The largest local session is 2,345 chunks, and tool_results average about 1 MB per session, so large sessions are tens of MB. With `full=1` it serialises all of it. Plan 2's recall tools will be built on this shape.
- **Evidence:** Code reading; sizes from `$P/stats.ts`.
- **Fix:** Truncate in SQL (`left(text, 2001)`), add `limit` (default about 200) with an `afterSeq` cursor and a byte cap, and return `nextCursor`. Do the same for `/sessions` and search.

**B-13 — Important — Scope safety — ruling 2, `server/src/search.ts:11-17`**
- **Scenario:** If the plugin fails to compute the repo (git error, or the known port-normalisation mismatch) and omits or mis-sends `repo`, the scope becomes open and a project-bound folder searches all clients. That is an accident, which is what the scope rule exists to stop.
- **Evidence:** Code reading only.
- **Fix:** Require either `repo` or an explicit `scope: "open"`, and return 400 otherwise. Echo the resolved binding id in the response so the client can assert it matches what SessionStart resolved.

**B-14 — Important — Operations / migrations — `server/src/db.ts:14-29`, `server/src/main.ts:13`**
- **Scenario:** Migrations run at boot, each in one transaction, with no advisory lock. `create index concurrently` is impossible, so any later index or column change on chunks or events blocks boot and ingest for hours. The health check then fails and a restart policy loops. Two replicas race.
- **Evidence:** A single-threaded HNSW build took 179 s per 100k rows on the M4. A parallel build failed with "could not resize shared memory segment" under Docker's default 64 MB shm (`$P/dbprobe.ts`).
- **Fix:**
  - Use a separate `migrate` command guarded by `pg_advisory_lock`.
  - Support non-transactional migration files.
  - In plan 4's compose, set `shm_size: 1g`, `maintenance_work_mem`, and memory limits.
  - Apply B-5, B-6, B-7 and B-11 now, so no large-table migration is needed later.

**B-15 — Important — Backups (plan 4) — spec "Backups"**
- **Scenario:** At target the database is 100 GB raw plus chunks (heap, HNSW and GIN: about 50 GB at 3M chunks, about 345 GB at 20M). The 20M case exceeds the 256 GB drive on its own, and nightly full dumps do not fit in either case. Vectors dump as text, several times their binary size. Embeddings are not cheaply regenerable (B-1), so excluding them costs months of CPU on restore.
- **Evidence:** Sizes scaled from `$P/dbprobe2.ts`.
- **Fix:**
  - Make events immutable (drop the `indexed` flag, see B-8) and back them up as append-only compressed segments by id range.
  - Export embeddings as binary halfvec segments.
  - Dump the small tables in full.
  - Alternatively use PG17 incremental base backups (`summarize_wal`, `pg_basebackup --incremental`) with WAL archiving for point-in-time recovery; that copies the HNSW index too.
  - Set `default_toast_compression = lz4` before any data exists.

**B-16 — Important — API contract for plans 2/3 — `server/src/auth.ts:41`, `server/src/http/app.ts`, route error handling**
- **Scenario:**
  - A revoked token returns the same 401 `unauthorized` as a typo, so the plugin cannot tell whether to stop and tell the owner or keep retrying.
  - There is no server or API version or minimum-client field, though compiled plugin binaries on other Macs will lag the server.
  - `error` is sometimes a code (`unknown_session`) and sometimes prose (binding routes return `e.message`).
  - Unhandled errors return Hono's plain-text 500.
  - `/health` returns `{ok: true}` with a 503.
  - There is no readiness signal for the embedder or the indexer.
  - There are no request ids.
- **Evidence:** Code reading only.
- **Fix:**
  - Use one error envelope: `{error: {code, message, details}, requestId}`, with an `onError` handler.
  - Use distinct `token_revoked` and `token_unknown` codes.
  - Have `/health` return `{version, apiVersion, minClient}`.
  - Add `/ready` covering db, embedder, and oldest unindexed age.
  - Emit JSON logs with a request id.
  - Extend `/v1/status` with backlog count and age, failed jobs, and db size.

**B-17 — Minor — Operations / Postgres tuning — plan 4**
- **Scenario:** The image defaults are a 128 MB `shared_buffers`, with no `statement_timeout` and no `idle_in_transaction_session_timeout`. The pool is Bun.sql's default, and search holds a transaction across three queries.
- **Evidence:** Settings read via `$P/fts.ts`.
- **Fix:** Set `shared_buffers` to about 2 GB with a container memory limit, a statement timeout of about 10 s on the API role, and an explicit pool size. **Fine until:** about 1M chunks.

**B-18 — Minor — Search contract — ruling 6, `SearchHit`**
- **Scenario:** With no cutoff, every query returns `limit` hits, however irrelevant, and overlapping windows of one message can fill the top 10. The response carries only the fused score, so plan 2 cannot threshold later without an API change.
- **Evidence:** Code reading only.
- **Fix:** Add `matched: ["fts","vec"]`, `vectorDistance` and `ftsRank` to each hit now, and collapse adjacent parts of the same event.

**B-19 — Minor — Chunking — `server/src/chunker.ts:28-31`**
- **Scenario:** Tool calls are 36% of indexable characters (11.5M of 31.4M) and are embedded as truncated JSON, which is noise in the vector space. Truncating at 300 characters also makes code written by Write or Edit unsearchable (48.6 MB stored, 11.5 MB indexed).
- **Evidence:** `$P/stats.ts`.
- **Fix:** Index tool calls for full-text only (a larger cap, no embedding), or render a compact "Tool Edit path/to/file" line. This cuts the embedding load by about a third.

**B-20 — Minor — Data model — events as one table**
- **Verdict:** Fine as it is through 10M+ rows and 100 GB; TOAST handles it. Do not partition. The global `unique(key)` would block partitioning anyway, which is another reason to consider `(session_id, key)`. Only lz4 (B-15) and immutability (B-8) need doing now.

## Questions for the codebase owner

1. How big is the Zima NVMe, and how much of it may Cerebro use? B-6 and B-15 turn on whether 150–450 GB is available.
2. Is the 20M-chunk target intentional? Local data implies about 3M chunks per 100 GB raw. At 3M, halfvec HNSW is enough; at 20M, binary quantisation or partitioning is needed.
3. May a Mac (with a GPU) act as an embedding worker for imports and re-embeds, or must all embedding stay on Zima? This decides whether B-1 is a design change or only throttling plus patience.
4. Is "raw, word for word" meant to include the original transcript entry metadata (uuids, tool_use_id, model, thinking, subagent linkage)? If yes, B-5 must be done before any data is ingested.
5. For the monorepo case in B-7, should adding a more specific binding offer to move past sessions under it, or is ruling 4 meant to be absolute?
6. When a queued upload targets a since-declined folder, should the data be kept (flagged) or discarded?
7. How will plan 2 derive event keys, and what happens on `claude --resume` or a fork, where a new session id may replay old messages? With a global `unique(key)`, uuid-derived keys would silently drop the replayed events from the new session.
8. Is degraded (full-text only) search acceptable for the multi-day duration of an import, or must semantic search stay available throughout (B-3)?
9. Is a second replica a real near-term plan, or only "should be possible"? This sets the urgency of B-8 and B-14.
