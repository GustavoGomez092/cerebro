# Cerebro Client Plugin Implementation Plan (plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin, installed once per Mac, that asks to opt each new folder into Cerebro, records opted-in sessions into a local queue, uploads them to the Cerebro server whenever it is reachable, imports a folder's past conversations on opt-in, injects a short brief at session start, and gives Claude recall tools — plus per-agent history extractors so every agent on the Mac (Claude Code and its subagents, Codex, Gemini CLI, and anything that writes the generic Cerebro format) contributes its history to the same memory.

**Architecture:** A new `client/` workspace compiled with `bun build --compile` into one `cerebro` executable that serves every role: hook handler (`cerebro hook <event>`), uploader (`cerebro flush`), importer (`cerebro import`), MCP server (`cerebro mcp`) and maintenance CLI. State lives in `~/.cerebro/` (SQLite queue, binding cache, logs). Every agent's history is read through a `HistorySource` adapter (one per agent: discover files, read new complete records from a cursor, normalise to Cerebro sessions/events); Claude Code is captured live by hooks, the other agents by a periodic `cerebro sync`. The plugin directory (`plugin/`) holds the manifest, hooks, skill, MCP config and a shim that runs the bundled binary. Hooks only read local files and write to SQLite; all network work happens in a detached `cerebro flush` process, so Claude Code is never slowed or broken.

**Tech Stack:** Bun 1.4 (`bun:sqlite`, `bun build --compile`), TypeScript, `@modelcontextprotocol/sdk` (stdio server), zod, the server's `@cerebro/shared` package. Tests: `bun test`, with the real server app (`server/src/http/app.ts`) running in-process against a throwaway Postgres.

**Spec:** `docs/superpowers/specs/2026-11-13-cerebro-design.md` (sections Components, Opt-in flow, Catch-up, Capture, Recall inside Claude Code). Server contract: README "API overview" on `feat/server-core`. Client obligations agreed in review: `docs/reviews/2026-11-13/pro-codebase-verdicts.md` ("Plan 2").

## Global Constraints

- Hooks must never block or fail a Claude Code session: every hook exits 0 within 1 s on the happy path, prints nothing but its JSON output, and logs errors to `~/.cerebro/logs/client.log` instead of stderr.
- SessionEnd hooks get ~1.5 s in total (Claude Code budget, not raisable by plugins): the SessionEnd handler only captures to the local queue and spawns a detached uploader.
- No network call in any hook except SessionStart's binding lookup, which has a 1500 ms timeout and falls back to the local binding cache.
- Secrets are stripped on the Mac before anything is queued: `redactSecrets` from `@cerebro/shared` on every text, tool input and meta string.
- Nothing is sent (token included) until `GET /health` returns the `instanceId` pinned for this install; a mismatch stops uploading and is reported at the next SessionStart.
- Event key = `<transcript entry uuid>:<content block index>` (unique per session on the server); `seq` = `lineNumber * 16 + blockIndex`.
- Batches: ≤ 2000 events, ≤ 8 MB serialized; a single event's text is truncated to 8 MB with the marker `\n[truncated by cerebro: <n> bytes total]`; image blocks become the text `[image]`.
- Upload responses: 2xx → drop accepted and duplicate items from the queue, move `rejected` items to quarantine; 413 → halve the batch and retry; 5xx or network error → back off (30 s doubling to 30 min); 401 `token_revoked` → stop uploading and report; 401 `unauthorized` → stop and report.
- Every agent's history goes through a `HistorySource` adapter in `client/src/sources/`; sessions carry `meta.agent` (`claude-code`, `claude-code-subagent`, `codex`, `gemini-cli`, or the name given in a generic-format file) and the same folder binding, scoping, redaction and opt-in rules apply to every agent. A folder that is not bound (or is declined) is not recorded for any agent.
- Interactive sessions only: capture is skipped when `CEREBRO_HEADLESS=1` (the plan-3 summariser sets it), or when the transcript's first entry has an `entrypoint` starting with `sdk`.
- Subfolder identity comes from `git rev-parse --show-prefix` (real path), the repo from the `origin` remote (else the first remote), non-git folders from `pathIdentity(machine, realpath(cwd))`.
- The transcript format is internal to Claude Code and may change: all parsing lives in `client/src/transcript.ts`; unknown entry types and blocks are skipped and counted, never fatal.
- Every commit message ends with `Claude-Session: https://claude.ai/code/session_01LTKLaRsEuQTEb2o763vgdu`.

## Review Focus

1. **A half-written last line** (hook fires while Claude Code is still writing the transcript) → that line is not ingested in truncated form; it is picked up complete on the next capture. Test in Task 3 and Task 5.
2. **Server unreachable for days** (travelling laptop, Zima down) → hooks stay under 1 s, the queue keeps everything, the next reachable flush uploads it all in order. Test in Task 6 and Task 7.
3. **An impostor answering `cerebro.home.lab`** (captive portal, other network) → the token and transcript are never sent. Test in Task 6.
4. **Transcript format drift** (unknown entry type, unknown block type, missing uuid) → skipped and counted, other entries still recorded. Test in Task 3.
5. **Two hooks, flushes or syncs at once** (several sessions open, Stop and SessionEnd overlapping) → no SQLite "database is locked" failures and nothing uploaded twice. Test in Task 4 and Task 6.

---

## File Structure

