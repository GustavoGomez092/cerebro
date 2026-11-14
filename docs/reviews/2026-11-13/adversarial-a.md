## Findings

### SA-1 — **Critical** — Scale / search correctness
**Where:** `server/src/search.ts:60-70`; `server/migrations/001_init.sql:81`
**Scenario:** Project-locked search is the main recall path. The vector half filters after the HNSW scan, which gives up at pgvector's default `hnsw.max_scan_tuples` (20,000). A project holding a small share of the corpus gets almost no vector candidates, and a narrow date window does the same in open scope.
**Evidence:** Reproduced with `p10_scale.ts` (output in `p10.log`):

| Scope | Vector candidates returned | Latency |
|---|---|---|
| Project with 100 of 300k chunks (0.03%) | 1–2 of 50 (it has 100) | 1.0–2.9 s, ~58k buffers |
| Open scope, 1-day window | 2–4 of 50 | ~110 ms |
| Project with 5,000 chunks (1.67%) | 50 of 50 | ~70 ms |

Extrapolated: at 20M chunks, expected candidates are roughly 20,000 × the scope's share. A 10k-chunk project gets about 10, a 1k-chunk project about 1, and it pays the full 20k-tuple scan each time. Real embeddings may correlate with project, which would soften this.
**Fix:** Denormalise `binding_id` onto chunks. Scopes below a threshold (say 50k chunks) get an exact scan over `(binding_id)`; larger ones use HNSW, optionally with raised `ef_search` / `max_scan_tuples`. Count candidates and fall back to exact when fewer than 50 come back.

### SA-2 — **Critical** — Scale / storage
**Where:** `server/migrations/001_init.sql:77,81` (`embedding vector(1024) not null` plus HNSW)
**Scenario:** At 20M chunks the embedding storage alone outgrows the plan, and nothing about it can be changed cheaply later.
**Evidence:** Measured with `fill2.sql` (`fill2.log`): 300,100 chunks came to 4.5 GB — 2.35 GB HNSW (7.8 KB per chunk), 1.79 GB TOAST, 199 MB heap, 152 MB GIN. A serial HNSW build took 3 min 47 s. Inserting into a live HNSW index managed only about 20% of the rows in 5.5 minutes, under load, with near-random vectors.
- **Extrapolated to 20M chunks:** about 155 GB of HNSW plus about 120 GB of TOAST, roughly 300 GB before the 100 GB of raw text.
- **Memory:** the index cannot fit in 16 GB shared RAM, so every search and every insert does random I/O.
- **Rebuilds:** a reindex or model change means multi-day builds on the 2400GE.
- **Backups:** a `pg_dump` with vectors as text will not fit the 256 GB backup drive.
**Fix:** Decide before data accumulates:
- Use `halfvec(1024)` for the column and index (about half the size), or binary quantisation with rerank.
- Move embeddings to their own table, `chunk_embeddings(chunk_id, model, embedding)`, so a model or dimension change is additive.
- Exclude or separately handle embeddings in backups.
- Benchmark on the real host.

### SA-3 — **Important** — Data loss / ingest
**Where:** `server/src/ingest.ts:21-53`; `server/src/http/routes/ingest.ts:9-27`
**Scenario:** One bad item fails the whole batch with a 500 or 422 that does not name the offending event. The offline queue then retries the same batch forever, blocking everything behind it on that machine.
**Evidence:** Reproduced with `p1_poison.ts`:
- A lone surrogate in `toolInput` (a string truncated mid-emoji) gives a jsonb error and a 500; the 5 good events in the batch are rolled back.
- NUL in `toolName`, `key` or `cwd` gives a 500. Ruling 9 only covers `text` and `toolInput`.
- `ts` of `0000-01-01T00:00:00Z` passes zod and gives a 500.

