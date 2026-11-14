## Findings

Probes are in `/private/tmp/claude-501/-Volumes-Content-projects-Cerebro/b14abdbd-98d6-4749-9a6f-829bfb486107/scratchpad/review/sec-a/` (`probe.test.ts`, `probe2.test.ts`, output in `probe.out`). They ran against throwaway DBs that were dropped afterwards; nothing in the repo was touched.

### SA-1 — Project lock fails open on any repo spelling the server doesn't recognise
- **Severity:** Important
- **Category:** Authorisation / client leakage
- **Where:** `server/src/search.ts:11-17` (`scopeFor`), `server/src/bindings.ts:29,62`, `server/src/http/routes/bindings.ts:7`
- **Scenario:** The server never applies `normalizeRemote`; it compares `repo` byte for byte. With a binding stored as `github.com/a/app` locked to project PA, a search with `repo` set to `GitHub.com/A/App`, `github.com/a/app.git`, `https://github.com/a/app`, `git@github.com:a/app.git`, `github.com/a/app/` or with a leading space returns `scope:"open"` and hits from another client's project. One un-normalised code path in the plugin (history import, a manual curl, a later API consumer) silently turns the lock off. `PUT /v1/bindings` also stores `https://GitHub.com/A/App.git` verbatim, creating a second identity for the same repo.
- **Evidence:** Reproduced, `probe.test.ts` section 1.
- **Fix:**
  - Normalise server-side in every entry point (`upsertBinding`, `resolveBinding`, `repointBinding`, `scopeFor`), skipping `path:` identities.
  - Return the resolved binding id in the search response so the client can detect a mismatch.
  - Consider making "open" an explicit request (`scope:"all"`) rather than the fallback for "couldn't resolve".

### SA-2 — The lock exists only on `/v1/search`; session listing and reads are unscoped
- **Severity:** Important
- **Category:** Authorisation / client leakage (design)
- **Where:** `server/src/http/routes/read.ts:13-26`, `server/src/read.ts`, `server/src/http/routes/catalog.ts`
- **Scenario:** Ruling 2 exempts reads by session id, but `GET /v1/sessions` is an enumeration. With no filter it returns every client's sessions (client name, project name, cwd, machine), and `GET /v1/sessions/:id/events?full=1` then returns any of them. Plan 2's "open a time range / session" tool, run in a project-locked folder, has nothing server-side to stop Claude listing and opening another client's sessions. The lock then depends on every plugin tool re-implementing scope.
- **Evidence:** Reproduced, `probe.test.ts` section 2.
- **Fix:** Accept `repo`/`subpath` on `GET /sessions` and `GET /sessions/:id/events` and apply the same `scopeFor`: a locked scope filters the list and returns 404 for out-of-project session ids. The plugin then always sends folder identity, and scope is enforced in one place.

### SA-3 — Plain HTTP plus a travelling laptop sends the token and transcripts to whoever answers `cerebro.home.lab`
- **Severity:** Important (design; affects plans 2 and 4)
- **Category:** Authentication / data exposure
- **Where:** Spec "Query API" and "Offline queue"; brief "LAN-only behind Caddy (plain HTTP)"
- **Scenario:** The work MacBook flushes its queue in the background when the server is "reachable". On a hotel, café or client-office network, a captive portal or wildcard DNS answers for `cerebro.home.lab`. The plugin then POSTs `Authorization: Bearer cbr_…` and up to 10 MB of client conversation in clear text to that host. If the flush treats any 2xx as success, those events are also removed from the queue and lost. Nothing lets the client tell the real server from an impostor.
- **Evidence:** Not reproducible yet (client not built); follows from the spec and the server having no identity proof.
- **Fix:**
  - Serve HTTPS from Caddy (`tls internal`) and pin that CA in the plugin.
  - Failing that, have the plugin require a server proof before sending the token or body, such as a per-install instance secret echoed as an HMAC over a nonce from `/health`.
  - Dequeue only on a well-formed `{sessions, inserted, duplicates}` JSON body.

### SA-4 — Secrets at rest: no server defence, no way to remove one, and Cerebro's own tokens end up readable by every machine
- **Severity:** Important
- **Category:** Data at rest
- **Where:** `server/src/ingest.ts:41-48`, `server/src/chunker.ts:28-31`; no delete or redact path anywhere
- **Scenario:**
  - Whatever arrives is stored forever. A `tool_call` input of `curl -H 'Authorization: Bearer sk-ant-…'` is embedded and full-text indexed, and searching for the key returns it highlighted.
  - The owner will very likely run `cli.ts token create` inside a recorded Claude Code session. The printed `cbr_…` token lands in a `tool_result` or assistant reply, and any other machine's token can read it. A stolen laptop could harvest the other tokens before it is revoked, which undermines "revoke one machine alone".
  - Once a secret is found there is no supported way to purge it: no API or CLI, and chunks and embeddings hold copies.
  - Client stripping is the only layer, and history import and future API consumers will bypass or pre-date it.
