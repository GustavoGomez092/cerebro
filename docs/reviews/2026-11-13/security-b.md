## Findings

Probes are in `/private/tmp/claude-501/-Volumes-Content-projects-Cerebro/b14abdbd-98d6-4749-9a6f-829bfb486107/scratchpad/review/sec-b/`. I ran the real `server/src/main.ts` against my own databases, which are now dropped; nothing in the repo was touched.

One caveat on all Ollama timings: the dev Ollama was shared with other reviewers and CPU-only in Docker, so absolute numbers are inflated. The queueing behaviour they show is still real.

**SB-1 — Important — Resource exhaustion / availability**
- **Where:** `server/src/search.ts:30-44`, `server/src/indexer.ts:43-46`, `server/src/embed/ollama.ts:7`
- **Scenario:** Indexer batches and search-query embeddings share one Ollama queue with no priority. While the indexer is embedding, a query embedding waits behind it and misses the 3 s timeout, so search returns `degraded: true` for the whole duration of a history import or backlog flush. The timed-out fetch is not aborted (`Promise.race` only), so each degraded search leaves a request in Ollama's queue for up to 120 s.
- **Evidence:** Reproduced with `embed_probe.ts batch`. A 7-token query sent 100 ms after one 8×1600-char batch took 36.4 s. A batch of 8 prose chunks took 32 s. With other reviewers' load, single-token queries took 42–62 s.
- **Fix:**
  - Pass an `AbortSignal` into `embed()` so the search timeout cancels the request.
  - Give queries priority: a second Ollama instance or slot for queries, or have the indexer send one chunk at a time and yield while a query is pending.
  - Set `keep_alive: -1` on embed calls. `/api/ps` showed the default 5-minute unload; a cold load cost 1.8 s here and will be slower on the 2400GE, so the first search after idle risks the 3 s limit too (not measured on target).

**SB-2 — Important — Resource exhaustion / indexer livelock**
- **Where:** `server/src/indexer.ts:42-57`, `server/src/embed/ollama.ts:7`, `server/src/http/routes/ingest.ts:23`
- **Scenario:** A session is embedded all-or-nothing: every chunk of up to 500 events is embedded, vectors are held in memory, then one transaction commits. Any single failed or timed-out batch discards all of it. Token-dense chunks (base64, CJK, emoji, minified JSON) cost about 3.5× the tokens of prose, so a batch of 8 can exceed the 120 s timeout on a slow CPU. That session then fails forever, retried every 10 minutes at most, burning CPU each time. Backoff state is lost on restart. Separately, `text` has no cap: one 9.9 MB user event becomes 7,415 chunks and 927 sequential embed calls.
- **Evidence:**
  - `embed_probe.ts batch`: 8×1600 base64 took 104 s; 8×1600 CJK took 122 s (over the timeout); 8×800 emoji took 128 s. These are contended numbers.
  - `chunk_probe.ts`: chunk counts for 0.1, 1 and 9.9 MB events.
  - The discard-on-failure path is from reading the code, not run end to end.
- **Fix:**
  - Commit progress per embed batch (insert chunks and mark their events indexed), so a failure loses one batch.
  - Size batches by character or token budget rather than a fixed 8, and scale the timeout to match.
  - Cap indexable text per event (for example the first 20–50k characters); raw text stays in `events`.
  - After N failures, mark a session quarantined in the database and report it in `/v1/status`.

**SB-3 — Important — Resource exhaustion / pool starvation**
- **Where:** `server/src/ingest.ts:21-53`, `server/src/db.ts:10`, `server/src/http/routes/ingest.ts:9-27`
- **Scenario:** Ingest does one INSERT round trip per event inside one transaction, holding a pooled connection throughout. There is no cap on events or sessions per batch, only the 10 MB body limit. The pool is Bun.sql's default of 10. Ten machines flushing at once is the stated target, and that stalls every other route, including `/health` and token verification.
- **Evidence:**
  - `big.ts many 80000`: a 9.97 MB batch of 80,000 events took 77.6 s; replaying it as pure duplicates took 76.9 s.
  - `big.ts pool 12`: 12 concurrent 12,000-event batches made `/health` take 13.6 s. One `/v1/status` call during the same run returned in 35 ms, probably because it grabbed a connection before the pool filled.
- **Fix:**
  - Cap events (about 1–2k) and sessions per batch in zod, and return 413 so the client splits.
  - Insert in multi-row statements (`unnest` or `sql(rows)` with `on conflict do nothing returning key`) and replace the per-session `update … max(ts)` loop with one statement.
  - Set the pool size explicitly and keep ingest concurrency below it with a small semaphore.
  - Set `statement_timeout` and `idle_in_transaction_session_timeout` on the connection.
  - If plan 4 uses `/health` as the container healthcheck, it must not queue behind ingest.