By inspection, not run: a single session whose binding was declined while the laptop was offline returns 422 for the entire batch, including other sessions' events.
**Fix:**
- Sanitise every string: NUL everywhere, and `toWellFormed()` on `toolInput` strings.
- Bound `ts`.
- Return per-item rejections (`rejected: [{key, reason}]`) and commit the rest, or use savepoints.
- Never answer 5xx for a data-shaped error.

### SA-4 — **Important** — Search quality
**Where:** `server/src/search.ts:62-63`; `001_init.sql:76` (`'simple'` config, `websearch_to_tsquery`)
**Scenario:** The full-text half ANDs every word, with no stop-word removal and no stemming. Natural questions return nothing from full text, which makes the degraded mode nearly useless.
**Evidence:** Reproduced with `p4_search.ts`, embedder down, one chunk stored about a staging login fix in `auth/cookies.ts`:

| Query | Hits |
|---|---|
| `staging login` | 1 |
| `how did we fix the login bug on staging?` | 0 |
| `cookies.ts` (the stored text has `auth/cookies.ts`) | 0 |
| `cookies` | 0 |
| `fixing` | 0 |

File names are unsearchable unless the full path is typed, because the parser treats the path as one token.
**Fix:**
- Build an OR query, ranked with `ts_rank_cd`, dropping stop words.
- Index a second tsvector with paths and identifiers split on `/ . _ -` and camelCase.
- Consider `pg_trgm` for identifiers.

### SA-5 — **Important** — Availability / search
**Where:** `server/src/indexer.ts:29-57`; `server/src/search.ts:34`; `001_init.sql:77`
**Scenario:** Indexing and search share one CPU Ollama. During any backlog, query embeddings queue behind batch embeds and miss the 3 s timeout, so every search is degraded for the whole backlog (days for an import). Separately, a chunk cannot exist without its vector, so text ingested while the embedder is down is not full-text searchable either.
**Evidence:**
- **Contention (`p9_embed.ts`):** with the dev Ollama saturated (8 cores, partly by other reviewers), single-query embeds took 6.5–93 s. That shows the direction; it is not a clean number.
- **Coupling (`p4_search.ts`):** reproduced — an ingested event was unfindable by exact word while the embedder was down.
**Fix:**
- Write chunks and tsv at ingest or index time with a nullable or separate embedding, and embed asynchronously.
- Give query embeds priority: a separate Ollama instance or slot, or pause the indexer while a search is in flight.
- Cache query vectors.

### SA-6 — **Important** — Indexer starvation
**Where:** `server/src/indexer.ts:29-32` (`order by min(id) limit 20`)
**Scenario:** Order is strictly oldest event first. A history import of thousands of sessions lands ahead of live sessions, so today's conversation is not searchable until the import finishes. `sessions.imported` exists but is not used for priority.
**Evidence:** By inspection. Supporting numbers from `p8_indexer.ts`:
- The pending query seq-scans `events` on every tick during a backlog: 71k buffers and 160–220 ms at 1M small events. At 10M real events that is a multi-GB scan per tick.
- `/v1/status` runs `count(*)` over the same set.
**Fix:**
- Order by `imported asc`, then newest activity.
- Keep a small `index_queue(session_id, priority, next_attempt_at)` table, or a per-session `indexed_through` watermark, instead of a per-event flag.
- A queue table also persists backoff and allows `FOR UPDATE SKIP LOCKED` for a second worker.

### SA-7 — **Important** — Indexer progress / poison sessions
**Where:** `server/src/indexer.ts:36-63`
**Scenario:** A run is all-or-nothing over up to 500 events with no bound on chunk count. One chunk the embedder rejects blocks the entire session forever, including every later event, with retries every 10 minutes. One timeout late in a big run discards everything embedded so far, and so does a restart.
**Evidence:** Reproduced with `p8_indexer.ts`:
- **A:** one poison event among 81 left 0 chunks and 81 unindexed events after 3 runs.
- **B:** 500 events of 30 KB each embedded 9,008 texts, then failed, with 0 chunks committed.
**Fix:**
- Commit per embed batch.
- Cap a run by chunks or characters, not events.
- On a batch failure, bisect to the single offending chunk, store it without a vector or mark it failed, and continue.
- Persist the failure count and surface it in `/v1/status`.