```
package.json                         + "client" workspace
client/package.json                  @cerebro/client; deps @modelcontextprotocol/sdk, zod, @cerebro/shared
client/src/paths.ts                  cerebroHome(), file locations
client/src/config.ts                 loadClientConfig(): env (plugin userConfig) > ~/.cerebro/config.json
client/src/log.ts                    logError(), logInfo() → ~/.cerebro/logs/client.log (rotated at 5 MB)
client/src/api.ts                    ApiClient (typed wrapper over the server API) + ApiError
client/src/identity.ts               folderIdentity(cwd, machine)
client/src/sources/types.ts          HistorySource interface, SourceRecordBatch
client/src/sources/lines.ts          readCompleteLines() (shared JSONL tailing)
client/src/sources/claude-code.ts    Claude Code transcripts (main sessions)
client/src/sources/claude-subagents.ts  Claude Code subagent transcripts (<session>/subagents/*.jsonl)
client/src/sources/codex.ts          Codex CLI rollouts (~/.codex/sessions/**/rollout-*.jsonl)
client/src/sources/gemini.ts         Gemini CLI prompt logs (~/.gemini/tmp/<sha256(project)>/logs.json)
client/src/sources/generic.ts        "cerebro-jsonl v1" files (import-file + ~/.cerebro/inbox/)
client/src/sources/index.ts          registry: allSources(), sourceFor(path)
client/src/sync.ts                   syncAllSources(): sweep every adapter through capture
client/src/schedule.ts               install/remove a launchd agent running `cerebro sync` every 30 min
client/src/store.ts                  Store (bun:sqlite): queue, cursors, quarantine, binding cache, state
client/src/capture.ts                captureTranscript()
client/src/flush.ts                  flush()
client/src/brief.ts                  buildBrief()
client/src/hooks.ts                  handleHook(event, input)
client/src/spawn.ts                  spawnDetached(args)
client/src/importer.ts               importFolder()
client/src/mcp.ts                    startMcpServer()
client/src/cli.ts                    entry: hook | flush | import | sync | import-file | schedule | mcp | status | retention | reset-instance
docs/cerebro-jsonl.md                the generic import format, for agents without an adapter
client/test/harness.ts               liveServer(): real server app + throwaway DB, ApiClient wired to it
client/test/fixtures/*.jsonl         trimmed real transcripts (redacted)
plugin/.claude-plugin/plugin.json    manifest + userConfig (server_url, token[sensitive])
plugin/hooks/hooks.json              SessionStart, Stop, PreCompact, SessionEnd → bin/cerebro hook <event>
plugin/.mcp.json                     cerebro → bin/cerebro mcp (env from user_config)
plugin/skills/cerebro/SKILL.md       opt-in / binding conversation
plugin/bin/cerebro                   POSIX sh shim → bin/cerebro-darwin-<arch>
.claude-plugin/marketplace.json      marketplace "cerebro" → plugin from branch plugin-dist
scripts/release-plugin.sh            compile darwin-arm64 + darwin-x64, publish plugin-dist branch
```

---

### Task 1: Client workspace, config, logging, API client, test harness

**Files:**
- Create: `client/package.json`, `client/src/paths.ts`, `client/src/config.ts`, `client/src/log.ts`, `client/src/api.ts`, `client/test/harness.ts`, `client/test/api.test.ts`
- Modify: `package.json` (workspaces `["shared", "server", "client"]`), `tsconfig.json` (include client)

**Interfaces:**
- Produces:
  - `cerebroHome(): string` — `$CEREBRO_HOME` or `~/.cerebro`; creates it with mode 0700.
  - `interface ClientConfig { serverUrl: string; token: string; }`; `loadClientConfig(env = process.env): ClientConfig | null` — reads `CLAUDE_PLUGIN_OPTION_SERVER_URL` / `CLAUDE_PLUGIN_OPTION_TOKEN` (or `CEREBRO_SERVER_URL` / `CEREBRO_TOKEN`), else `~/.cerebro/config.json`; null when incomplete. `saveClientConfig(c)` writes the file with mode 0600 (used by the CLI outside Claude Code).
  - `logError(where: string, err: unknown): void`, `logInfo(msg: string, data?: object): void` — JSON lines; never throw.
  - `class ApiError extends Error { status: number; code: string }` (`code` from the server envelope, `"network"` for fetch failures, `"timeout"` for aborts).
  - `class ApiClient { constructor(cfg: ClientConfig, fetchFn?: typeof fetch) }` with methods (each takes an optional `{ timeoutMs }`, default 10 000): `health(): Promise<{ ok: boolean; instanceId: string | null; apiVersion: number }>` (no auth header), `status()`, `resolve(repo, subpath)`, `putBinding(b & { rebind?: boolean })`, `listClients()`, `createClient(name)`, `listProjects(clientId)`, `createProject(clientId, name)`, `adopt(bindingId)`, `ingest(batch): Promise<IngestResult>`, `endSession(id, endedAt)`, `search(req)`, `sessions(q)`, `events(sessionId, q)`. Types come from `@cerebro/shared`.
  - Test harness `liveServer(): Promise<{ api: ApiClient; fetch: typeof fetch; sql; instanceId: string; token: string; drop(): Promise<void> }>` — builds the server app with `createApp` + `freshDb` + `createToken`, and a `fetch` that routes `http://cerebro.test/*` to `app.request`.

- [ ] **Step 1: Write failing tests `client/test/api.test.ts`**

```ts
test("health needs no token and returns the instance id", async () => { /* api.health() → { ok: true, instanceId: h.instanceId } and the stub fetch saw no Authorization header */ });
test("server error envelopes become ApiError with status and code", async () => {
  // api with a revoked token → status() rejects ApiError { status: 401, code: "token_revoked" }
  // search({ query: "x" }) without scope → ApiError { status: 400, code: "scope_required" }
});
test("network failures and timeouts are ApiError codes", async () => {
  // fetch that throws TypeError → code "network"; fetch that never resolves + timeoutMs 50 → code "timeout"
});
test("config prefers plugin options over the config file", () => {
  // CEREBRO_HOME=tmp with config.json {serverUrl:"http://file", token:"f"}; env CLAUDE_PLUGIN_OPTION_SERVER_URL="http://env" + TOKEN="e" → env wins; no env → file; neither → null; file mode is 0600 after saveClientConfig
});
```

