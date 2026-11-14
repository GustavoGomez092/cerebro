# Cerebro Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable Cerebro service (HTTP API + Postgres/pgvector) that stores clients, projects, folder bindings, sessions and raw conversation events, indexes them for hybrid search, and serves scoped search and raw-span reads to token-authenticated machines.

**Architecture:** Bun + TypeScript monorepo with workspaces `shared/` (types and identity helpers used by server and, later, the client plugin) and `server/`. Postgres 17 with pgvector holds everything; scope (client/project) is derived through `sessions.binding_id → bindings`, so re-binding a folder moves its history by updating one row. A background indexer chunks new events and embeds them through a pluggable `Embedder` (Ollama in production, a deterministic fake in tests).

**Tech Stack:** Bun 1.4 (`bun test`, `Bun.sql`), Hono (HTTP), zod (request validation), Postgres 17 + pgvector 0.8 (`pgvector/pgvector:0.8.1-pg17`), Ollama `/api/embed` with model `bge-m3` (1024 dims) for embeddings.

**Spec:** `docs/superpowers/specs/2026-11-13-cerebro-design.md`

**This is plan 1 of 4.** Later plans: (2) client plugin — hooks, offline queue, secret stripping, opt-in skill, recall tools, history import; (3) summariser — summaries, project state, 20% budget, initial history; (4) Zima deployment — containers, Caddy, ZimaOS app, backups, subscription login. Out of scope here: anything summary-related, secret stripping (client-side), deployment.

## Global Constraints

- Nothing hard-coded to the owner's house: database URL, port, embedder URL/model/dims come from env (`DATABASE_URL`, `PORT` default `8790`, `EMBED_URL`, `EMBED_MODEL` default `bge-m3`, `EMBED_DIMS` default `1024`).
- Every endpoint except `GET /health` requires `Authorization: Bearer <token>`; one token per machine; revoked tokens get 401. Only the SHA-256 hash of a token is stored.
- Raw events are kept forever; nothing in this plan deletes events.
- `tool_result` events are stored but never chunked, embedded, or full-text indexed (spec: large tool outputs and Cerebro recall results are excluded from search).
- Scoping rule: a request made from a folder whose binding is `active` with a project sees only that project; a client-only binding, a declined binding, or no binding may search all clients.
- Ingest is idempotent: replaying a batch never duplicates events or chunks.
- Ingest must succeed even when the embedder is down; indexing catches up later.
- Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01LTKLaRsEuQTEb2o763vgdu`.
- Integration tests need Docker running (`docker compose -f docker-compose.dev.yml up -d db`).

## Review Focus

1. **Replayed batches** (offline queue retries the same batch, or overlapping batches) → no duplicate events or chunks. Test in Task 4 and Task 6.
2. **Cross-project leakage**: search from a project-bound folder that also passes another `clientId`/`projectId` must still return only its own project. Test in Task 7.
3. **Huge single events** (a 200 KB assistant message) → split into several chunks, no error, no embedder input over the limit. Test in Task 5.
4. **Awkward queries**: an empty query, unbalanced quotes (`"foo`), Spanish text with accents (`canción`) → 200 with results or an empty list, never 500. Test in Task 7.
5. **Embedder outage** → ingest returns 200; events stay unindexed; the next indexer run indexes them. Test in Task 6.

---

## File Structure