**SB-4 — Important — Malformed input / poison batch**
- **Where:** `server/src/ingest.ts:11-17, 27-28, 44-45`, `server/src/http/routes/ingest.ts:8-26`, `server/src/http/routes/search.ts:10`
- **Scenario:** Several inputs pass zod but Postgres rejects them, so the whole batch rolls back with a bare 500. An at-least-once client queue will retry a 500 forever, blocking that machine's uploads behind one bad event — the spec's "lost memory" anti-goal. The NUL fix only covers `text` and `toolInput`.
- **Evidence:** Reproduced with `poison.ts`; all of these returned 500:
  - A lone surrogate inside `toolInput` (jsonb rejects it; the same character in `text` is accepted). This is the realistic one, since JS truncation can split an emoji.
  - `ts` or `startedAt` of `0000-01-01T00:00:00Z` (zod accepts year 0000, Postgres does not).
  - NUL in `key`, `toolName`, `cwd`, session id, binding `repo`, client name, the `:id` path parameter, and the search `query`.
  - `toolInput` nested 20,000 or more levels deep.
- **Fix:**
  - Add a shared zod refinement that rejects or cleans NUL in every string field, and restrict the year range on timestamps.
  - Sanitise lone surrogates in `cleanDeep` (`toWellFormed()`) and limit nesting depth.
  - Map Postgres class-22 errors to 422 with the offending event `key`, so the client can drop or quarantine one event. Plan 2 should treat 4xx as do-not-retry.

**SB-5 — Important — Resource exhaustion / memory**
- **Where:** `server/src/read.ts:40-50`, `server/src/indexer.ts:36-38`
- **Scenario:** `GET /v1/sessions/:id/events` has no pagination and fetches full `text` for every row, truncating `tool_result` to 2,000 characters in JS afterwards. The indexer also selects `text` for `tool_result` rows it never indexes, up to 500 events per session, and reloads them on every retry. On a memory-limited container this is an OOM kill that takes ingest down with it.
- **Evidence:**
  - `big.ts fat 150` (150 × 1 MB tool results): the default preview read took 2.2 s to return 318 KB; three concurrent reads pushed RSS from 294 to 561 MB; `full=1` returned 150 MB and RSS reached 971 MB.
  - `idxmem.ts` (one 21-byte user event plus 300 × 1 MB tool results, embedder down): RSS went from 39 to 356 MB and the data was re-read on each retry.
- **Fix:**
  - In the read path, select `left(text, 2000)` and `length(text) > 2000` in SQL unless `full` is set.
  - Require a limit with a seq cursor (default about 200 events), and add a byte budget for `full=1`.
  - In the indexer, select `case when kind = 'tool_result' then '' else text end`, or filter those rows out and mark them indexed with a separate UPDATE.

**SB-6 — Important at target scale — Search cost**
- **Where:** `server/src/search.ts:59-63`, `server/src/db.ts:10`
- **Scenario:** The full-text leg computes `ts_rank` for every matching chunk before `limit 50`. The `simple` config has no stop words, so a one-word query like "error" or "the" matches a large share of the corpus. No statement timeout exists and each search holds a pooled connection in a transaction, so a few such queries combine with SB-3.
- **Evidence:** `scale.sql` on 100k synthetic chunks: 30k matches ranked in 373 ms, 100k matches in 481 ms, warm cache and parallel scan. Scaled linearly to 20M chunks that is roughly 75–95 s per query; the extrapolation is mine, not measured.
- **Fix:** `set local statement_timeout` (about 5 s) in the search transaction and return the vector-only result as degraded on timeout. Longer term, bound the ranked set, or use a stop-word config or a BM25-style index.

**SB-7 — Minor — Supply chain / container**
- **Where:** `server/Dockerfile:2, 8-9`, `.dockerignore`, `docker-compose.dev.yml:15`, README (`ollama pull bge-m3`)
- **Scenario and evidence** (read from the files; the image was not built):
  - `FROM oven/bun:1.4` is a floating tag with no digest, so a rebuild on Zima can pull a different runtime.
  - `bge-m3` is pulled as `:latest`; a changed upstream model would silently make stored vectors incompatible. The digest today is `790764642607…`.
  - `.dockerignore` omits `.env` and `*.local`, so a future `server/.env` would be baked into the image by `COPY server server`.
  - No `HEALTHCHECK`, and no `--no-install` guard against Bun's runtime auto-install.
  - The dev Ollama service has no volume, so the model is re-downloaded when the container is recreated.