- [ ] **Step 2: Run** `bun test client/test/api.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. `ApiClient` sends `Authorization: Bearer <token>` on `/v1/*` only, uses `AbortSignal.timeout`, and parses `{error, message}` bodies into `ApiError`.
- [ ] **Step 4: Run** → PASS; `bun run typecheck` clean.
- [ ] **Step 5: Commit** `feat(client): workspace, config, logging, API client`.

---

### Task 2: Folder identity

**Files:**
- Create: `client/src/identity.ts`, `client/test/identity.test.ts`

**Interfaces:**
- Consumes: `normalizeRemote`, `pathIdentity` from `@cerebro/shared`.
- Produces: `interface FolderIdentity { repo: string; subpath: string; root: string; isGit: boolean }`; `folderIdentity(cwd: string, machine: string): FolderIdentity` — uses `git -C <cwd> rev-parse --show-toplevel` and `--show-prefix` (trailing `/` trimmed), `git remote get-url origin` else the first of `git remote`; a repo with no remote, or no git, gets `pathIdentity(machine, realpathSync(root or cwd))` and `subpath ""`. Never throws: an unreadable cwd yields `pathIdentity(machine, cwd)`.

- [ ] **Step 1: Write failing tests** (each creates temp dirs with `git init`):

```ts
test("git repo with origin: normalised remote and repo-relative subpath", () => {
  // remote git@github.com:Acme/App.git, cwd <root>/apps/web → { repo: "github.com/acme/app", subpath: "apps/web", isGit: true }
});
test("subpath comes from the real path, not a differently-cased or symlinked cwd", () => {
  // symlink /tmp/x/link → <root>/apps; cwd link/web → subpath "apps/web"
});
test("no origin falls back to the first remote; no remote falls back to a path identity", () => {});
test("non-git folder is a machine-specific path identity", () => { /* repo === `path:mac-a:${realpath}` */ });
test("a missing cwd never throws", () => { /* folderIdentity("/nope/x", "m").repo === "path:m:/nope/x" */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `Bun.spawnSync` (timeout 1000 ms per git call). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): folder identity from git`.

---

### Task 3: History source interface and the Claude Code adapter

**Files:**
- Create: `client/src/sources/types.ts`, `client/src/sources/lines.ts`, `client/src/sources/claude-code.ts`, `client/test/claude-code-source.test.ts`, `client/test/fixtures/session-basic.jsonl`, `client/test/fixtures/session-drift.jsonl`
- Fixture source: trim 30–60 lines from a real transcript in `~/.claude/projects/` (one with text, thinking, tool_use, tool_result string and array content, an image), replace all text with neutral content, keep the structure exactly.

**Interfaces:**
- Consumes: `IngestEvent`, `redactSecrets`, `storable` from `@cerebro/shared`.
- Produces:
  - In `sources/types.ts` — the contract every agent adapter implements:
    ```ts
    export interface SourceFile { source: string; path: string; sessionId: string; cwd: string | null; modifiedMs: number }
    export interface SourceRead {
      events: IngestEvent[]; sessionMeta: Record<string, unknown>; cwd: string | null; firstTimestamp: string | null;
      headless: boolean; skipped: number; nextOffset: number; nextLine: number; state?: unknown;
    }
    export interface HistorySource {
      id: string;                                   // "claude-code", "codex", …; becomes meta.agent
      live: boolean;                                // true only for claude-code (captured by hooks)
      discover(roots?: { home?: string }): Promise<SourceFile[]>;
      read(file: SourceFile, cursor: { offset: number; line: number; state?: unknown }): SourceRead;
    }
    ```
    `sessionId` is the agent's own session id prefixed for non-Claude agents (`codex:<id>`, `gemini:<id>`, `<agent>:<id>` for generic files) so ids never collide across agents. `state` is adapter-private data persisted with the cursor (e.g. Claude Code's tool-name map).
  - `readCompleteLines(path: string, fromOffset: number, fromLine: number): { lines: { lineNo: number; text: string }[]; nextOffset: number; nextLine: number }` — reads from byte `fromOffset`, returns only newline-terminated lines; a trailing partial line is left for next time (offsets advance only past `\n`). Reads at most 16 MB per call.
  - `interface NormalizeResult { events: IngestEvent[]; sessionMeta: Record<string, unknown>; firstTimestamp: string | null; entrypoint: string | null; skipped: number }`
  - `claudeCodeSource: HistorySource` (`id "claude-code"`, `live: true`) — `discover` lists `<home>/.claude/projects/*/*.jsonl`; `read` = `readCompleteLines` + `normalizeEntries`, `headless` from the first entry's `entrypoint`.
  - `normalizeEntries(lines: { lineNo: number; text: string }[], sessionId: string, toolNames: Map<string, string>): NormalizeResult` — rules:
    - only entries with `type` `user` or `assistant`, a string `uuid` and a parseable `timestamp`; everything else (other types, bad JSON, missing uuid) increments `skipped`;
    - `message.content` string → one event (`user`/`assistant` by entry type); array → one event per block, `key = uuid:index`, `seq = lineNo*16 + index` (index capped at 15, further blocks skipped);
    - block `text` → kind from entry type; `tool_use` → `tool_call` with `toolName = name`, `toolInput = input`, and `toolNames.set(id, name)`; `tool_result` → `tool_result` with `toolName = toolNames.get(tool_use_id) ?? null`, text = string content or the `text` parts of array content joined with `\n` (non-text parts become `[image]` / `[<type>]`); `thinking` → `assistant` with text `""` and `meta.thinking`; `image` → text `[image]`; unknown block type → skipped;
    - every event's `meta` gets `{ uuid, parentUuid?, isSidechain?, model?, gitBranch?, version?, entrypoint? }` when present; `sessionMeta` collects `gitBranch`, `version`, `entrypoint` from the first entry having them;
    - text over 8 MB truncated with the global marker; all strings passed through `storable` then `redactSecrets` (keys and identifiers through `storable` only).

- [ ] **Step 1: Write failing tests**

```ts
test("a partial last line is left for the next read", () => {
  // file "A\nB\nC-partial" → lines A,B; nextOffset points at "C"; after appending "-done\n" the next call returns "C-partial-done"
});
test("basic fixture becomes ordered events with stable keys and seqs", () => {
  // every key matches /^[0-9a-f-]{36}:\d+$/; seqs strictly increasing; kinds include user, assistant, tool_call, tool_result
  // a tool_result's toolName equals the name of the tool_use with its tool_use_id
});
test("thinking goes to meta, images become placeholders, secrets are redacted", () => {
  // thinking block → { kind: "assistant", text: "", meta.thinking: "…" }; image block → text "[image]";
  // a text block containing sk-ant-api03-… → "[REDACTED:anthropic-key]"
});
test("format drift is skipped and counted, never fatal", () => {
  // drift fixture: unknown entry type, unknown block type, missing uuid, malformed JSON line, 20 blocks in one entry
  // → skipped equals the number of bad records written into the fixture (state that number in a comment at the top of the fixture;
  //   blocks past index 15 count one each), and every well-formed entry in the same file is present
});
test("normalising the same lines twice gives identical keys (idempotent upload)", () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): history source interface and Claude Code adapter`.

---

### Task 4: Local store (queue, cursors, quarantine, binding cache)

**Files:**
- Create: `client/src/store.ts`, `client/test/store.test.ts`

**Interfaces:**
- Produces: `class Store` opened at `<cerebroHome>/cerebro.db` with `journal_mode=WAL`, `busy_timeout=5000`. Tables and methods:
  - `cursors(transcript_path pk, source, session_id, offset, line, state json, binding_id, cwd, repo, subpath, done)` — `getCursor(path)`, `setCursor(path, {source, sessionId, offset, line, state, bindingId, cwd, repo, subpath})`, `openCursors(): Cursor[]` (not done), `markDone(path)`. `state` holds adapter-private data (Task 3).
  - `sessions(id pk, json, sent int)` — `upsertSession(s: IngestSession)` (re-marks unsent when changed), `unsentSessions(limit)`, `markSessionsSent(ids)`.
  - `events(session_id, key, seq, json, bytes, primary key(session_id, key))` — `enqueueEvents(events: IngestEvent[])` (`insert or ignore`), `nextEvents(maxEvents, maxBytes): IngestEvent[]` (ordered by rowid), `ackEvents(pairs: {sessionId, key}[])`, `pendingCount()`.
  - `quarantine(session_id, key, json, code, at)` — `quarantineEvents(items: {event, code}[])` (removes them from `events`), `quarantineCount()`.
  - `bindings(repo, subpath, json, at, primary key(repo, subpath))` — `cacheBinding(repo, subpath, b: Binding | null)` (null = known unbound), `cachedBinding(repo, subpath): { binding: Binding | null; at: string } | undefined`.
  - `state(key pk, value)` — `get(key)`, `set(key, value)`; keys used: `instanceId`, `backoffUntil`, `backoffMs`, `blocked` (`"token_revoked" | "unauthorized" | "instance_mismatch" | null`), `lastFlushAt`, `imported:<repo>|<subpath>`.
  - `tryLock(name: string, ttlMs: number): boolean` / `unlock(name)` — row in `locks(name pk, owner_pid, until)`, taken with `begin immediate`; an expired lock or a dead `owner_pid` can be stolen.

- [ ] **Step 1: Write failing tests**

```ts
test("events dedupe on (session, key) and come out in insertion order within size limits", () => {
  // enqueue 3 events twice → pendingCount 3; nextEvents(2, big) → first two; nextEvents(10, bytesOfFirst) → only the first
});
test("ack and quarantine remove events from the queue", () => {});
test("two processes can write at once without 'database is locked'", async () => {
  // spawn 4 `bun -e` children each enqueuing 500 events into the same CEREBRO_HOME → all exit 0, pendingCount 2000
});
test("only one holder gets a lock; a dead holder's lock is stolen", () => {
  // tryLock("flush") twice in one process → true then false; set owner_pid to a non-existent pid → tryLock true
});
test("binding cache distinguishes unknown from known-unbound", () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): sqlite queue, cursors, quarantine, binding cache`.

---

### Task 5: Capture (transcript → queue)

**Files:**
- Create: `client/src/capture.ts`, `client/test/capture.test.ts`

**Interfaces:**
- Consumes: `Store`, `HistorySource`, `claudeCodeSource`, `FolderIdentity`.
- Produces:
  - `interface CaptureInput { sessionId: string; transcriptPath: string; cwd: string; source?: HistorySource }` (default `claudeCodeSource`; `sync` passes other adapters). The session row gets `meta.agent = source.id`.
  - `captureTranscript(store: Store, input: CaptureInput, ident: FolderIdentity, opts?: { imported?: boolean; env?: Record<string,string|undefined> }): { status: "recorded" | "not_bound" | "declined" | "headless" | "missing"; events: number; skipped: number }` — looks up the cached binding for `ident` (Task 7 fills the cache; capture itself makes no network call); `not_bound` and `declined` queue nothing but still advance nothing (a later opt-in re-reads from offset 0); `headless` when `env.CEREBRO_HEADLESS === "1"` or the first normalised entry's entrypoint starts with `sdk`; otherwise calls `source.read(file, cursor)` (adapter `state`, e.g. Claude Code's tool-name map capped at 2000 entries, is stored with the cursor), upserts the session (`{id, bindingId, cwd, repo, subpath, startedAt: first timestamp, imported, meta}`) and enqueues events, then advances the cursor.
  - `sweepOpenCursors(store: Store): number` — re-runs capture for every open cursor (uses the stored binding id, cwd and identity in the cursor row; add columns `cwd`, `repo`, `subpath` to `cursors`), so a final message written after the last hook is still captured. Returns events queued.

- [ ] **Step 1: Write failing tests**

```ts
test("records only bound folders and only new complete lines", () => {
  // cache an active binding; transcript with 2 complete lines + 1 partial → 2 lines' events queued; append rest → next capture queues the third only
});
test("declined, unbound and headless sessions queue nothing", () => {
  // declined binding → "declined"; no cache entry → "not_bound"; CEREBRO_HEADLESS=1 → "headless"; entrypoint "sdk-ts" → "headless"
});
test("opting in later captures the whole session from the start", () => {
  // capture while unbound → nothing; cache binding; capture → all lines
});
test("tool names survive across captures", () => {
  // tool_use in first capture, its tool_result in the second → tool_result.toolName set
});
test("sweep picks up lines written after the last hook", () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): capture transcripts into the local queue`.

---

### Task 6: Flush (queue → server)

**Files:**
- Create: `client/src/flush.ts`, `client/test/flush.test.ts`

**Interfaces:**
- Consumes: `Store`, `ApiClient`, `sweepOpenCursors`.
- Produces: `flush(store: Store, api: ApiClient, opts?: { maxEvents?: number; maxBytes?: number; deadlineMs?: number; now?: () => number }): Promise<{ sent: number; duplicates: number; quarantined: number; outcome: "done" | "nothing" | "locked" | "backoff" | "unreachable" | "blocked" | "instance_mismatch" }>` — in order:
  1. `tryLock("flush", 10 min)` else `locked`; honour `backoffUntil` and `blocked` (`blocked` is cleared only by `cerebro status --retry` or a config change);
  2. `sweepOpenCursors`;
  3. preflight `api.health({ timeoutMs: 3000 })`: unreachable → backoff; `instanceId` differs from the stored one → set `blocked = "instance_mismatch"`, return without sending; no stored id → pin it;
  4. loop until empty or `deadlineMs` (default 120 000): send `unsentSessions(200)` plus `nextEvents(maxEvents=2000, maxBytes=8 MB)` whose sessions are known (include the session row of every event's session in the batch); on 200 → `markSessionsSent`, `ackEvents` for everything not in `rejected`, `quarantineEvents` for rejected events (`unknown_session` for a session the server rejected as `unknown_binding` → also drop that session's cursor so it stops capturing, and clear its binding cache entry); on 413 → halve `maxEvents`/`maxBytes` (minimum 1 event) and retry; on 5xx/`network`/`timeout` → `backoffMs` 30 s doubling to 30 min, return `unreachable`; on 401 → `blocked = code`, return `blocked`;
  5. on success reset backoff, set `lastFlushAt`, unlock.

- [ ] **Step 1: Write failing tests** (all against `liveServer()`):

```ts
test("uploads queued sessions and events, then the queue is empty", async () => {});
test("replaying after a crash mid-flush uploads nothing twice", async () => {
  // flush, then re-enqueue the same events (simulating an un-acked batch) → second flush: duplicates === n, server count unchanged
});
test("an impostor server never receives the token or data", async () => {
  // pin instanceId A; api whose fetch serves /health with instanceId B and records every request
  // → outcome "instance_mismatch", recorded requests are exactly [GET /health] with no Authorization header
});
test("unreachable server backs off and keeps everything", async () => {
  // fetch throws → "unreachable", pendingCount unchanged, backoffUntil ~30 s later; immediate second flush → "backoff"
});
test("413 halves the batch until it fits", async () => { /* fetch wrapper returns 413 while body > 3 events → all sent */ });
test("rejected items are quarantined and the rest is acknowledged", async () => {
  // one event with ts "0000-01-01T00:00:00Z" in the queue → quarantineCount 1, pendingCount 0
});
test("a revoked token stops uploading until retried", async () => { /* revokeToken → "blocked", state blocked "token_revoked" */ });
test("concurrent flushes never send the same batch twice", async () => {
  // two flush() in parallel → one returns "locked"; server event count == queued count
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): resilient uploader with instance check, backoff, split and quarantine`.

---

### Task 7: Hook handlers, brief, detached uploader, plugin wiring

**Files:**
- Create: `client/src/hooks.ts`, `client/src/brief.ts`, `client/src/spawn.ts`, `client/src/cli.ts`, `client/test/hooks.test.ts`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`, `plugin/bin/cerebro`, `client/test/shim.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `spawnDetached(args: string[]): void` — `child_process.spawn(process.execPath, [...selfArgs, ...args], { detached: true, stdio: "ignore", env: process.env }).unref()`; when running under `bun` (tests) `selfArgs` is `[client/src/cli.ts]`, in the compiled binary it is `[]`.
  - `buildBrief(binding: Binding, scopeName: string, recent: SessionView[], queue: { pending: number; quarantined: number }, problems: string[]): string` — ≤ 1500 characters: who/what the folder is bound to, the last ≤ 5 sessions (date, machine), pending upload count, any problem lines, and one line on the `cerebro_search` / `cerebro_sessions` / `cerebro_read` tools. Plan 3 replaces the session list with the project state.
  - `handleHook(event: "SessionStart" | "Stop" | "PreCompact" | "SessionEnd", input: HookInput, deps: { store; api: ApiClient | null; machine: string | null; env }): Promise<string>` — returns the stdout to print (JSON or ""). Behaviour:
    - **SessionStart**: compute `folderIdentity`; `api.resolve` with 1500 ms timeout → cache result (on failure use the cache); register the cursor (`setCursor` with offset 0 if new); then
      - no config → `additionalContext` telling Claude that Cerebro is installed but not configured (enable the plugin's settings);
      - unknown folder (resolve said null, or no cache and server unreachable) → `additionalContext`: `"Cerebro memory is installed but this folder is not set up. Before starting the user's task, use the cerebro skill to ask whether to use Cerebro here."` (only when resolve succeeded; offline + uncached → say nothing);
      - declined → `""`;
      - active → brief from `api.sessions({repo, subpath, limit: 5})` (1500 ms timeout, else cached brief in `state`), plus problem lines for `blocked`/`instance_mismatch`/quarantine; if `state imported:<repo>|<subpath>` is unset → `spawnDetached(["import", "--cwd", cwd])`;
      - always `spawnDetached(["flush"])`.
    - **Stop / PreCompact**: `captureTranscript` then `spawnDetached(["flush"])`; returns `""`.
    - **SessionEnd**: `captureTranscript`, `markDone(path)` unless `reason === "clear"`, `spawnDetached(["flush", "--end", sessionId, nowIso])` (flush calls `api.endSession` after uploading); returns `""`. No network in the hook.
  - `cli.ts`: `cerebro hook <event>` reads stdin JSON, runs `handleHook` inside try/catch (errors → `logError`, print `""`), always exits 0. Also `flush [--end <id> <iso>]`, `import --cwd <dir>`, `mcp`, `status [--retry]`, `retention [--days N]`, `reset-instance`.
  - `plugin/.claude-plugin/plugin.json`: `name "cerebro"`, `version` from `client/package.json`, `userConfig`: `server_url` (string, required, default `http://cerebro.home.lab`), `token` (string, required, `sensitive: true`).
  - `plugin/hooks/hooks.json`: `{"hooks": {"SessionStart": [...], "Stop": [...], "PreCompact": [...], "SessionEnd": [...]}}`, each one command hook in exec form: command `${CLAUDE_PLUGIN_ROOT}/bin/cerebro`, args `["hook", "<Event>"]`, `timeout` 5 (SessionStart 10).
  - `plugin/bin/cerebro`: POSIX sh; picks `cerebro-darwin-arm64` or `cerebro-darwin-x64` by `uname -m` next to itself and `exec`s it; if missing, prints nothing and exits 0 (so a broken install never blocks a session).

- [ ] **Step 1: Write failing tests**

```ts
// hooks.test.ts (liveServer + temp CEREBRO_HOME + temp git repo + a transcript file; spawnDetached stubbed to record calls)
test("unknown folder: SessionStart asks Claude to run the cerebro skill", async () => {});
test("bound folder: SessionStart returns a brief under 1500 chars and schedules import once", async () => {
  // first SessionStart → spawn calls include ["import","--cwd",dir] and ["flush"]; after state imported:* set → no import call
});
test("declined folder: SessionStart prints nothing", async () => {});
test("server down: SessionStart answers from the cache within 2 s and never throws", async () => {});
test("Stop captures then schedules a flush; SessionEnd does no network I/O", async () => {
  // SessionEnd with an api whose fetch throws if called → returns "" and queue has the session's events
});
test("hook CLI never exits non-zero, even on garbage stdin", () => {
  // Bun.spawnSync(["bun","client/src/cli.ts","hook","Stop"], { stdin: "not json" }) → exitCode 0, stdout ""
});
// shim.test.ts
test("shim runs the arch binary and is silent when it is missing", () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `bun run typecheck`.
- [ ] **Step 5: Verify hook latency**: in a test, time 20 consecutive `cerebro hook Stop` runs via `bun client/src/cli.ts` against a 5,000-line transcript → median under 300 ms (compiled binary will be faster).
- [ ] **Step 6: Commit** `feat(client): hook handlers, session brief, detached uploader, plugin manifest and hooks`.

---

### Task 8: History import

**Files:**
- Create: `client/src/importer.ts`, `client/test/importer.test.ts`

**Interfaces:**
- Consumes: `Store`, `ApiClient`, `folderIdentity`, `captureTranscript`.
- Produces: `importFolder(store: Store, api: ApiClient, cwd: string, machine: string, opts?: { home?: string; sources?: HistorySource[] }): Promise<{ sessions: number; events: number; skipped: number; bySource: Record<string, number> }>` — computes the folder's identity and root; runs `discover` on every registered source (default `allSources()`, so Claude Code, its subagents, Codex, Gemini and inbox files are all imported); for each file uses `file.cwd` (or the first record's cwd); keeps files whose `cwd` is the root or under it (`realpath` both sides; same machine only); resolves each file's own subfolder binding via `api.resolve(repo, subpathOf(entry.cwd))` (so a monorepo's subfolders land in the right project; results cached per subpath); skips declined/unbound/headless; captures each with `{ imported: true }` from offset 0 (the cursor then marks the file done unless it was modified in the last 10 minutes, i.e. a live session); sets `imported:<repo>|<subpath>` in `state` when finished; then runs `flush`. Holds `tryLock("import:<repo>|<subpath>", 1 h)`.

- [ ] **Step 1: Write failing tests** (temp projects dir with 3 transcript files: two under the folder, one elsewhere; one with entrypoint `sdk-cli`)

```ts
test("imports only this folder's past sessions, marked imported", async () => {
  // → sessions 1 (the sdk one skipped, the other folder ignored); server session has imported: true
});
test("monorepo subfolder sessions go to their own binding", async () => {});
test("running the import twice uploads nothing new", async () => {});
test("a live transcript keeps its cursor open for further capture", async () => {});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): import a folder's past conversations`.