```
package.json                     workspaces ["shared", "server"], scripts: test, dev
tsconfig.json                    strict, ESNext, bundler resolution
docker-compose.dev.yml           db (pgvector:0.8.1-pg17 on 127.0.0.1:54329, user/pass/db cerebro), ollama (optional profile "embed")
shared/package.json              name "@cerebro/shared"
shared/src/types.ts              API types shared by server and client
shared/src/identity.ts           normalizeRemote(), pathIdentity()
shared/test/identity.test.ts
server/package.json              name "@cerebro/server", deps hono, zod
server/migrations/001_init.sql   full schema
server/src/config.ts             loadConfig(env)
server/src/db.ts                 connect(url), migrate(sql)
server/src/auth.ts               token create/verify/revoke + Hono middleware
server/src/cli.ts                `token create|revoke|list`
server/src/catalog.ts            clients + projects
server/src/bindings.ts           upsert, resolve most-specific, re-point
server/src/ingest.ts             ingestBatch(), endSession()
server/src/chunker.ts            pure chunking
server/src/embed/embedder.ts     Embedder interface
server/src/embed/fake.ts         deterministic hashing embedder
server/src/embed/ollama.ts       Ollama client
server/src/indexer.ts            indexPending(), startIndexer()
server/src/search.ts             hybrid search with scope rules
server/src/read.ts               listSessions(), getEvents()
server/src/http/app.ts           createApp(deps): Hono app, mounts routes
server/src/http/routes/*.ts      one file per area (catalog, bindings, ingest, search, read, status)
server/src/main.ts               boot: migrate, serve, start indexer
server/test/helpers.ts           freshDb(), authedApp()
server/test/*.test.ts
README.md                        dev setup, env vars, token CLI
```

---

### Task 1: Workspace, dev database, schema and migrations

