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

All `/v1` routes need `Authorization: Bearer <token>`.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness + DB check (no auth) |
| `GET /v1/status` | Calling machine, events waiting to be indexed |
| `GET/POST /v1/clients`, `GET /v1/clients/:id/projects`, `POST /v1/projects` | Clients and projects (create is idempotent by name) |
| `GET /v1/bindings/resolve?repo=&subpath=` | Most specific binding for a folder |
| `PUT /v1/bindings` | Bind / re-bind / decline a folder (re-binding moves its history) |
| `PATCH /v1/bindings/:id/identity` | Re-point a binding after a remote rename |
| `POST /v1/ingest` | Idempotent batch of sessions + events |
| `POST /v1/sessions/:id/end` | Mark a session ended |
| `POST /v1/search` | Hybrid search; a project-bound `repo` locks results to that project |
| `GET /v1/sessions` | List sessions (filters: clientId, projectId, from, to, limit) |
| `GET /v1/sessions/:id/events` | Raw events (fromSeq, toSeq, `full=1` for untruncated tool output) |