---

### Task 9: Per-agent history extractors and `cerebro sync`

**Files:**
- Create: `client/src/sources/claude-subagents.ts`, `client/src/sources/codex.ts`, `client/src/sources/gemini.ts`, `client/src/sources/generic.ts`, `client/src/sources/index.ts`, `client/src/sync.ts`, `client/src/schedule.ts`, `docs/cerebro-jsonl.md`, `client/test/sources.test.ts`, `client/test/sync.test.ts`, fixtures `client/test/fixtures/codex-rollout.jsonl`, `client/test/fixtures/gemini-logs.json`, `client/test/fixtures/subagent.jsonl`, `client/test/fixtures/generic.jsonl` (trimmed, neutralised copies of real files from this Mac)

**Interfaces:**
- Consumes: `HistorySource`, `readCompleteLines`, `normalizeEntries`, `captureTranscript`, `folderIdentity`, `Store`, `flush`.
- Produces — one adapter per agent, each a `HistorySource`, all with `live: false`:
  - `claudeSubagentsSource` (`id "claude-code-subagent"`): `discover` lists `~/.claude/projects/*/<session>/subagents/*.jsonl`; same normaliser as Claude Code; session id `<parentSessionId>/agent-<file stem>`, `sessionMeta.parentSessionId`, `sessionMeta.agentType` when present; cwd from the parent transcript's first entry when the subagent file has none.
  - `codexSource` (`id "codex"`): `discover` lists `~/.codex/sessions/**/rollout-*.jsonl`; the first line (`type: "session_meta"`) gives `payload.id` (session id `codex:<id>`), `payload.cwd`, `payload.git.repository_url` (used as the repo identity when present, normalised), `payload.git.branch`, `payload.cli_version`, `payload.originator`. Records: `response_item` with `payload.type "message"` → `user`/`assistant` from `role` (skip `developer`/`system`), text = joined `input_text`/`output_text` parts; `function_call`/`custom_tool_call` → `tool_call` (`toolName = name`, `toolInput` = parsed `arguments` JSON or the raw `input`); `function_call_output`/`custom_tool_call_output` → `tool_result` (tool name via `call_id`); `reasoning` → `assistant` with text "" and `meta.reasoning` (summary text); everything else (`event_msg`, `turn_context`, `ghost_snapshot`, …) skipped and counted. Key = `<lineNo>:<blockIndex>` (Codex records have no uuid; the file is append-only so line numbers are stable), `seq = lineNo * 16 + blockIndex`.
  - `geminiSource` (`id "gemini-cli"`): `discover` lists `~/.gemini/tmp/<hash>/logs.json`; the project folder is found by matching `<hash>` against `sha256(realpath)` of the folder being imported (sync passes the bound folders it knows), unmatched files are skipped; records are user prompts only (`type "user"`) → `user` events, session id `gemini:<sessionId>`, key `<messageId>`. The file is a JSON array rewritten in place, so the cursor stores the count of records already sent instead of a byte offset.
  - `genericSource` (`id` from the file): reads the documented **cerebro-jsonl v1** format (`docs/cerebro-jsonl.md`): line 1 `{"type":"session","agent":"<name>","id":"<agent session id>","cwd":"/abs/path","repo"?: "<git remote>","startedAt":"<iso>","meta"?: {}}`, then `{"type":"event","key":"<unique in session>","ts":"<iso>","kind":"user|assistant|tool_call|tool_result","text":"…","toolName"?,"toolInput"?,"meta"?}` lines; session id `<agent>:<id>`; `discover` lists `~/.cerebro/inbox/*.jsonl`; files are moved to `~/.cerebro/inbox/done/` once fully read. This is how agents without an adapter (Hermes, Paperclip, scripts, other tools) hand over their history.
  - `allSources(): HistorySource[]` (claude-code, claude-code-subagent, codex, gemini-cli, generic) and `sourceFor(path: string): HistorySource | null`.
  - `syncAllSources(store: Store, api: ApiClient | null, machine: string, opts?: { home?: string; sources?: HistorySource[] }): Promise<{ bySource: Record<string, { files: number; events: number; skipped: number }> }>` — holds `tryLock("sync", 30 min)`; for every non-live source, `discover`, compute `folderIdentity(file.cwd)`, resolve the binding through the cache (refreshing unknown identities with `api.resolve` when reachable, 1500 ms each, at most 50 per run), and `captureTranscript` with that source; unbound/declined files are left at offset 0 so opting in later picks them up; then `flush`.
  - CLI: `cerebro sync`; `cerebro import-file <path> [--agent <name>]` (validates the file against the format and copies it into the inbox, then syncs); `cerebro schedule [--off]` installs/removes `~/Library/LaunchAgents/dev.cerebro.sync.plist` running `cerebro sync` every 1800 s (`StartInterval`), logs to `~/.cerebro/logs/sync.log`.
  - Hooks: SessionStart also `spawnDetached(["sync"])` when `state lastSyncAt` is older than 1 hour.