**Files:**
- Create: `package.json`, `tsconfig.json`, `docker-compose.dev.yml`, `shared/package.json`, `server/package.json`, `server/migrations/001_init.sql`, `server/src/config.ts`, `server/src/db.ts`, `server/test/helpers.ts`, `server/test/db.test.ts`, `README.md`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string,string|undefined>): Config` where `Config = { databaseUrl: string; port: number; embedUrl: string|null; embedModel: string; embedDims: number }` (throws if `DATABASE_URL` missing).
  - `connect(url: string): SQL` (Bun's `SQL`), `migrate(sql: SQL): Promise<string[]>` (returns names applied this run; keeps a `schema_migrations(name text pk, applied_at timestamptz)` table; reads `server/migrations/*.sql` in name order).
  - `freshDb(): Promise<{ sql: SQL; drop(): Promise<void> }>` — creates database `cerebro_test_<random>` on `postgres://cerebro:cerebro@127.0.0.1:54329/cerebro`, runs `migrate`, `drop()` closes and drops it.
  - Schema (`001_init.sql`), all ids `uuid default gen_random_uuid()` unless noted:
    - `create extension if not exists vector;`
    - `clients(id, name text not null unique, created_at timestamptz default now())`; seed row `('Personal')`.
    - `projects(id, client_id uuid not null references clients, name text not null, created_at, unique(client_id, name))`
    - `machines(id, name text not null unique, token_hash text not null unique, created_at, revoked_at timestamptz)`
    - `bindings(id, repo text not null, subpath text not null default '', status text not null check (status in ('active','declined')), client_id uuid references clients, project_id uuid references projects, created_at, updated_at, unique(repo, subpath), check (status = 'declined' or client_id is not null))`
    - `sessions(id text primary key, binding_id uuid not null references bindings, machine_id uuid not null references machines, cwd text not null, started_at timestamptz not null, last_event_at timestamptz, ended_at timestamptz, imported boolean not null default false)`
    - `events(id bigserial primary key, key text not null unique, session_id text not null references sessions, seq integer not null, ts timestamptz not null, kind text not null check (kind in ('user','assistant','tool_call','tool_result')), text text not null default '', tool_name text, tool_input jsonb, indexed boolean not null default false)`; index `(session_id, seq)`; partial index on `(session_id) where not indexed`.
    - `chunks(id bigserial primary key, session_id text not null references sessions, first_seq integer not null, last_seq integer not null, ts_from timestamptz not null, ts_to timestamptz not null, text text not null, tsv tsvector generated always as (to_tsvector('simple', text)) stored, embedding vector(1024) not null, unique(session_id, first_seq, last_seq))`; GIN index on `tsv`; HNSW index `using hnsw (embedding vector_cosine_ops)`.

- [ ] **Step 1: Write workspace files and `docker-compose.dev.yml`; start the db**

Run: `docker compose -f docker-compose.dev.yml up -d db && bun install`
Expected: container healthy; install succeeds.

- [ ] **Step 2: Write the failing test `server/test/db.test.ts`**

```ts
test("migrate creates schema and is idempotent", async () => {
  const { sql, drop } = await freshDb();          // freshDb already migrated once
  expect(await migrate(sql)).toEqual([]);          // second run applies nothing
  const [{ n }] = await sql`select count(*)::int as n from clients where name = 'Personal'`;
  expect(n).toBe(1);
  const cols = await sql`select column_name from information_schema.columns where table_name = 'chunks'`;
  expect(cols.map((c: any) => c.column_name)).toContain("embedding");
  await drop();
});
test("loadConfig applies defaults and requires DATABASE_URL", () => {
  expect(loadConfig({ DATABASE_URL: "postgres://x" })).toEqual({ databaseUrl: "postgres://x", port: 8790, embedUrl: null, embedModel: "bge-m3", embedDims: 1024 });
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
});
```

- [ ] **Step 3: Run it to verify it fails** — `bun test server/test/db.test.ts` → FAIL (modules missing).
- [ ] **Step 4: Implement `config.ts`, `db.ts`, `001_init.sql`, `helpers.ts#freshDb`** as specified above. `migrate` runs each file in a transaction.
- [ ] **Step 5: Run it to verify it passes** — `bun test server/test/db.test.ts` → PASS.
- [ ] **Step 6: README dev section** (start db, `bun test`, env vars table).
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(server): workspace, schema and migrations"` (+ trailer).

---

### Task 2: Machine tokens, auth middleware, app skeleton, token CLI

**Files:**
- Create: `server/src/auth.ts`, `server/src/cli.ts`, `server/src/http/app.ts`, `server/src/http/routes/status.ts`, `server/test/auth.test.ts`
- Modify: `server/test/helpers.ts` (add `authedApp`)

**Interfaces:**
- Consumes: `connect`, `migrate`, `freshDb` (Task 1).
- Produces:
  - `createToken(sql, machineName: string): Promise<{ machineId: string; token: string }>` — token is `cbr_` + 32 random bytes base64url; stores `sha256` hex; throws if the name exists and is not revoked.
  - `verifyToken(sql, token: string): Promise<{ id: string; name: string } | null>` — null when unknown or revoked.
  - `revokeToken(sql, machineName: string): Promise<boolean>`.
  - `type AppDeps = { sql: SQL; embedder: Embedder }` (Embedder type from Task 5; until then declare `embedder: unknown` and tighten in Task 5).
  - `createApp(deps: AppDeps): Hono` — `GET /health` (no auth) → `{ ok: true, db: boolean }`; everything under `/v1/*` behind bearer middleware that sets `c.get("machine")`; `GET /v1/status` → `{ machine: string, unindexedEvents: number }`.
  - `authedApp(): Promise<{ app: Hono; sql: SQL; token: string; machineId: string; drop(): Promise<void> }>` test helper (fresh db, machine `"test-mac"`, fake embedder once Task 5 exists).
  - CLI: `bun server/src/cli.ts token create <name>` prints the token once; `token revoke <name>`; `token list` prints name, created, revoked.

- [ ] **Step 1: Write failing tests `server/test/auth.test.ts`**

```ts
test("health needs no token", async () => { /* GET /health → 200, body.ok === true */ });
test("v1 rejects missing, bad and revoked tokens", async () => {
  // no header → 401; "Bearer nope" → 401; valid token → /v1/status 200 with machine "test-mac";
  // revokeToken(sql, "test-mac") then same token → 401
});
test("only the hash is stored", async () => {
  // select token_hash from machines → not equal to token, length 64
});
test("duplicate active machine name is rejected", async () => {
  // createToken(sql, "test-mac") again → throws
});
```

- [ ] **Step 2: Run** `bun test server/test/auth.test.ts` → FAIL.
- [ ] **Step 3: Implement `auth.ts`, `app.ts`, `routes/status.ts`, `cli.ts`, `helpers.ts#authedApp`.** Compare token hashes with a constant-time comparison (`crypto.timingSafeEqual`) after lookup by hash.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): machine tokens and auth`.

---

### Task 3: Identity helpers, clients/projects, bindings