- **Evidence:** Reproduced, `probe2.test.ts` (search returns both the `sk-ant` key and the `cbr_` token; DELETE and PATCH on sessions return 404) and `probe.test.ts` section 6.
- **Fix:**
  - Put one redaction function in `shared/` and run it on both the client and the server at ingest (text and `toolInput`). Cover at least `cbr_[A-Za-z0-9_-]{43}`, PEM blocks, and the `sk-`, `ghp_`, `AKIA`, `xox` families, plus `scheme://user:pass@`.
  - Add `cli.ts redact --session … --seq …` (or a pattern) that rewrites `events.text` and `tool_input`, deletes the affected chunks and re-flags them for indexing.
  - Print in the CLI output that token creation should not be run inside a recorded session.

### SA-5 — Event idempotency key is global, so a key collision across sessions silently drops real content as a "duplicate"
- **Severity:** Important
- **Category:** Integrity / lost memory
- **Where:** `server/migrations/001_init.sql:53` (`key text not null unique`), `server/src/ingest.ts:43-47`
- **Scenario:** An event with key `sA:3` was stored under session `sB`. Machine A's real event `sA:3` then returned `200 {"inserted":0,"duplicates":1}` and its text was never stored. The client sees success and dequeues. This is one plugin key-scheme bug away (per-file line number, a restarted counter, or import and live capture using different schemes), and it also works deliberately from any machine.
- **Evidence:** Reproduced, `probe.test.ts` section 3 ("B pre-claims key", "events sA" dump).
- **Fix:** Make the key unique per session (`unique (session_id, key)`). Alternatively, on conflict compare `session_id` and `seq` and return 409 on mismatch instead of counting it as a duplicate.

### SA-6 — Malformed input turns a whole ingest batch into a permanent 500
- **Severity:** Important
- **Category:** Error handling / lost memory
- **Where:** `server/src/ingest.ts:11-17,42-45`, `server/src/http/routes/ingest.ts:9-27`
- **Scenario:** Each of these returns 500 and rolls back the entire batch on every retry, so the offline queue stays stuck behind one bad event:
  - a lone surrogate inside `toolInput` (for example a plugin or transcript truncating a string mid-emoji), rejected by jsonb with "Unicode low surrogate must follow a high surrogate";
  - NUL in `key`, `toolName`, `cwd` or the session id, because `clean()` covers only `text` and `toolInput`;
  - `ts` of `0000-01-01T00:00:00Z`, which passes zod and fails in Postgres;
  - `toolInput` nested 20,000 levels deep, which hits the Postgres stack depth limit.
- **Evidence:** Reproduced, `probe.test.ts` section 5. A lone surrogate in `text` is fine (stored as U+FFFD).
- **Fix:**
  - Apply `clean` plus `String.prototype.toWellFormed()` to every string field and inside `cleanDeep`.
  - Bound the year range and the `toolInput` depth in zod.
  - Map Postgres data errors (class 22) to a 422 that names the offending event key, so the client can quarantine that event instead of retrying forever.

### SA-7 — Any machine token is full admin over every other machine's data, with no audit trail
- **Severity:** Minor for a single owner; it is what makes SA-4 and a late revocation worse
- **Category:** Authorisation
- **Where:** `server/src/ingest.ts:26-32,56`, `server/src/bindings.ts:29,79`, `server/src/auth.ts:16`
- **Scenario:** With machine B's token I:
  - appended an event to machine A's session;
  - re-bound A's event-less session to another client's binding and changed its cwd (`machine_id` still says A);
  - set `ended_at` to 1999 on A's session;
  - re-bound A's repo to client B with one PUT, after which a search locked to PB returned A's history;
  - repointed A's binding to `path:mac-b:/tmp/x`, leaving the repo unbound and therefore open scope.
  
  Nothing records who did any of this or what the previous scope was. There is no `last_used_at`, no request log, and re-issuing a revoked name overwrites `created_at`, `revoked_at` and the hash on the same row. After a laptop is lost you cannot tell what its token read or changed, or undo a mistaken re-bind.
- **Evidence:** Reproduced, `probe.test.ts` section 3 and the "reissue" case.
- **Fix:**
  - Reject ingest and `end` for a session whose `machine_id` is not the caller's (history import of the same session from two Macs would need an explicit rule).
  - Add a `binding_history` row (old and new scope, machine, time) on every upsert and repoint.
  - Add `machines.last_used_at` and one access-log line per request (machine, method, path, status).
  - Keep revoked tokens as rows in a `machine_tokens` table instead of overwriting.