- [ ] **Step 1: Write failing tests**

```ts
// sources.test.ts
test("codex rollout → user/assistant/tool events, repo identity from the git url, codex: session id", () => {
  // fixture → sessionId "codex:<payload.id>", events kinds include user, assistant, tool_call, tool_result;
  // tool_result.toolName equals its function_call name; developer messages and event_msg lines are skipped and counted
});
test("subagent transcripts become their own session linked to the parent", () => {
  // sessionId "<parent>/agent-<stem>", sessionMeta.parentSessionId === parent, meta.agent "claude-code-subagent"
});
test("gemini logs map to the project whose sha256 path matches, prompts only, cursor by record count", () => {});
test("generic cerebro-jsonl files import; malformed lines are skipped and counted; finished files move to done/", () => {});
test("every adapter redacts secrets and never throws on drift", () => {
  // for each adapter: a record with sk-ant-… is redacted; a garbage line increments skipped
});
// sync.test.ts (liveServer, temp home with .claude, .codex, .gemini, .cerebro/inbox)
test("sync records every agent's sessions for a bound folder and nothing for an unbound one", async () => {
  // server sessions have meta.agent in { claude-code-subagent, codex, gemini-cli, my-agent } for the bound folder only
});
test("binding a folder later picks up history that sync skipped earlier", async () => {});
test("sync twice uploads nothing new; a growing codex file uploads only the new lines", async () => {});
test("schedule writes a launchd plist running `cerebro sync` every 1800 s and --off removes it", () => { /* HOME=tmp */ });
```