**Files:**
- Create: `shared/src/types.ts`, `shared/src/identity.ts`, `shared/test/identity.test.ts`, `server/src/catalog.ts`, `server/src/bindings.ts`, `server/src/http/routes/catalog.ts`, `server/src/http/routes/bindings.ts`, `server/test/bindings.test.ts`

**Interfaces:**
- Produces (shared):
  - `normalizeRemote(url: string): string` — strips scheme, `user@`, trailing `.git` and `/`, turns scp form `host:path` into `host/path`, lowercases everything. `git@github.com:Org/Repo.git`, `https://github.com/org/repo`, `ssh://git@github.com/org/repo.git/` → `github.com/org/repo`.
  - `pathIdentity(machineName: string, absPath: string): string` → `path:<machineName>:<absPath>` (non-git folders; not shared across machines).
  - Types: `Binding = { id: string; repo: string; subpath: string; status: "active"|"declined"; clientId: string|null; projectId: string|null }`, `Client = { id; name }`, `Project = { id; clientId; name }`.
- Produces (server):
  - `listClients(sql)`, `createClient(sql, name)` (returns existing on same name), `listProjects(sql, clientId)`, `createProject(sql, clientId, name)` (idempotent likewise).
  - `upsertBinding(sql, b: { repo; subpath; status; clientId?; projectId? }): Promise<Binding>` — upsert on `(repo, subpath)`; rejects `projectId` whose `client_id` ≠ `clientId`; rejects `active` without `clientId`. Because sessions reference the binding, changing client/project here moves all of that binding's history (spec: re-binding moves history).
  - `resolveBinding(sql, repo: string, subpath: string): Promise<Binding|null>` — among bindings with this `repo`, those whose `subpath` is `''`, equals `subpath`, or is a `/`-boundary prefix of it; returns the longest. (`apps/web` must not match binding `apps/we`.)
  - `repointBinding(sql, id: string, repo: string, subpath: string): Promise<Binding>` — for remote renames; 409 if target identity already bound.
  - Routes: `GET /v1/clients`, `POST /v1/clients {name}`, `GET /v1/clients/:id/projects`, `POST /v1/projects {clientId,name}`, `GET /v1/bindings/resolve?repo=&subpath=` → `{ binding: Binding|null }`, `PUT /v1/bindings`, `PATCH /v1/bindings/:id/identity {repo,subpath}`. Bodies validated with zod → 400 on invalid.

- [ ] **Step 1: Write failing tests** — `shared/test/identity.test.ts` with the three remote spellings above plus `https://GitLab.com/A/B/` → `gitlab.com/a/b`; `server/test/bindings.test.ts`:

```ts
test("most specific binding wins, on path boundaries", async () => {
  // repo r: binding '' → client A; binding 'apps/web' → client B project P
  // resolve(r, 'apps/web/src') → B/P ; resolve(r, 'apps/website') → A ; resolve(r, '') → A ; resolve('other','') → null
});
test("declined binding resolves as declined", async () => { /* status 'declined', clientId null */ });
test("project must belong to the client", async () => { /* PUT with mismatched → 400 */ });
test("repoint moves identity, refuses collisions", async () => { /* PATCH → new repo resolves; PATCH onto an existing identity → 409 */ });
```