### SA-8 — **Important** — Ingest throughput / pool starvation
**Where:** `server/src/ingest.ts:41-48` (one INSERT round trip per event); `server/src/db.ts:10` (default pool)
**Scenario:** A returning laptop or an import flushes large batches. Each holds a pooled connection in a long transaction, and ten of them stall every other request, including auth, `/health` and search.
**Evidence:** Reproduced with `p6_ingest.ts` and `p7_http.ts`:

| Case | Time |
|---|---|
| 5k-event batch | 4.4 s |
| Replay of the same batch (all duplicates) | 5.5 s |
| 50k tiny events (5.2 MB body) over HTTP | 46–52 s per request |
| 10 concurrent 5k batches | 8.6 s, during which `select 1` on the shared pool waited 8.5 s |

The 50k request did complete server-side; Bun's 30 s `idleTimeout` did not cut it. The array has no count cap. Expect 2–4× worse on the 2400GE.
**Fix:**
- One multi-row insert per batch: `insert … select from unnest(...) on conflict do nothing returning key`.
- Cap events per batch (for example 2,000).
- Compute `last_event_at` as `greatest(last_event_at, batch max)` instead of `max(ts)` over the session.
- Use a separate small pool, or a concurrency limit, for ingest.

### SA-9 — **Important** — Scale / query plans
**Where:** `server/src/search.ts:54-63`; `001_init.sql:79-80`
**Scenario:** Two plans grow linearly with the corpus.
**Evidence:** `p10_scale.ts` at 300k chunks:
- **Full text, common term:** ranks every match with `ts_rank` and detoasts each tsv. Open scope took 715–909 ms with 2.4M buffer hits; big-project scope took 960 ms. Extrapolated to 20M chunks: about a minute warm on this Mac, worse cold on the server.
- **Project plus date window:** the planner walks every chunk of the project through `chunks_session_idx` and filters on timestamps. That was 130k buffers (about 1 GB) to find 2,400 rows, in 130–230 ms.
**Fix:**
- Index `(binding_id, ts_from)` once `binding_id` is denormalised, or `(session_id, ts_from)`.
- Pre-filter sessions by `started_at` / `last_event_at` for date ranges.
- Bound full-text work, for example rank only the most recent N matches, or use a rank-capable index (RUM, ParadeDB/BM25).
- Set `statement_timeout` on search.

### SA-10 — **Important** — Reads / memory
**Where:** `server/src/read.ts:40-50`
**Scenario:** `GET /sessions/:id/events` has no limit and selects the full `text` of every `tool_result` before truncating to 2,000 characters in JavaScript. One long session can exhaust memory on the shared host.
**Evidence:** Reproduced with `p6_ingest.ts`:
- A session with 3,000 tool results of 200 KB took 8.1 s and grew RSS by 627 MB to return 6 MB.
- A 350k-event session returned all rows in one response.
**Fix:** Truncate in SQL (`left(text, 2001)` unless `full`), and require pagination: a default limit of about 200 with a `nextSeq` cursor, and a byte cap on `full=1`.

### SA-11 — **Important** — Migrations / startup
**Where:** `server/src/db.ts:14-28`
**Scenario (a):** Two processes starting together both try to apply 001, and one exits.
**Scenario (b):** Each migration runs inside one transaction before the server listens. That rules out `create index concurrently`, and any index or column change on the 100 GB+ tables takes locks and keeps the whole service down for the duration, including ingest.
**Evidence:** (a) reproduced with `p5_migrate.ts`: one of two concurrent `migrate()` calls failed in 5 of 5 trials (`pg_extension_name_index` / `pg_type_typname_nsp_index` duplicate key). (b) by inspection, with the build times from SA-2.
**Fix:**
- Take `pg_advisory_lock` around `migrate()`.
- Support a `-- no-transaction` marker for concurrent index builds.
- Run long backfills as a background job and keep ingest serving meanwhile.
- Set `lock_timeout`.