### SA-8 — `path:<machine>:<abs>` identities are not tied to the authenticated machine
- **Severity:** Minor
- **Category:** Authorisation / leakage
- **Where:** `shared/src/identity.ts:12`, `server/src/http/routes/bindings.ts`
- **Scenario:** The machine name in a path identity is whatever the client sends. Machine `mac-b` created a binding for `path:test-mac:/Users/x/notes`. Two Macs configured with the same local name would share bindings for `/Users/<same-user>/notes`, so a declined or client-A folder on one silently applies to the other.
- **Evidence:** Reproduced, `probe.test.ts` ("path identity of another machine").
- **Fix:** Have the client send `path:<abs>` and the server prefix it with the token's machine id or name, or reject `path:X:` where X is not the caller's machine name.

### SA-9 — Subpath matching is case-sensitive, so on macOS a differently cased cwd falls through to the parent binding
- **Severity:** Minor
- **Category:** Lock bypass / mis-filing
- **Where:** `server/src/bindings.ts:62-71`
- **Scenario:** A monorepo root is bound to client A / PA and `clients/b` to client B / PB. Resolving subpath `Clients/B` returns the root binding, so the session is filed under A and search is locked to A. This needs the plugin to derive the subpath from a logical `$PWD` rather than a real path.
- **Evidence:** Reproduced, `probe.test.ts` (resolve `Clients/B` → PA). LIKE escaping of `%`, `_` and `\` was probed and is correct, as is path-boundary matching.
- **Fix:** Require the plugin to use `git rev-parse --show-prefix` or realpath, and document it in the API contract. Optionally have the server refuse or flag a subpath that matches an existing binding only case-insensitively.

### SA-10 — A declined subfolder inside a project-locked repo opens all-client search
- **Severity:** Minor (follows ruling 2, but probably unintended in this shape)
- **Category:** Lock bypass
- **Where:** `server/src/search.ts:14`
- **Scenario:** `github.com/a/app` is locked to PA. Declining `scratch/` inside it makes a search from `scratch/` return `scope:"open"` with hits from PB. "Don't record here" becomes "search everything from here".
- **Evidence:** Reproduced, `probe.test.ts`.
- **Fix:** For scope purposes, skip declined bindings and use the nearest active ancestor; a declined folder with no active ancestor stays open.

### SA-11 — 500 logs carry fragments of user content; search with NUL returns 500
- **Severity:** Minor
- **Category:** Data exposure in logs
- **Where:** Hono default `onError` (no `app.onError` in `server/src/http/app.ts`), `server/src/indexer.ts:63`
- **Scenario:** The jsonb error logs `where=JSON data, line 1: {"command":"echo …`, which is the start of a tool input. Container logs are outside the DB's access control and backup policy. NUL in `query`, `repo` or a client name also returns 500.
- **Evidence:** Reproduced, `probe.test.ts` section 5.
- **Fix:** Add `app.onError` that logs only the Postgres code, routine, route and machine. Strip NUL in the shared validators.

### Checked and found sound
- **Auth before routing:** unknown `/v1/*` paths, `/v1`, `/v1/` and `/v1/status/` return 401 without a token and 404 with one. `//v1/status`, `/V1/status` and `/v1%2fstatus` return 404 and do not reach handlers.
- **Token handling:** revocation is immediate; the old token stays dead after re-issue; a token in the query string is not accepted; the hash-only storage holds.
- **Error bodies:** 500 bodies are the bare text "Internal Server Error"; zod issues do not echo input values.
- **Injection:** I found no SQL injection; all dynamic SQL is parameterised or built from constants.
- **Locked search:** a locked scope ignores request `clientId` and `projectId`.
- **Unauthenticated surface:** `/health` exposes only `{ok, db}`.
- **Image:** `.dockerignore` excludes `.git`, docs and tests, and the container runs as `bun`.

## Questions for the codebase owner

1. Will the plan-2 recall tools ("list sessions", "open session / time range") be offered to Claude inside a project-locked folder? If yes, SA-2 is the main leak path and should be fixed server-side now; if those tools are search-only, it drops to Minor.
2. Is "unbound → search all clients" meant to cover "the server could not recognise this folder" (renamed remote, fork, hook without git on PATH)? If the open scope should be an explicit choice, SA-1's fallback should change, not just the normalisation.
3. Should a declined folder have recall at all? If the plugin offers no tools there, SA-10 is moot.
4. Will the travelling MacBook ever attempt a flush off the home network without a VPN? If Tailscale-only is acceptable for that machine, SA-3 reduces to "validate the response before dequeuing".
5. Is "raw kept forever, word for word" compatible with a redaction CLI that rewrites stored events when a secret is found (SA-4)? Without one, the only remedy is hand-written SQL against events and chunks.
6. What event key scheme will the plugin use, and will history import and live capture produce the same key for the same transcript line? This decides how likely SA-5 is in practice.
7. Should the same session id ever legitimately arrive from two machines (for example `~/.claude` synced between Macs)? That decides whether the session-ownership check in SA-7 can be strict.
8. Is there a need to move one mis-filed session to another binding? Today the only correction is re-binding the whole folder.