- [ ] **Step 2: Run** `bun test client/test/sources.test.ts client/test/sync.test.ts` → FAIL.
- [ ] **Step 3: Implement** the adapters, registry, sync, schedule and `docs/cerebro-jsonl.md` (format, an example file, and a 10-line example exporter in TypeScript).
- [ ] **Step 4: Run** → PASS; `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(client): per-agent history extractors (subagents, Codex, Gemini, generic) and cerebro sync`.

---

### Task 10: MCP server (recall + setup tools)

**Files:**
- Create: `client/src/mcp.ts`, `client/test/mcp.test.ts`, `plugin/.mcp.json`

**Interfaces:**
- Consumes: `ApiClient`, `Store`, `folderIdentity`, `importFolder`, `spawnDetached`.
- Produces: `createMcpServer(deps: { api: ApiClient; store: Store; cwd: string; machine: string }): McpServer` and `startMcpServer()` (stdio; `cwd` = `CLAUDE_PROJECT_DIR` or `process.cwd()`). Tools — every recall call sends this folder's `repo`/`subpath`, never `scope: "open"`, so the server's project lock always applies:
  - `cerebro_search { query: string; from?: string; to?: string; limit?: number }` → compact hits: `sessionId, firstSeq, lastSeq, when (tsFrom–tsTo), where (client/project), snippet, matched`; notes `degraded` when set.
  - `cerebro_sessions { from?: string; to?: string; limit?: number; before?: string }`.
  - `cerebro_read { session_id: string; after_seq?: number; limit?: number; full?: boolean }` → events as `[seq] kind (tool) text`; returns `next_seq`.
  - `cerebro_folder {}` → identity, current binding (with client/project names), and the client list with each client's projects (for the skill).
  - `cerebro_bind { client: string; project?: string; whole_repo?: boolean; rebind?: boolean }` → creates the client/project if new, `PUT /v1/bindings` for the repo root (`whole_repo` true, default) or this subfolder; updates the binding cache; spawns `import --cwd`; if a subfolder binding was created and sessions exist under the repo, says so and suggests `cerebro_adopt`.
  - `cerebro_decline {}` → declined binding for this folder (sends `rebind: true` only if the skill passes it after the user confirmed); updates the cache.
  - `cerebro_adopt {}` → `POST /v1/bindings/:id/adopt` for this folder's binding.
  - Errors are returned as tool error text with the server's `message`, never thrown.
  - `plugin/.mcp.json`: server `cerebro`, command `${CLAUDE_PLUGIN_ROOT}/bin/cerebro`, args `["mcp"]`, env `CEREBRO_SERVER_URL: "${user_config.server_url}"`, `CEREBRO_TOKEN: "${user_config.token}"`.