- **Checked and fine:** `--frozen-lockfile --production`; only two runtime dependencies (hono 4.13.18, zod 4.6.7) with integrity hashes and no transitive ones; `USER bun` with root-owned code; dev ports bound to 127.0.0.1.
- **Fix:** Pin the base image by digest (the slim variant is enough), pin the model digest or check it at startup, add `.env*` and `*.local` to `.dockerignore`, run `bun --no-install`, and add a healthcheck.

**SB-8 — Minor — Observability / embedder trust**
- **Where:** `server/src/http/app.ts:17-21`, `server/src/http/routes/status.ts`, `server/src/embed/ollama.ts:27-28`, `server/src/indexer.ts:59-64`
- **Scenario:**
  - If Ollama is down or the model is missing, `/health` stays 200 and `/v1/status` shows only a growing count. Nothing reports embedder state or failing sessions.
  - With the embedder down, the indexer logs one line per session per retry indefinitely and re-reads each session's events every time; there is no circuit breaker.
  - Vector values are not checked for finiteness. A null or NaN from Ollama becomes a Postgres cast error, which in search is a 500 rather than a degraded result.
  - Unhandled Postgres errors are logged in full by Hono's default handler; the json error's `detail` can echo a fragment of conversation text.
- **Evidence:** `server_main.log` shows the repeated per-session failure lines with the embedder down. The NaN path is from reading the code.
- **Fix:** Report embedder reachability, last success and failing-session count in status. Add one breaker for "embedder down" instead of per-session backoff. Check `Number.isFinite` on vectors. Add an `app.onError` that logs code and message only.

**SB-9 — Minor — Limits**
- **Where:** `server/src/main.ts:21`, `server/src/ingest.ts:36`, `server/src/db.ts:14-27`
- **Scenario:**
  - Non-ingest routes accept and parse bodies up to 11 MB; a 10.5 MB `/v1/search` body returned 200 (`poison.ts`). A 64 KB limit on those routes would do.
  - `where id in ${tx(sessionIds)}` expands to one parameter per id, so it fails above 65,535 distinct sessions and creates a distinct prepared statement per array length. Use `= any($1::text[])`. Not run.
  - `migrate()` has no advisory lock and `cli.ts` also runs it, so a CLI call racing server start, or a second replica, can fail startup. Not run.

**Checked and clean**
- No SQL injection found. Every `sql.unsafe` interpolates only constants (`COLS`, `CANDIDATES`), a clamped `parseInt` limit, or `$n` placeholders.
- LIKE escaping in `resolveBinding` is correct for `%`, `_` and `\`.
- `websearch_to_tsquery` accepted every hostile query string without error.
- `__proto__` keys in `toolInput` do not pollute prototypes.
- A 300k-key `toolInput` is handled in 438 ms.
- Stalled and trickled request headers are closed by Bun after about 12 s (`slow.ts`); the 3,000-idle-socket part of that probe did not open any sockets, so it shows nothing.
- An 80,000-event read without `full` returns in 81 ms; the read problem is text volume, not row count.

## Questions for the codebase owner

1. What will the plan-2 client do on a 500 versus a 4xx from `/v1/ingest`, and what batch size and request timeout will it use? SB-4 drops to Minor if the client quarantines a failing batch, and SB-3 changes if batches are capped client-side at a few hundred events.
2. Will the Cerebro container get a memory limit on Zima, as most of the other containers presumably do? SB-5 is an OOM kill with a limit and "only" memory pressure on the other services without one.
3. Is Ollama dedicated to Cerebro on Zima, and can it be configured (`OLLAMA_NUM_PARALLEL`, `keep_alive`, a second instance)? That decides which fix for SB-1 is cheapest.
4. Has bge-m3 throughput been measured on the 2400GE itself? I saw roughly 4 s per 1600-character chunk under contention here. Even at 1 chunk/s, a one-off import of about 1M chunks is around 12 days of saturated CPU on a shared box, and 20M chunks is not reachable. If the real number is close to that, the import needs a different plan (throttled, embedded off-box on a Mac, or full-text first).
5. Is `full=1` on the events read meant for whole sessions, or only for narrow seq ranges around a search hit? If the latter, a hard cap on range and bytes is the simple fix for SB-5.
6. Is search expected to stay usable during the initial history import? If degraded full-text-only search for those days is acceptable, SB-1 drops to Minor apart from the missing abort.