- [ ] **Step 2: Run** `bun test shared server/test/bindings.test.ts` → FAIL.
- [ ] **Step 3: Implement** the functions and routes above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: identities, catalog and bindings`.

---

### Task 4: Ingest sessions and events

**Files:**
- Create: `server/src/ingest.ts`, `server/src/http/routes/ingest.ts`, `server/test/ingest.test.ts`
- Modify: `shared/src/types.ts`

**Interfaces:**
- Consumes: `upsertBinding`, `authedApp`.
- Produces (shared types):
  - `EventKind = "user"|"assistant"|"tool_call"|"tool_result"`
  - `IngestEvent = { key: string; sessionId: string; seq: number; ts: string; kind: EventKind; text: string; toolName?: string; toolInput?: unknown }` — `key` is the client's idempotency key.
  - `IngestSession = { id: string; bindingId: string; cwd: string; startedAt: string; imported?: boolean }`
  - `IngestBatch = { sessions: IngestSession[]; events: IngestEvent[] }`, `IngestResult = { sessions: number; inserted: number; duplicates: number }`
- Produces (server):
  - `ingestBatch(sql, machineId: string, batch: IngestBatch): Promise<IngestResult>` — one transaction; sessions upserted (`binding_id`, `cwd` updated only if the session has no events yet; `started_at` = least of old/new); events `insert … on conflict (key) do nothing`; `last_event_at` = max event ts. Events for a session that is neither in the batch nor in the db → whole batch rejected.
  - `endSession(sql, sessionId: string, endedAt: string): Promise<boolean>` (false if unknown).
  - Routes: `POST /v1/ingest` (body ≤ 10 MB; zod; unknown session → 422 `{ error: "unknown_session", sessionId }`; unknown binding → 422 `unknown_binding`), `POST /v1/sessions/:id/end {endedAt}` → 404 if unknown.

- [ ] **Step 1: Write failing tests `server/test/ingest.test.ts`**

```ts
test("ingest is idempotent across replays and overlaps", async () => {
  // batch1: session s1 + events k1..k3 → {inserted:3, duplicates:0}
  // replay batch1 → {inserted:0, duplicates:3}
  // batch2: k3..k5 → {inserted:2, duplicates:1}; select count(*) from events → 5
});
test("events for an unknown session reject the whole batch", async () => { /* 422 unknown_session; events count unchanged */ });
test("unknown binding is 422", async () => {});
test("end session sets ended_at; unknown is 404", async () => {});
test("tool_input round-trips as json", async () => { /* toolInput {command:"ls -la"} → events.tool_input->>'command' = 'ls -la' */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): idempotent ingest`.

---

### Task 5: Chunker and embedders

**Files:**
- Create: `server/src/chunker.ts`, `server/src/embed/embedder.ts`, `server/src/embed/fake.ts`, `server/src/embed/ollama.ts`, `server/test/chunker.test.ts`, `server/test/embed.test.ts`
- Modify: `server/src/http/app.ts` (`AppDeps.embedder: Embedder`), `server/test/helpers.ts` (fake embedder)

**Interfaces:**
- Produces:
  - `type ChunkInput = { seq: number; ts: string; kind: EventKind; text: string; toolName: string|null; toolInput: unknown }`
  - `type Chunk = { firstSeq: number; lastSeq: number; tsFrom: string; tsTo: string; text: string }`
  - `chunkEvents(events: ChunkInput[], maxChars = 1600, overlap = 200): Chunk[]` — skips `tool_result`; renders `User: …`, `Assistant: …`, `Tool <name>: <JSON.stringify(toolInput) truncated to 300 chars>`; packs consecutive rendered events until adding the next would exceed `maxChars`; a single rendered event longer than `maxChars` is split into windows of `maxChars` with `overlap` (all windows carry that event's seq/ts). Never returns empty-text chunks.
  - `interface Embedder { dims: number; embed(texts: string[]): Promise<number[][]> }`
  - `fakeEmbedder(dims = 1024): Embedder` — lowercase, split on non-letters (Unicode aware), hash each token into a bucket, L2-normalise. Same text → same vector; shared words → positive cosine.
  - `ollamaEmbedder(url: string, model: string, dims: number, fetchFn = fetch): Embedder` — `POST {url}/api/embed {model, input: texts}` → `{embeddings}`; throws `EmbedderError` on non-2xx or when a vector's length ≠ `dims`.

- [ ] **Step 1: Write failing tests**

```ts
// chunker.test.ts
test("tool_result is never indexed", () => { /* events [user, tool_result "SECRET-OUTPUT"] → no chunk contains "SECRET-OUTPUT" */ });
test("packs small events and keeps seq/ts ranges", () => { /* 3 short events → 1 chunk, firstSeq 1, lastSeq 3, text starts "User: " */ });
test("a 200 KB message splits into bounded windows", () => {
  // one assistant event of 200_000 chars → every chunk.text.length <= 1600 + label, count >= 125, all firstSeq === lastSeq === that seq
});
test("tool input is truncated", () => { /* toolInput with 5 KB string → rendered Tool line <= 300 chars of JSON */ });
// embed.test.ts
test("fake embedder is deterministic and similarity-aware", () => {});
test("ollama embedder posts input and validates dims", async () => { /* stub fetchFn: assert body {model:"bge-m3", input:["a"]}; wrong length → EmbedderError; 500 → EmbedderError */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): chunker and embedders`.

---

### Task 6: Indexer

**Files:**
- Create: `server/src/indexer.ts`, `server/test/indexer.test.ts`
- Modify: `server/src/http/routes/status.ts` (count from `events where not indexed`)

**Interfaces:**
- Consumes: `chunkEvents`, `Embedder`, schema.
- Produces:
  - `indexPending(sql, embedder: Embedder, opts?: { maxSessions?: number; batchSize?: number }): Promise<{ sessions: number; chunks: number; failed: number }>` — for up to `maxSessions` (default 20) sessions having unindexed events: load those events by `seq`, `chunkEvents`, embed in batches of `batchSize` (default 16), then in one transaction insert chunks (`on conflict (session_id, first_seq, last_seq) do nothing`) and set `indexed = true` on those events (including skipped `tool_result`s). If the embedder throws for a session, nothing for that session is written and `failed` increments; other sessions continue.
  - `startIndexer(sql, embedder, intervalMs = 5000): { stop(): void }` — loops `indexPending`, logs failures, never throws.

- [ ] **Step 1: Write failing tests**

```ts
test("indexes new events once", async () => { /* ingest 3 events → indexPending → chunks 1; run again → chunks 0; events all indexed */ });
test("embedder outage leaves events pending, then recovers", async () => {
  // embedder that throws → {failed:1}; status unindexedEvents === 3; ingest still returns 200
  // swap to fake → indexPending → chunks 1, unindexed 0
});
test("tool_result-only sessions get marked indexed with no chunks", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): background indexer`.

---

### Task 7: Scoped hybrid search and raw reads

**Files:**
- Create: `server/src/search.ts`, `server/src/read.ts`, `server/src/http/routes/search.ts`, `server/src/http/routes/read.ts`, `server/test/search.test.ts`, `server/test/read.test.ts`
- Modify: `shared/src/types.ts`

**Interfaces:**
- Consumes: `resolveBinding`, `Embedder`, indexed data.
- Produces (shared types):
  - `SearchRequest = { query: string; repo?: string; subpath?: string; clientId?: string; projectId?: string; from?: string; to?: string; limit?: number }`
  - `SearchHit = { chunkId: number; sessionId: string; firstSeq: number; lastSeq: number; tsFrom: string; tsTo: string; snippet: string; score: number; clientName: string|null; projectName: string|null }`
  - `SearchScope = { kind: "project"; projectId: string } | { kind: "open"; clientId?: string; projectId?: string }`
  - `EventView = { seq: number; ts: string; kind: EventKind; text: string; toolName: string|null; toolInput: unknown; truncated: boolean }`
- Produces (server):
  - `scopeFor(sql, req: SearchRequest): Promise<SearchScope>` — if `repo` given and it resolves to an `active` binding with a project → `{kind:"project"}` (request's `clientId`/`projectId` ignored); otherwise `{kind:"open", clientId, projectId}` from the request.
  - `search(sql, embedder, req): Promise<SearchHit[]>` — `limit` default 10, max 50. Two candidate lists of 50 each within scope and date range (`ts_to >= from`, `ts_from <= to`): full-text via `websearch_to_tsquery('simple', query)` ranked by `ts_rank`, and vector via `embedding <=> $queryVec`. Merge with reciprocal-rank fusion, `score = Σ 1/(60 + rank)`. `snippet` = `ts_headline('simple', text, query)` when FTS matched, else first 300 chars. Empty/whitespace query → `[]`. Query text is passed only as a bound parameter.
  - `listSessions(sql, f: { clientId?; projectId?; from?; to?; limit? }): Promise<Array<{ id; clientName; projectName; machine; cwd; startedAt; lastEventAt; endedAt; imported }>>`
  - `getEvents(sql, sessionId, f: { fromSeq?: number; toSeq?: number; full?: boolean }): Promise<EventView[]>` — `tool_result` text truncated to 2000 chars unless `full`.
  - Routes: `POST /v1/search` → `{ scope: SearchScope["kind"], hits: SearchHit[] }`; `GET /v1/sessions?clientId&projectId&from&to&limit`; `GET /v1/sessions/:id/events?fromSeq&toSeq&full=1` (404 unknown).

- [ ] **Step 1: Write failing tests**

```ts
// search.test.ts — setup: client A/project P1 (repo "r1"), client B/project P2 (repo "r2"), client-only binding repo "r3" → A;
// each has a session with a user event mentioning "pricing" (B's says "pricing for Beta Corp")
test("project-bound folder sees only its project, even if it asks for another", async () => {
  // {query:"pricing", repo:"r1", clientId:B.id} → scope "project", every hit.projectName === "P1"
});
test("client-only and unbound folders search all clients", async () => {
  // repo "r3" → scope "open", hits include P1 and P2; repo "unknown" → same
});
test("open scope honours explicit filters", async () => { /* no repo, projectId P2 → only P2 */ });
test("date range filters by chunk time", async () => {});
test("awkward queries never 500", async () => {
  for (const q of ["", "   ", '"foo', "canción", "a & b | !c", "'; drop table events; --"]) {
    // POST /v1/search → 200, hits is an array
  }
});
test("semantic match without shared keyword ranks via vectors", async () => { /* with fakeEmbedder, overlapping vocab still returns the hit */ });
// read.test.ts
test("events come back in seq order with tool_result truncation", async () => { /* 5 KB tool_result → truncated true, 2000 chars; full=1 → whole text */ });
test("sessions list filters by project and date", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): scoped hybrid search and reads`.

---

### Task 8: Service entrypoint and end-to-end smoke

**Files:**
- Create: `server/src/main.ts`, `server/test/e2e.test.ts`, `server/Dockerfile`
- Modify: `README.md` (run locally, token CLI, API overview), `docker-compose.dev.yml` (add `server` service under profile `app`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `main.ts`: `loadConfig(process.env)` → `connect` → `migrate` → embedder = `ollamaEmbedder(EMBED_URL, EMBED_MODEL, EMBED_DIMS)` if `EMBED_URL` set, else exit with an error naming `EMBED_URL` (the fake is test-only) → `Bun.serve({ port, fetch: app.fetch })` → `startIndexer`. On SIGTERM: stop indexer, close sql.
  - `server/Dockerfile`: `oven/bun:1.4` base, `bun install --production`, `CMD ["bun","server/src/main.ts"]`, runs as non-root user `bun`.

- [ ] **Step 1: Write failing `e2e.test.ts`** — through `app.request` only: create client + project → PUT binding → ingest session with user/assistant/tool_call/tool_result events → `indexPending` → search finds the assistant text → `GET /v1/sessions/:id/events` returns all four events in order → `/v1/status` reports `unindexedEvents: 0`.
- [ ] **Step 2: Run** → FAIL until wiring is complete. **Step 3: Implement `main.ts`, Dockerfile, README.** **Step 4: Run whole suite** — `bun test` → all PASS.
- [ ] **Step 5: Manual smoke with real embeddings**

Run: `docker compose -f docker-compose.dev.yml --profile embed up -d ollama && docker compose -f docker-compose.dev.yml exec ollama ollama pull bge-m3`, then `DATABASE_URL=postgres://cerebro:cerebro@127.0.0.1:54329/cerebro EMBED_URL=http://127.0.0.1:11434 bun server/src/main.ts`, create a token with the CLI, `curl -s localhost:8790/health` → `{"ok":true,"db":true}`, and `curl -H "Authorization: Bearer …" localhost:8790/v1/status` → 200.
Expected: both respond as shown; the server log shows the indexer running without errors.

- [ ] **Step 6: Commit** `feat(server): entrypoint, Dockerfile, e2e`.
