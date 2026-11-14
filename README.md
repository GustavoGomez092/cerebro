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
