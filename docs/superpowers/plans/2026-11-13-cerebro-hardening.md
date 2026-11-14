# Cerebro Server Hardening Plan

> Executed inline (superpowers:executing-plans), TDD per workstream. Source: `docs/reviews/2026-11-13/` — four reviews plus the pro-codebase verdicts, whose "Consolidated fix list" this plan implements. Owner said "fix everything"; owner decisions take the advocate's recommended defaults (listed below).

**Goal:** Make the server core robust and scalable before any data exists: reshape the schema, harden the ingest contract, replace the indexer with a durable embed queue, fix search recall/quality/cost, enforce scope on reads, and tidy auth/errors/ops.

**Spec:** `docs/superpowers/specs/2026-11-13-cerebro-design.md`

## Owner decisions (defaults taken)
1. Embedding capacity: full-text immediately, semantic fills in; embedder throttled on Zima (plan 4); queue leaves a remote worker possible, not built.
2. Uploads for a since-declined folder: kept, but sessions under a declined binding are *held* — excluded from search and listings until re-bound.
3. Monorepo adoption: server exposes `POST /v1/bindings/:id/adopt`; the skill offers it (plan 2); never automatic.
4. Raw includes transcript metadata: `events.meta` / `sessions.meta` (unknown fields pass through). Image bytes / >8 MB events are the client's job (plan 2).
5. Disk: `/v1/status` reports database size; backup scheme is plan 4.
6. Off-LAN: `/health` publishes an `instanceId`; the plugin preflights it (plan 2).

## Global constraints
- `001_init.sql` is rewritten in place (no data exists yet).
- Every commit ends with `Claude-Session: https://claude.ai/code/session_01LTKLaRsEuQTEb2o763vgdu`.
- `bun test` and `bun run typecheck` green at the end of each workstream.

## W1 — Schema reshape (before data)
`settings` (one row: instance_id, embed_model, embed_dims); `machines.last_used_at`; `binding_history`; `sessions.repo/subpath/meta` + `started_at` index; `events` unique `(session_id, key)`, `meta`, lz4 text, no `indexed`; `chunks` without embedding, `extra_terms`, tsv on custom `cerebro` config (simple + unaccent), `ts_from` index; `chunk_embeddings(chunk_id, halfvec(1024))` + HNSW; `embed_queue(chunk_id, priority, attempts, next_attempt_at, locked_until, last_error, dead)`; DB-level `statement_timeout`/`idle_in_transaction_session_timeout`. Startup refuses a model/dims mismatch.
Tests: same key in two sessions stores both; model mismatch refused.

## W2 — Ingest contract
Sanitise every string (NUL → U+FFFD, `toWellFormed`), server-side secret redaction (shared `redactSecrets`), year bounds, toolInput depth ≤ 64, per-item `rejected[]` with the rest committed, ≤ 2000 events / ≤ 200 sessions per batch (413), one `unnest` insert sorted by key, chunk new events in the same transaction and enqueue (priority 0 live / 1 imported), `greatest()` for `last_event_at`, clear `ended_at` on later events, unknown fields → `meta`, `repo`/`subpath` on sessions (normalised), `path:<other machine>:` rejected, declined binding accepted-and-held, ingest concurrency semaphore. `cli.ts redact` re-writes a session and re-chunks it.
Tests: poison inputs rejected per item; replay creates nothing; secrets redacted; held sessions invisible to search.

## W3 — Embed worker (replaces indexer)
Lease-based claim (`locked_until`, `for update skip locked`), live before imported, char-budgeted batches committed per batch, failing batch retried item by item, attempts persisted with backoff, dead-letter after 5, global pause when the embedder is unreachable, yields to searches via an in-process gate, finite-vector check, 32k indexable chars per event.
Tests: poison chunk dead-letters while others embed; two workers never embed the same chunk; live before import; restart keeps attempts.

## W4 — Search
Require `repo` or `scope:"open"`; echo resolved binding; nearest *active* ancestor decides scope; exact kNN (materialised) when the scope has ≤ 50k embedded chunks, else HNSW (`ef_search` 100, re-sorted); query embed with AbortSignal + gate; FTS = stop-word-filtered AND, falling back to OR-prefix, ranking bounded to the newest 5000 matches, each leg in its own transaction with a statement timeout and its own degraded flag; tie-breaks; hits carry `matched` and `distance`; parts of one event collapsed; `from > to` → 400; only active bindings searched.
Tests: small project among many returns full vector candidates; natural-language and path queries match; timed-out embed aborts its fetch.

## W5 — Scope & read API
Server-side identity normalisation everywhere; `GET /v1/sessions` and `/events` take `repo`/`subpath` or `scope=open`, locked scope filters and 404s foreign sessions; events paginated (`limit` ≤ 1000, `afterSeq`, `nextSeq`), tool_result truncated in SQL, `full=1` byte-capped; `PATCH /v1/sessions/:id`; `POST /v1/bindings/:id/adopt`; re-binding an existing binding needs `rebind: true`, all changes recorded in `binding_history`.
Tests: every remote spelling stays locked; locked list/read hide other projects; big tool results read without loading them.

## W6 — Auth, errors, ops
Error envelope `{error, message}` + `onError` (no user content in logs, pg class 22 → 422); `token_revoked`; `/health` returns `ok:false` on DB failure plus `apiVersion` and `instanceId`; JSON access log; `last_used_at` (≤ 1 write/min); migrations under an advisory lock with `-- no-transaction` support; 64 KB body limit outside ingest; `.dockerignore` `.env*`; `bun --no-install`; token-create warning.
Tests: concurrent migrate both succeed; revoked token code; health on DB failure.

## Out of scope here (later plans)
Plan 2: key scheme (`<entry uuid>:<block>`), complete-line reads, batch split/bisect, health preflight, client-side redaction, real-path subpaths, adoption offer, oversize events. Plan 3: summary provenance and re-generation on re-bind. Plan 4: bge-m3 benchmark on the 2400GE (gates plan 2's import), Ollama thread cap/keep_alive, memory limits, shm_size, Postgres tuning, backups with embeddings separate, image digest pin, healthcheck.
