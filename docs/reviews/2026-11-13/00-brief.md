# Cerebro review brief

Repo: /Volumes/Content/projects/Cerebro, branch `feat/server-core` (HEAD 498ecb7). Bun 1.4 + TypeScript, Hono, zod, Postgres 17 + pgvector 0.8 (Bun.sql), Ollama `bge-m3` (1024 dims) for embeddings.

Read first:
- Spec (binding authority): docs/superpowers/specs/2026-11-13-cerebro-design.md
- Plan for what is built so far: docs/superpowers/plans/2026-11-13-cerebro-server-core.md
- Code: shared/src/*, server/src/**, server/migrations/001_init.sql, server/test/**, server/Dockerfile, docker-compose.dev.yml

What exists: plan 1 of 4 (server core: schema, machine tokens, clients/projects/bindings, idempotent ingest, chunker, Ollama/fake embedders, background indexer, scoped hybrid search with RRF, raw reads, entrypoint, Dockerfile). NOT built yet: plan 2 client plugin (hooks, offline queue, secret stripping on the Mac, opt-in skill, recall tools, history import), plan 3 summariser (claude -p Haiku on the owner's subscription, project state, 20% budget), plan 4 Zima deployment (containers, Caddy `cerebro.home.lab`, backups). You may challenge decisions those plans will rely on.

Running things: dev Postgres is up at postgres://cerebro:cerebro@127.0.0.1:54329/cerebro (tests create/drop their own throwaway DBs — you may do the same). Dev Ollama with bge-m3 at http://127.0.0.1:11435. `bun test` (54 pass) and `bun run typecheck` (clean) from the repo root.

RULES: Do NOT modify, add, or commit anything inside the repo. Put any probe scripts/tests in your own scratch dir (given in your prompt) and run them with absolute paths. Other reviewers run concurrently against the same dev Postgres — only touch databases you create.

## Target scale (judge "scalable" against this)
- One owner per install (other people run their own installs). Up to ~10 machines writing concurrently, one of which travels and flushes large offline backlogs on return.
- Raw history kept forever: plan for ~10M events, ~20M chunks, ~100 GB of raw text over years, plus a one-off history import of thousands of sessions at once.
- Server host: Ryzen 5 2400GE (4c/8t), 16 GB RAM shared with ~20 other containers, no GPU, NVMe + a 256 GB USB backup drive. Single container today; a second replica or a separate worker process should be possible later.
- LAN-only behind Caddy (plain HTTP on the LAN), bearer tokens per machine.

## Decisions already taken (challenge them if you have evidence, but know they were deliberate)
1. Scope is derived via sessions.binding_id → bindings; re-binding a folder moves its history by updating one row.
2. Project-bound folder → search locked to that project; client-only / declined / unbound → may search all clients. Enforced server-side in search only; reads by session id are not locked (spec: scope guards accidents, not a misused token).
3. Declining a folder that already has history → 409 (re-bind instead).
4. Sessions recorded before a more specific subfolder binding existed stay with their original binding.
5. tool_result events are stored raw but never chunked/embedded/full-text indexed.
6. No vector similarity cutoff; RRF (k=60) over 50 FTS + 50 vector candidates.
7. Search falls back to FTS-only (`degraded: true`) when the embedder fails or takes >3 s.
8. Indexer is in-process, per-session, capped at 500 events/session/run, exponential in-memory backoff per failing session.
9. NUL bytes replaced with U+FFFD at ingest. Subpaths normalised server-side; ".." rejected.
10. One token per machine, SHA-256 hash stored, `cbr_` + 32 random bytes.

## Known and deliberately deferred (don't re-report unless you think the grade is wrong — then say why)
- Two concurrent indexers can double-index overlapping events (no advisory lock).
- Chunk-key conflict silently drops a chunk when two event keys share a seq.
- Incremental indexing fragments a prompt and its reply into separate chunks.
- normalizeRemote keeps a port as a path segment (ssh://host:2222/… vs https).
- EMBED_DIMS ≠ 1024 not refused at startup; PORT="" becomes random port.
- Overlapping concurrent ingest batches can deadlock (retry succeeds).
- Long-event windows can split an emoji surrogate pair.
- Shutdown doesn't await an in-flight indexer run.

## Output format (return this as your final message)
## Findings
For each: `ID` (e.g. SA-1), **Severity** (Critical / Important / Minor), **Category**, **Where** (file:line or design section), **Scenario** (concrete input/state → bad outcome), **Evidence** (reproduced? how — path to your probe), **Fix** (specific).
## Questions for the codebase owner
Numbered questions about intent or decisions whose answer would change a finding.
Keep it concrete. No padding. Rank most severe first.