- [ ] **Step 1: Write failing tests** (in-process MCP client from the SDK over an in-memory transport, liveServer)

```ts
test("search from a project-bound folder never sees another project", async () => {});
test("bind creates client/project, caches the binding and schedules an import", async () => {});
test("binding a subfolder in a repo with history suggests adopt; adopt moves them", async () => {});
test("decline caches a declined binding so capture stops", async () => {});
test("read pages through a session with next_seq", async () => {});
test("server errors come back as tool errors, not crashes", async () => { /* rebind needed → error text mentions rebind */ });
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(client): MCP recall and setup tools`.

---

### Task 11: Opt-in skill, retention, status CLI

**Files:**
- Create: `plugin/skills/cerebro/SKILL.md`, `client/test/cli.test.ts`
- Modify: `client/src/cli.ts`

**Interfaces:**
- Produces:
  - `SKILL.md` frontmatter: `name: cerebro`, `description: Use when Cerebro says this folder is not set up, or when the user wants to change which client/project this folder belongs to, stop recording here, or check Cerebro's status.` Body (the conversation, in order): call `cerebro_folder`; ask with AskUserQuestion "Is this a new project? Do you want to use Cerebro on it?"; if no → `cerebro_decline` and say it won't ask again here; if yes → ask which client (existing ones as options + "Personal" + "New client…"), then which project (existing for that client + "New project…" + "No project"), then whether to bind the whole repo or only this subfolder (only when `subpath` is non-empty); call `cerebro_bind`; if it suggests adopt, ask before `cerebro_adopt`; changing an existing binding: show current vs new and get explicit confirmation before passing `rebind: true`. Then tell the user that past conversations for this folder — from Claude Code, its subagents, Codex and Gemini CLI — are being imported in the background, and that `cerebro schedule` keeps other agents' new sessions flowing in (offer to run it). (Plan 3 adds: "then build an initial project history".)
  - `cerebro status` prints: server, machine, instance pin, queue pending/quarantined, last flush, blocked reason, cursors open; `--retry` clears `blocked` and backoff and runs a flush.
  - `cerebro retention [--days N]` sets `cleanupPeriodDays` (default 36500) in `~/.claude/settings.json`, preserving every other key, after printing the current value; idempotent.
  - `cerebro reset-instance` clears the pinned `instanceId` (for a reinstalled server).

