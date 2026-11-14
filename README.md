# Cerebro

Long-lived memory for Claude Code sessions across machines: raw conversations
plus distilled summaries in Postgres/pgvector, scoped by client → project.

Design: `docs/superpowers/specs/2026-11-13-cerebro-design.md`.

## Development

Requires Bun ≥ 1.4 and Docker.

```sh
docker compose -f docker-compose.dev.yml up -d --wait db   # Postgres + pgvector on 127.0.0.1:54329
bun install
bun test
```

Tests create and drop their own throwaway databases on the dev Postgres
(override with `TEST_DATABASE_URL`).

### Server environment

| Variable       | Default  | Meaning                                         |
|----------------|----------|-------------------------------------------------|
| `DATABASE_URL` | required | Postgres connection URL                         |
| `PORT`         | `8790`   | HTTP port                                       |
| `EMBED_URL`    | required to run | Ollama base URL for embeddings           |
| `EMBED_MODEL`  | `bge-m3` | Ollama embedding model                          |
| `EMBED_DIMS`   | `1024`   | Embedding size; must match the schema's vector size |

## Running the server locally

```sh
docker compose -f docker-compose.dev.yml --profile embed up -d ollama
docker compose -f docker-compose.dev.yml exec ollama ollama pull bge-m3
DATABASE_URL=postgres://cerebro:cerebro@127.0.0.1:54329/cerebro \
EMBED_URL=http://127.0.0.1:11435 bun server/src/main.ts
```

Or everything in containers: `docker compose -f docker-compose.dev.yml --profile embed --profile app up -d --build`.

### Machine tokens

Each machine gets its own token; only its SHA-256 hash is stored.

```sh
DATABASE_URL=… bun server/src/cli.ts token create my-macbook   # prints the token once
DATABASE_URL=… bun server/src/cli.ts token list
DATABASE_URL=… bun server/src/cli.ts token revoke my-macbook
```

### API overview

All `/v1` routes need `Authorization: Bearer <token>`. Errors are `{ "error": "<code>", "message": "…" }`;
a revoked token gets `401 token_revoked` (stop retrying, ask the owner), an unknown one `401 unauthorized`.

**Scope.** Every search and read names the folder it comes from (`repo` + `subpath`) or asks for
`scope: "open"` explicitly. A folder whose nearest active binding has a project is locked to that
project; anything else may search all clients. Repo spellings are normalised server-side.

| Method & path | Purpose |
|---|---|
| `GET /health` | `{ok, db, apiVersion, instanceId}` — no auth; clients check `instanceId` before sending data |
| `GET /v1/status` | Calling machine, embed queue (`pending`, `dead`, `oldestPendingSeconds`), embedder state, DB size |
| `GET/POST /v1/clients`, `GET /v1/clients/:id/projects`, `POST /v1/projects` | Clients and projects (create is idempotent by name) |
| `GET /v1/bindings/resolve?repo=&subpath=` | Most specific binding for a folder |
| `PUT /v1/bindings` | Bind or decline a folder; changing an existing binding needs `rebind: true` (moves/holds its history) |
| `PATCH /v1/bindings/:id/identity` | Re-point a binding after a remote rename |
| `POST /v1/bindings/:id/adopt` | Move earlier sessions recorded under a broader binding into this subfolder binding |
| `PATCH /v1/sessions/:id` | Move one session to another active binding |
| `POST /v1/ingest` | Batch of ≤ 2000 events / ≤ 200 sessions (≤ 10 MB). Returns `{sessions, inserted, duplicates, rejected[]}`; bad items are rejected individually, the rest is stored. Event keys are unique per session. |
| `POST /v1/sessions/:id/end` | Mark a session ended (later events reopen it) |
| `POST /v1/search` | Hybrid search → `{scope, binding, hits[], degraded, degradedReasons[]}`; hits carry `matched` (`fts`/`vec`) and `distance` |
| `GET /v1/sessions` | Sessions in scope, newest first (`from`, `to`, `limit`, cursor `before`) |
| `GET /v1/sessions/:id/events` | Raw events in scope (`afterSeq`, `limit` ≤ 1000, `nextSeq`; `full=1` for untruncated tool output, capped at 2 MB per page) |

### Maintenance

```sh
DATABASE_URL=… bun server/src/cli.ts redact <session-id> [regex]   # scrub a leaked secret, rebuild its search index
```

Secrets are redacted at ingest (known key formats, bearer tokens, URL passwords, `*_PASSWORD=`-style
lines). Events are chunked at ingest, so full-text search works immediately; a background worker
embeds chunks (live sessions before imported history) and the vector half of search fills in.

## Install on a Mac

The client ships as a Claude Code plugin from this (private) repo's `plugin-dist` branch.

```sh
gh auth login && gh auth setup-git          # private repo access
claude plugin marketplace add GustavoGomez092/cerebro
claude plugin install cerebro@cerebro       # asks for the server URL and token
```

Create the token on the server with `bun server/src/cli.ts token create <mac-name>`,
outside a recorded Claude Code session.

A folder's past conversations are imported when you opt it in (the cerebro skill asks in
each new folder). Claude Code deletes transcripts after 30 days by default, so once it has
started in any project (the stable link is created at session start), run
`~/.cerebro/bin/cerebro retention`: it only raises how long Claude Code keeps transcripts
(`cleanupPeriodDays`, to 36500 days), so history survives until it is imported. Optionally
run `~/.cerebro/bin/cerebro schedule` to also pick up other agents' history.

Maintainers publish a release with `scripts/release-plugin.sh <version>` (`--dry-run`
to preview, `--remote <url>` to publish somewhere other than `origin`, which must be
this GitHub repo): it compiles the arm64 and x64 binaries and force-pushes `plugin/` (atomically with the tag) as a
single commit on `plugin-dist`, tagged `plugin-v<version>`.

## Deploying to the Zima server

`deploy/zima/deploy.sh [--first-run]` (owner-specific; `ssh zima`) syncs the committed tree,
builds `cerebro-server:<sha7>` on the server, migrates, and switches only after `/health`
reports `ok` and `db` within 60 s. A failed start, a failed health gate or an interrupt (Ctrl-C)
rolls back to `cerebro-server:prev` and exits 1. `deploy/zima/check.sh` prints `ALL OK` or
the failing checks.

**[deploy/zima/README.md](deploy/zima/README.md)** is the runbook: first deploy (Caddy route,
Claude login, tokens, backup timer, zima-backup exclusion), manual rollback, backups and the
restore steps.

- **Migrations must be backward-compatible (expand/contract).** They run before the new
  server starts, and a rollback starts `:prev` on the already-migrated schema; nothing undoes a
  migration. Add columns and tables first, and drop or rename them only in a later release, once
  no deployed code reads them.
- Before migrations the schema hasn't seen, the deploy saves a pre-deploy dump and marks it
  `pending` until migrate succeeds, so a failed or interrupted migrate never loses its recovery
  point to retries. It is never restored automatically.
- `:prev` is always the last release that passed the health gate (`state/deployed`).