### SA-12 — **Minor** — Bloat
**Where:** `001_init.sql:62,65`; `server/src/indexer.ts:56`
**Scenario:** Flipping `events.indexed` rewrites every event row once. It cannot be a HOT update because the column is in a partial-index predicate.
**Evidence:** `p8_indexer.ts`: marking 334k events grew the heap by 196 MB (on 591 MB) and indexes by 24 MB.
**Fix:** The queue or watermark from SA-6.

### SA-13 — **Minor** — Search ranking
**Where:** `server/src/search.ts:60,70,75`
**Scenario:** Vector candidates are 50 with the default `ef_search` of 40 and `relaxed_order`, and row order is used as the RRF rank. Full-text ties have no tie-break.
**Evidence:** `p10_scale.ts`: unfiltered recall against the exact top 50 was 30–38 of 50. The synthetic clusters are hard, so real data will likely do better.
**Fix:** `set local hnsw.ef_search = 100`, re-sort candidates by distance before ranking, and add `, c.id` to the full-text order.

### SA-14 — **Minor** — Date filter and limits
**Where:** `server/src/search.ts:55,29`; `server/src/read.ts:24`
**Scenario:**
- A `to` sent as midnight of a day excludes that whole day (`p4_search.ts`: 0 hits for events at 10:00).
- An inverted `from`/`to` silently returns nothing.
- Search has no offset or cursor past 50.
- Sessions list has no cursor and no `started_at` index, which is fine at 3k sessions.
**Fix:** Document or accept date-only `to` as end of day, return 400 when `from > to`, and add cursors.

### SA-15 — **Minor** — `last_event_at` race
**Where:** `server/src/ingest.ts:50`
**Scenario:** Two concurrent batches for one session, sent without a `sessions[]` entry, can leave `last_event_at` behind the true maximum. That column gates the binding/cwd overwrite and the sessions date filter.
**Evidence:** Not reproduced: 0 of 15 trials in `p2_race.ts`. The window is sub-millisecond, and batches that include the session row are serialised by its lock.
**Fix:** The `greatest(...)` change in SA-8.

## Questions for the codebase owner

1. What is the event `key` in plan 2? If it derives from Claude Code's message UUID, resumed or forked sessions that copy earlier messages will have them dropped as global-key duplicates, leaving the new session with holes. If a hook can read a half-written transcript line, the truncated first version wins forever, because `on conflict do nothing` never updates.
2. How large is the NVMe on the server, and is losing embeddings in a restore acceptable given they can be recomputed, slowly? That decides between halfvec and excluding vectors from backups (SA-2).
3. Has `bge-m3` been benchmarked on the 2400GE in chunks per second? If it is around 1–2, a first import of thousands of sessions is days of full CPU on a host shared with 20 containers. Would a smaller model, or 512 dimensions, be acceptable?
4. Should live sessions be searchable within seconds while an import is running (SA-6), or is "eventually" enough?
5. Is semantic recall inside small or new projects a requirement at year-five scale? If small scopes can rely on full text alone, SA-1 drops to Important, but then SA-4 must be fixed.
6. What happens to a single event over 10 MB, such as a huge tool result or an inline image? Today it gets a 413 forever. Should the client truncate, or should the server accept and trim?
7. When a session is resumed after `/sessions/:id/end`, should `ended_at` clear? The summariser will presumably trigger on it.
8. Will the client always include the `sessions[]` entry in every batch, and will it mix several sessions in one batch? That sets the blast radius of SA-3 and whether SA-15 can occur.
