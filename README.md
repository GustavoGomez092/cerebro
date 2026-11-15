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
| `EMBED_URL`    | required to run | Ollama base URL for embeddings; with `EMBED_MACHINE_URLS`, the fallback and the Ollama for unmapped machines |
| `EMBED_MACHINE_URLS` | unset | `name=url,name=url`: machine-token name → that machine's own Ollama (e.g. `mac-mini=http://192.168.4.42:11434,macbook-pro=http://192.168.4.45:11434`). Each machine's chunks, summaries and searches embed there; one Mac's work never goes to another. Unset: `EMBED_URL` for everything. See deploy/zima/README.md |
| `EMBED_MODEL_DIGEST` | unset; required with `EMBED_MACHINE_URLS` | bge-m3's digest (12-hex `ollama list` ID or the full sha256). The `EMBED_URL` Ollama must serve it, or no machine endpoint is used; a machine endpoint is not used while its digest differs |
| `EMBED_MODEL`  | `bge-m3` | Ollama embedding model                          |
| `EMBED_DIMS`   | `1024`   | Embedding size; must match the schema's vector size |
| `SUMMARISER_ENABLED` | `true` | `false`, `0`, `no` or `off` (any case) turns the summary loop off; `true`, `1`, `yes`, `on` keep it on; any other value stops the server at startup |
| `SUMMARISER_CMD` | `claude` | The Claude Code CLI to run (`claude -p`, the owner's subscription login; API-key variables are removed from its environment) |
| `SUMMARY_SHARE` | `0.2` | Share of the 5-hour window the summariser may spend |
| `SUBSCRIPTION_TOKENS_PER_5H` | `2000000` | Tokens the subscription allows per rolling 5-hour window; the summariser's budget is `SUMMARY_SHARE ×` this |
| `SUMMARISER_WORKERS` | `1` | Summariser loops running at once (1–8): one primary, the rest only summarise sessions (leased claims, never the same one twice); each runs its own `claude` CLI (~250 MB) |
| `CHAT_MODEL` | `sonnet` | Model for the dashboard's chat agent (`claude -p --model`; an alias or id, one word) |
| `CHAT_TIMEOUT_MS` | `300000` | A chat answer is killed after this long |
| `CHAT_MAX_CONCURRENT` | `1` | Chat answers at once (1 or 2); one more gets `429 chat_busy` |

#### Summariser cost (measured 2026-11-14, `claude-haiku-5-5`)

| Call | Tokens | Wall time |
|---|---|---|
| Minimal summary (a few lines) | 4 467 | 4 s |
| One real 17-minute agent session (167 events, tool output included): summary | 26 493 | ~60 s for both |
| Project state update after it | 10 042 | |

Tokens are input + output + cache creation, as the ledger counts them. With the defaults the budget is
400 000 tokens per 5 hours: about 11 such sessions (summary + state) per window, 50+ a day, above a busy
day's volume across the Macs. When the budget runs out, live jobs wait until the window frees up
(`/v1/status` `summariser.paused.reason: "budget"`), so nothing is lost. If your plan allows more, raise
`SUBSCRIPTION_TOKENS_PER_5H`; to spend less, lower `SUMMARY_SHARE`. Imported history and project-state
rebuilds use at most three quarters of the budget (rebuilds first); the last quarter is kept for live
sessions, so a long import never holds back live summaries or a re-bound folder's state.

#### Summariser status and recovery

`GET /v1/status` carries a `summariser` block:

```json
"summariser": {
  "enabled": true,
  "paused": { "reason": "login", "until": null },
  "lastRunAt": "2026-11-14T09:12:00.000Z",
  "lastError": "summary: login",
  "credentialExpiresAt": "2026-12-01T00:00:00.000Z",
  "backlog": { "live": 3, "imported": 120, "dead": 0 },
  "budget": { "used": 182000, "limit": 400000, "resumesAt": null }
}
```

- `paused` is `null` while the loop runs, else `{reason, until}` (`until` is an ISO time or `null`):
  - `budget`: the summariser's share of the 5-hour window is spent; it resumes at `until` by itself.
  - `usage_limit`: the subscription itself hit its limit; it resumes at the reset time the CLI reported.
  - `login`: the `claude` login on the server has expired or was never made. Nothing is summarised (raw
    capture and search carry on) until you log in again: run `claude auth login` inside the server
    container (as the user the server runs as, so the same `CLAUDE_CONFIG_DIR`). A tiny probe call every
    15 minutes notices the new login and the loop resumes by itself (`docker restart cerebro-server`
    checks at once); `until` is `null`. The server makes the same probe when it starts, before any job, so a
    login that was never made shows here right after a deploy (`lastError: "probe: login"`).
  - `unavailable`: an outage, not a problem with any one session: the `claude` CLI is missing or will not
    start, the network is down, or the API answers 5xx/529 "overloaded" or not at all. The loop probes
    again at `until` (after 2 minutes, backing off to every 30 minutes) and resumes when the probe
    answers. Outages never count against a job, so however long one lasts, nothing is dead-lettered.
  - `disabled`: `SUMMARISER_ENABLED` is off; queued jobs stay queued.
- `backlog`: summary jobs waiting, `live` (sessions recorded live) and `imported` (opted-in history, done
  after live work), and `dead`: jobs given up on after five failures that were the session's own fault
  (output that never matched the schema, a call that kept timing out while the CLI otherwise worked).
- `budget`: tokens `used` in the current rolling 5-hour window, the summariser's `limit`
  (`SUMMARY_SHARE × SUBSCRIPTION_TOKENS_PER_5H`), and `resumesAt` when it is over the limit.
- `credentialExpiresAt`: when the CLI's login expires, as the last successful call reported it. Log in
  again before then to avoid a `login` pause.
- `lastError` names the failing step and class only (`summary: timeout`), never model or transcript text.

To retry dead summary jobs (for example after fixing whatever made them fail), run
`bun server/src/cli.ts requeue-dead-summaries`; `requeue-dead` retries both dead chunks and dead summary jobs.
On the Zima server they run inside the container (`ssh zima sudo docker exec cerebro-server bun --no-install
server/src/cli.ts requeue-dead-summaries`; see "Maintenance on Zima" in
[deploy/zima/README.md](deploy/zima/README.md)). `bun server/src/cli.ts claude-smoke` makes one tiny real summary
call through the server's own runner and prints `ok` or the failure class.

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
DATABASE_URL=… bun server/src/cli.ts token create web-ui       # the web dashboard's token (see "Web dashboard")
```

The name `web-ui` is special: that token may call `/v1/dashboard/*` and nothing else, and no other token may call
`/v1/dashboard/*`. `EMBED_MACHINE_URLS` may not name it.

### API overview

All `/v1` routes need `Authorization: Bearer <token>`. Errors are `{ "error": "<code>", "message": "…" }`;
a revoked token gets `401 token_revoked` (stop retrying, ask the owner), an unknown one `401 unauthorized`.

**Scope.** Every search and read names the folder it comes from (`repo` + `subpath`) or asks for
`scope: "open"` explicitly. A folder whose nearest active binding has a project is locked to that
project; anything else may search all clients. Repo spellings are normalised server-side.

| Method & path | Purpose |
|---|---|
| `GET /health` | `{ok, db, apiVersion, instanceId}` — no auth; clients check `instanceId` before sending data |
| `GET /v1/status` | Calling machine, embed queue (`pending`, `dead`, `oldestPendingSeconds`), embedder state, summariser (see [Summariser status and recovery](#summariser-status-and-recovery)), DB size |
| `GET/POST /v1/clients`, `GET /v1/clients/:id/projects`, `POST /v1/projects` | Clients and projects (create is idempotent by name) |
| `GET /v1/bindings/resolve?repo=&subpath=` | Most specific binding for a folder |
| `PUT /v1/bindings` | Bind or decline a folder; changing an existing binding needs `rebind: true` (moves/holds its history) |
| `PATCH /v1/bindings/:id/identity` | Re-point a binding after a remote rename |
| `POST /v1/bindings/:id/adopt` | Move earlier sessions recorded under a broader binding into this subfolder binding |
| `PATCH /v1/sessions/:id` | Move one session to another active binding |
| `POST /v1/ingest` | Batch of ≤ 2000 events / ≤ 200 sessions (≤ 10 MB). Returns `{sessions, inserted, duplicates, rejected[]}`; bad items are rejected individually, the rest is stored. Event keys are unique per session. |
| `POST /v1/sessions/:id/end` | Mark a session ended (later events reopen it) |
| `POST /v1/search` | Hybrid search over summaries and raw chunks → `{scope, binding, hits[], degraded, degradedReasons[]}`. `include`: `all` (default), `summaries` or `raw`. Hits carry `kind` (`summary`/`chunk`), `summaryId` or `chunkId`, `matched` (`fts`/`vec`) and `distance`; summaries rank first on ties. `degradedReasons`: `embedder`, `fts_timeout`, `vector_timeout`, `summary_fts_timeout`, `summary_vector_timeout` |
| `GET /v1/state` | The scope's running project state → `{scope, state: {doc, text, version, updatedAt} \| null}`. `scope` is `project:<id>` (locked folder, or `projectId`), `client:<id>` (`clientId`, or a client-only folder), or null |
| `GET /v1/summaries` | Summaries in scope, newest first (`from`, `to`, `limit` ≤ 100, cursor `before`) → `{summaries[], next}`; each has `kind` (`session`/`history`), session range (null for history), dates, `title`, `overview`, `facts`, client and project names |
| `POST /v1/summaries` | Save a folder's initial history `{repo, subpath, title ≤ 200, text ≤ 20 000, tsFrom, tsTo}` (written by the client's own Claude; no server tokens). Redacted, then embedded in the background (the reply does not wait); one per folder and period (re-sending replaces, 200; new, 201). `404 unknown_binding` if the folder is unbound, `409 binding_declined` if declined |
| `GET /v1/sessions` | Sessions in scope, newest first (`from`, `to`, `limit`, cursor `before`) |
| `GET /v1/sessions/:id/events` | Raw events in scope (`afterSeq`, `limit` ≤ 1000, `nextSeq`; `full=1` for untruncated tool output, capped at 2 MB per page) |

**Dashboard API** (`web-ui` token only; every other token gets `403 forbidden`). Unscoped by design: it reads every
client. Counters are in-process and reset when the server restarts.

| Method & path | Purpose |
|---|---|
| `GET /v1/dashboard/overview` | `health` (`db`, `apiVersion`, `instanceId`, `startedAt`, `uptimeSeconds`), `status` (exactly what `/v1/status` reports, without `machine`), `queries` (`perMinute` `{m1, m5, m15}` search requests, `active` in-flight searches with the query cut to 120 chars, start and elapsed ms, `database`: this database's non-idle `pg_stat_activity` rows, SQL cut to 200 chars), `throughput` (`eventsPerMinute`, `chunksEmbeddedPerMinute`, `summariesLastHour`, `queues.embed {pending, dead}`, `queues.summary {live, imported, dead}`), `chat` (tokens and answers in the last 5 h and since start, the last answer, the last usage limit) |
| `GET /v1/dashboard/db` | `{bytes, counts}`: `pg_database_size` and exact row counts of sessions, events, chunks, summaries, clients, projects |
| `GET /v1/dashboard/clients` | Every client → its projects (plus `(no project)` for client-only folders) → sessions per machine and last activity (newest event, else start); active bindings, as search sees them |
| `POST /v1/dashboard/search` | `{query, limit?, include?, from?, to?}` (nothing else: no repo, scope, client or project) → the hybrid search over **all** clients, each hit with `machine`, `cwd` and `repo` added. Counts as a search. The client `/v1/search` rules are unchanged |
| `GET /v1/dashboard/sessions/:id/summaries` | The session (client, project, machine, cwd, dates) and its summaries, oldest range first |
| `POST /v1/dashboard/chat` | `{messages: [{role: "user"\|"assistant", content}…]}` (≤ 40, the owner's question last) → a server-sent event stream: `start`, `tool` (`{name, label}`, e.g. `searching "cadco checkout"`), `text` (`{text}` pieces), `ping` (every 8 s), then `done` (`{tokens, model, durationMs}`) or `error` (`{kind, message, resetAt}`; `kind` is `usage_limit`, `auth`, `timeout`, `cancelled`, `unavailable` or `failed`). `429 chat_busy` past `CHAT_MAX_CONCURRENT`, `503 chat_unavailable` if not configured |

`POST /mcp/chat` is the chat run's own tool endpoint (MCP over HTTP, JSON replies): it answers only the one-time
secret of a run in progress and refuses any request with `X-Forwarded-For` (anything through Caddy).

### Maintenance

Local forms (they need `DATABASE_URL` to reach the database). On the Zima server the database has no published
port: use the `docker exec` forms in [deploy/zima/README.md](deploy/zima/README.md), "Maintenance on Zima".

```sh
DATABASE_URL=… bun server/src/cli.ts redact <session-id> [regex]   # scrub a leaked secret from a session, its summaries and project states
DATABASE_URL=… bun server/src/cli.ts requeue-dead                  # retry dead chunks and dead summary jobs
DATABASE_URL=… bun server/src/cli.ts requeue-dead-summaries        # retry dead summary jobs only
DATABASE_URL=… bun server/src/cli.ts web-db-role > file            # new cerebro_web password; prints its DATABASE_URL into a pipe/file only
```

Secrets are redacted at ingest (known key formats, bearer tokens, URL passwords, `*_PASSWORD=`-style
lines). Events are chunked at ingest, so full-text search works immediately; a background worker
embeds chunks (live sessions before imported history) and the vector half of search fills in.

## Web dashboard

`web/` is a TanStack Start (React, SSR) app with its own container, `cerebro-web`, behind a login (Better Auth,
email + password, one owner account, no public sign-up). Pages:

- **Dashboard**: server health (database, embedder lanes, summariser), uptime and instance, database size and row
  counts, searches per minute (1/5/15 min), the searches and SQL running right now, events/chunks per minute,
  summaries per hour, queue depths and chat usage. It refreshes every 7 s (the database counts every 60 s) while
  the tab is visible.
- **Clients**: every client → projects → sessions per machine and last activity.
- **Chat**: ask about any client or project ("what did we do for Cadco last week?", "which clients use
  WordPress?"). A plain result-list search over everything sits in a second tab; clicking a hit opens its session
  summary.

How it fits together: the browser talks only to `cerebro-web` (a session cookie: `HttpOnly`, `SameSite=Lax`, not
`Secure` because the LAN is plain http; sign-in limited to 5 tries a minute per address). `cerebro-web` calls
`cerebro-server`'s `/v1/dashboard/*` server-side with the `web-ui` token from its environment; the token never
reaches the browser. Better Auth's tables live in the `auth` schema of the same database (migration 008), reached as
the `cerebro_web` role (migration 009: the `auth` schema only, nothing in `public`), never as the server's superuser.
`bun server/src/cli.ts web-db-role | …` gives that role LOGIN and a new password and prints web.env's
`DATABASE_URL` line into a pipe (it refuses a terminal); on the Zima, `deploy/zima/web-db-role.sh` does it all.

**The chat agent** runs in `cerebro-server`, where `claude` is logged in: `claude -p --model $CHAT_MODEL` on the
owner's Max subscription, like the summariser (`CEREBRO_HEADLESS=1`, `--no-session-persistence`, so nothing about
the chat is recorded or kept). Its environment is an allowlist (PATH, HOME, the Claude config dir, locale, proxies):
no `DATABASE_URL`, token or API key. Its only tools are six read-only Cerebro tools served over `/mcp/chat`
(`--mcp-config` + `--strict-mcp-config`, `--tools ""`, an `--allowedTools` list of those six, every built-in in
`--disallowedTools`, `--setting-sources ""` so no user or project settings or hooks load, `--max-turns 12`):
`global_search`, `list_clients_projects`, `get_session_summary`, `get_project_state`, `recent_sessions` and
`get_session_events` (capped: 20 hits, 50 sessions, 100 events of 2 000 chars, 60 000 chars per answer). It fails
closed: if the CLI's `init` message lists any other tool, or the Cerebro tool server isn't connected, the run is
killed before anything is shown ("chat tools are not locked down"). They read stored data, which was redacted at
ingest. The system prompt asks it to cite client / project / session / date and to say when the data doesn't cover
something. Earlier turns are sent back with each question (the last 12, capped), so a conversation is multi-turn
without the CLI keeping sessions. One answer at a time (`CHAT_MAX_CONCURRENT`), killed (its whole process group)
after `CHAT_TIMEOUT_MS` or when the browser goes away.

**Usage.** Chat spends the same Max plan as the summariser, but outside the summariser's `SUMMARY_SHARE`: its tokens
(input + output + cache creation, from the CLI's result) are counted in memory and shown on the dashboard, never
written to `usage_ledger`, so chat never delays summaries through the budget. Both still draw on the plan itself: if
the plan hits its limit, the chat says so (with the reset time) and the summariser pauses with `usage_limit` until
the reset.

Setup on the Zima (token, `web.env`, the database login, Caddy, the owner account):
[deploy/zima/README.md](deploy/zima/README.md), "Web dashboard". Locally:

```sh
export SERVER_DB=postgres://cerebro:cerebro@127.0.0.1:54329/cerebro
DATABASE_URL=$SERVER_DB bun server/src/cli.ts migrate
DATABASE_URL=$SERVER_DB bun server/src/cli.ts token create web-ui
DATABASE_URL=$SERVER_DB bun server/src/cli.ts web-db-role > web/.env.local   # DATABASE_URL for cerebro_web
cd web
export $(cat .env.local) BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
  BETTER_AUTH_URL=http://localhost:3000 CEREBRO_URL=http://127.0.0.1:8790 CEREBRO_WEB_TOKEN=<the web-ui token>
bun scripts/create-owner.ts --email you@example.com   # asks for the password twice (hidden)
bun run dev                                            # or: bun run build && bun server.ts
```

`bun test` at the root runs `web/test` too (it builds the app with Vite once, a few seconds); `bun run typecheck`
checks the server and `web/`.

## Install on a Mac

The client ships as a Claude Code plugin from this (private) repo's `plugin-dist` branch. The first time, the
repo has to be published to GitHub and a release made first: see step 5 of the first deploy in
[deploy/zima/README.md](deploy/zima/README.md).

```sh
gh auth login && gh auth setup-git          # private repo access
claude plugin marketplace add GustavoGomez092/cerebro
claude plugin install cerebro@cerebro       # asks for the server URL and token
```

Create the token on the server, outside a recorded Claude Code session:
`ssh -t zima sudo docker exec -it cerebro-server bun --no-install server/src/cli.ts token create <mac-name>`.

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