- [ ] **Step 1: Write failing tests**

```ts
test("retention raises cleanupPeriodDays and keeps the rest of settings.json", () => {});
test("status reports a blocked uploader and --retry clears it", async () => {});
test("the skill file has the required frontmatter and names every MCP tool it uses", () => {
  // parse SKILL.md frontmatter; body mentions cerebro_folder, cerebro_bind, cerebro_decline, cerebro_adopt
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plugin): opt-in skill, status and retention commands`.

---

### Task 12: Build, marketplace and release

**Files:**
- Create: `.claude-plugin/marketplace.json`, `scripts/release-plugin.sh`, `client/test/build.test.ts`
- Modify: `README.md` (Install on a Mac section), `.gitignore` (`plugin/bin/cerebro-darwin-*`)

**Interfaces:**
- Produces:
  - `scripts/release-plugin.sh <version>`: `bun build client/src/cli.ts --compile --minify --target=bun-darwin-arm64 --outfile plugin/bin/cerebro-darwin-arm64` and the same for `bun-darwin-x64`; sets `plugin.json` `version`; commits the contents of `plugin/` (with binaries) as a single commit on an orphan branch `plugin-dist` (replacing it), tags `plugin-v<version>`, pushes both. Refuses to run with a dirty tree or failing `bun test`.
  - `.claude-plugin/marketplace.json`: `{"name": "cerebro", "owner": {"name": "Cerebro"}, "plugins": [{"name": "cerebro", "source": {"source": "github", "repo": "<owner>/cerebro", "ref": "plugin-dist"}, "description": "Long-term memory for Claude Code sessions"}]}` — `<owner>/cerebro` is filled in when the GitHub repo exists.
  - README "Install on a Mac": `gh auth login && gh auth setup-git` (private repo access), `claude plugin marketplace add <owner>/cerebro`, `claude plugin install cerebro@cerebro` (Claude Code then prompts for server URL and token — create the token on the server with `cli.ts token create <mac-name>` outside a recorded session), `~/.claude/plugins/.../bin/cerebro retention` (or ask Claude to run it), then open Claude Code in a project.

- [ ] **Step 1: Write failing test `build.test.ts`**: compile the darwin binary for the current arch to a temp path; run `<bin> hook Stop` with empty stdin → exit 0, stdout ""; run `<bin> status` with no config → exit 0 and prints "not configured".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement the script, marketplace and README.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual verification on this Mac** (record results in the ledger):
  1. `claude plugin marketplace add ./` (local path) and `claude plugin install cerebro@cerebro`; enter server URL (dev server) and a token.
  2. Open Claude Code in a scratch git repo → Claude asks the opt-in question; answer yes with a test client.
  3. Have a short conversation; `cerebro status` shows events uploaded; `/v1/search` from curl finds them.
  4. Run `claude -p "say hi"` in that folder with `CEREBRO_HEADLESS=1` → nothing recorded; without it, note what `entrypoint` the transcript shows (expected `cli`; if it is `sdk-*` the capture rule already skips it).
  5. Quit with Ctrl-C mid-session, reopen → the last turn appears on the server after the next flush (sweep).
  6. Opt a folder that has Codex history into Cerebro → `cerebro sync` uploads those Codex sessions (`meta.agent: "codex"`) and `cerebro_search` finds them.
- [ ] **Step 6: Commit** `build(plugin): compiled binaries, marketplace and release script`.
