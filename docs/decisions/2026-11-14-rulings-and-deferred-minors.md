# Cerebro build: rulings and deferred minors

Every decision taken on the owner's behalf during the build (`Ruling:` — what was decided, why, and what it costs if wrong) and every review finding deliberately left for later (`minor (deferred)`), copied verbatim from the per-plan execution ledgers on 2026-11-14, in the order they were made.

## hardening

### Rulings

- Ruling: W1–W4 executed as one block (schema change breaks indexer/search until W3/W4 land); suite must be green at the end of the block, each workstream still test-first — cost if wrong: a longer red window, no shipped effect.
- Ruling: chunker caps indexable text at 32k chars per event (raw kept) — SB-2 — cost if wrong: text past 32k in one message isn't searchable; raw quotes still work.
- Ruling: FTS has no stemming (cerebro = simple + unaccent) — EN/ES mix; vectors cover morphology — cost if wrong: "fixing" won't full-text-match "fixed".
- Ruling: search requires repo or scope:"open"; response echoes the most specific binding (any status) — SA-1/AB-13 — cost if wrong: API consumers must add scope:"open".
- Ruling: the embedder timeout for a single request is classified non-transient (charged to the item); refused connections and 502/503/504 are transient (pause) — cost if wrong: a chunk that always times out dead-letters after 5 tries.
- Ruling: any change to an existing binding (incl. decline) needs rebind:true; history is moved (or held, for decline) — AB-10 + earlier "declined with history" ruling merged — cost if wrong: the skill must send rebind:true after confirming with the owner.
- Ruling: reads require repo/subpath or scope=open like search; session list cursor is "<startedAt>|<id>" — SA-2 — cost if wrong: API consumers add scope=open.
- Ruling: access log records path only (no query string) and onError logs only error name + SQLSTATE — SA-11 — cost if wrong: less detail when debugging; reproduce locally.
- Ruling: last_used_at written at most once a minute, awaited in auth middleware — cost if wrong: one extra cheap UPDATE per machine per minute.

### Deferred minors

- Final: minor (deferred): same-seq collisions not enforced server-side (unique(session_id, seq)); plan-2 adapters guarantee unique seqs
- Final: minor (deferred): migrate waiting on the advisory lock dies at the 30 s DB statement_timeout
- Final: minor (deferred): multi-statement `-- no-transaction` files run as an implicit transaction
- Final: minor (deferred): lock_timeout conceded but not set
- Final: minor (deferred): full=1 byte budget ignores tool_input; non-full pages don't cap user/assistant/tool_input size
- Final: minor (deferred): /v1/status joins the whole embed_queue (slow during a huge import)
- Final: minor (deferred): DB error inside worker store() is charged as an embed failure
- Final: minor (deferred): concurrent creation of the same new binding → 500 (23505) for the loser
- Final: minor (deferred): adopt can pull sessions from a sibling (non-ancestor) binding
- Final: minor (deferred): redaction regex quadratic on pathological input
- Final: minor (deferred): HNSW recall near the 50k exact threshold at 20M chunks (raise max_scan_tuples)
- Final: minor (deferred): OR-prefix fallback adds :* to 1–2 char/numeric terms
- Final: minor (deferred): catalog routes' error envelope lacks message; malformed sessions cursor → 422 instead of 400

## client-plugin

### Rulings

- Owner: "subagent-driven, use worktrees for faster execution" → Ruling: independent tasks run in parallel in agent worktrees (isolation: worktree) and are merged into feat/client-plugin by the controller; dependent tasks run sequentially — overrides the skill's "never parallel implementers" by owner instruction — cost if wrong: merge conflicts (tasks in a wave touch disjoint files).
- | T1→T6,T7,T8,T9,T10 | ApiClient methods | T7 needs flush to end a session (`flush --end`); T6 signature has no end param → Ruling: flush opts gain `end?: { sessionId: string; endedAt: string }`, sent after uploading that session's events — cost: none |
- | T8→T9 | importFolder uses allSources() which T9 creates → Ruling: T8 creates sources/index.ts with allSources() = [claudeCodeSource]; T9 adds the other adapters — cost: none |
- | Global vs T7 | "hooks exit within 1 s" vs SessionStart 1500 ms resolve + 1500 ms sessions | Ruling: the 1 s bound applies to Stop/PreCompact/SessionEnd; SessionStart shares one 1500 ms network budget across resolve and sessions (hooks.json timeout 10 s) — cost: brief may fall back to the cached one more often |
- Task 1: implemented 049c7f7 (worktree branch), merged into feat/client-plugin 6a43204; review pending. Ruling: health() on 503 returns {ok:false, instanceId:null, apiVersion:0} instead of throwing — flush treats it as unreachable — cost: none.
- Task 4: review → Important: markSessionsSent lost-update race; Ruling: re-graded reviewer-Minor "setCursor doesn't reset done" to Important (resumed session's final turn missed by sweep) — fix round 1 dispatched
- Task 3: review → Approved; Ruling: re-graded truncate-before-redact and gitBranch-not-redacted to must-fix (global secret-stripping constraint) — fix round 1 dispatched
- Task 3: Ruling: tool-name map cap 5000 (plan said 2000) stands — bigger map only costs a few hundred KB of state — cost if wrong: none
- Ruling: cli.ts ownership — T7 creates it with `hook` + `flush [--end]`; T9 adds `import --cwd`, `sync`, `import-file`, `schedule`; T10 adds `mcp`; T11 adds `status`, `retention`, `reset-instance` — lets T7/T8 and T9/T10 run in parallel; controller resolves trivial switch-case merge conflicts — cost: none
- Ruling: flush adds an "error" outcome (Store failure/unexpected throw, lock released) — Task 7 must handle it — cost: none
- Task 8: review → Approved; Ruling: re-graded "imported key set after discover/resolve errors" to must-fix (catch-up history silently never retried) + ..foo path bug folded in — fix round 1 dispatched
- Task 6: Ruling: re-graded "pending end with non-404 4xx blocks later ends" to Important — fix round 2 dispatched with stronger 413 regression test
- Ruling: headless = CEREBRO_HEADLESS=1 OR CLAUDE_CODE_ENTRYPOINT starts with "sdk" OR CLAUDE_CODE_SESSION_ATTENDED=0 — applied in hooks (SessionStart returns "", Stop/SessionEnd skip) as well as the transcript entrypoint rule in capture — cost if wrong: an unattended interactive session isn't recorded
- Ruling: Task 7 fix round waits for Task 6 round 3 (shared checkInstance helper touches flush.ts); folded in the reviewer's minors: problem lines before session list in the brief, --end when cursor has a bindingId even if transcript missing, CEREBRO_NO_SPAWN for CLI tests, machine caching keyed on verified instance
- Task 10: Ruling: implementer concern 'unbound folders recall across projects' is the owner's stated rule (no project → may search all clients) — no change — cost: none
- Task 9: Ruling: Codex runs started via `codex exec`/SDK count as headless (spec: interactive sessions only) — cost if wrong: scripted Codex runs not recorded
- Task 9: Ruling: re-graded to must-fix: meta strings skipping redactSecrets; Codex injected <environment_context>/<user_instructions> recorded as user prompts; per-sync head re-reads (~200 MB) — fix round 1 dispatched with merge + queued concerns (launchd config, ~/.cerebro/bin/cerebro link + SKILL.md paths, shared checkInstance)
- Task 9: Ruling: Gemini CLI has no headless marker; `gemini -p` runs that write logs.json are recorded — cost if wrong: some scripted Gemini prompts in memory
- Task 12: dispatched (worktree) in parallel with Task 9 fix round; Ruling: Task 12 implementer skips plan step 5 (manual verification) — the controller runs it after all merges; implementer must not edit SKILL.md (Task 9 fix owns it)
- Ruling: SessionStart (non-headless, env config complete) keeps ~/.cerebro/config.json (0600, atomic write) in sync with the plugin settings; launchd job and Bash-run commands use the file — cost if wrong: the token also lives on disk (0600, in a 0700 dir) as well as in the Keychain; acceptable for a single-user Mac and needed for the background sync
- Final: Ruling: re-graded to must-fix: events > ~4 MB quarantined instead of truncated (truncate at 4 MB, cap toolInput); README misdescribes `retention` and the skill never offers it (spec: owner consent at install); reset-instance leaves machine/binding cache/imported keys stale
- Final: Ruling: event text cap is 4 MB measured as JSON-encoded bytes (plan's Global Constraint said 8 MB raw) — an 8 MB event could never fit the 8 MB batch — cost: very long single messages keep their first 4 MB
- Final: Ruling: reset-instance does not re-send already-recorded history to a reinstalled server (done cursors with old bindingIds stay settled) — re-pointing a Mac at a fresh server imports only unrecorded sessions — cost if wrong: after a server reinstall, old history must be restored from backup rather than re-uploaded from Macs (backups exist, plan 4)

### Deferred minors

- Task 1: minor (deferred): ApiClient returns undefined for a 2xx with empty/non-JSON body (throw bad_response) — matters for health() pin check
- Task 1: minor (deferred): `let json: any` in api.ts
- Task 1: minor (deferred): ingest/adopt/endSession/sessions/events, health 503 path and serverUrl slash strip untested
- Task 1: minor (deferred): api.test.ts:110 "unwritable home" case no longer exercises a failing path after the logs/ move
- Task 2: minor (deferred): git() inherits GIT_DIR/GIT_WORK_TREE from env — strip GIT_* when spawning (relevant if run inside git hooks)
- Task 2: minor (deferred): identity tests lack: cased-cwd case (title says so), no-remote subfolder → subpath "", git failure/timeout fallback
- Task 4: minor (deferred): retryBusy matches only SQLITE_BUSY/LOCKED exactly, not extended codes (BUSY_SNAPSHOT etc.)
- Task 4: minor (deferred): journal_mode=WAL result not checked
- Task 4: minor (deferred): tryLock reads clock before BEGIN IMMEDIATE wait
- Task 4: minor (deferred): no lock renew/holds check — a flush outliving its TTL can be joined by a second flusher (uploads are idempotent server-side, so duplicates only cost bandwidth) → Task 6 must pick a TTL above worst-case flush
- Task 4: minor (deferred): lock owner is pid only (two Store instances in one process share ownership)
- Task 4: minor (deferred): queue order relies on implicit rowid (VACUUM could renumber)
- Task 4: minor (deferred): no cross-process tryLock race test; no non-owner unlock test
- Task 4: minor (deferred): BlockedReason type exported but unused
- Task 3: minor (deferred): readCompleteLines reads unterminated huge lines to EOF each poll (quadratic copy) — cap at 64 MB and skip
- Task 3: minor (deferred): basic-fixture test builds a calls map but never asserts it; idempotency test passes vacuously against an empty stub
- Task 5: minor (deferred): upsertSession/enqueueEvents/setCursor not in one transaction (harmless: enqueue dedupes on (session,key))
- Task 5: minor (deferred): headless/startedAt decision keyed on firstTimestamp — a first chunk with entries but no timestamp could enqueue events without a session row (flush would quarantine them as unknown_session)
- Task 5: minor (deferred): sweep re-checks unbound/declined open cursors forever; no test that sweep reuses stored binding/cwd; no interactive-then-sdk test
- Task 8: minor (deferred): skipped (declined/unbound) files re-read every run; double parse when discover leaves cwd null (Task 9 adapters should fill cwd)
- Task 8: minor (deferred): sourceFor regex Claude-specific (Task 9 reworks the registry)
- Task 8: minor (deferred): no tests for declined binding, name-prefix sibling folder, or opts.sources injection
- Task 6: minor (deferred): unsentSessions(10_000) ceiling could let an event go without its session row during huge imports
- Task 6: minor (deferred): unknown_binding writes "known unbound" (no Store delete) instead of clearing the cache entry
- Task 6: minor (deferred): rows rejected for reasons other than unknown_binding still marked sent
- Task 6: minor (deferred): no tests for 5xx backoff, 401 unauthorized, 30-min cap
- Task 6: minor (deferred): shrunken batch limits reset only on quarantine, not on success (perf only)
- Task 6: minor (deferred): retiring a lone session row resets only maxSessions, not maxEvents/maxBytes (perf)
- Task 7: minor (deferred): declined folders run folderIdentity (git) on every Stop
- Task 10: minor (deferred): cerebro_bind creates client/project before a 409 rebind_required (orphans); cerebro_folder N+1 listProjects; no decline-409 test
- Task 7: minor (deferred): learnMachineName probes /health after every flush outcome incl. unreachable/backoff until the machine name is known
- Task 7: minor (deferred): any sdk-* entrypoint counts as headless even if a future SDK host is attended (CLAUDE_CODE_SESSION_ATTENDED could decide when present)
- Task 11: minor (deferred): skill test checks tool names but not argument names; hard-coded "default: 30" wording; COMMANDS formatting nit
- Task 9: minor (deferred): declined identity cached forever by sync; fallback identity drops subpath when using the agent's recorded remote; inbox cursor stuck if a file is replaced by a shorter one
- Task 12: minor (deferred): version regex admits invalid refs (1.2.3.lock) — fails at git tag after build, before push; tag not guarded with tag.gpgsign=false; https/ssh origin test does a real `git ls-remote` to GitHub (slow/flaky offline); ls-files without -z
- Task 9: minor (deferred): generic event key and codex toolName via storable only; docs/cerebro-jsonl.md uses bare `cerebro` command names
- Final: minor (deferred): log rotation not implemented; blocked not cleared on config change; generic-format ids can collide across Macs/agent names; MCP hostname fallback for machine name; drift `skipped` counts not surfaced in status; cursors for cleared/deleted transcripts stay open; sourceFor unused
- Final: minor (deferred): verification window is shared across processes via the Store (no current caller skips its own check); instance_unverified from a concurrent failed check makes one flush end "error" instead of backoff (treat as transient); long MCP tools checked once at start (cerebro_bind could create a client then be refused)

## summariser

### Rulings

- | T3→T5,T6,T7 | runClaude, ClaudeRun | Ruling: T3 Step 5 (real CLI call) is run by the controller after merge (implementer verifies with the fake only) — the real call spends the owner's subscription — cost: none |
- | T5→T6 | marks scopes dirty; T6 defines markScopesDirty/scopeKey → Ruling: T5 calls a `markScopesDirty` stub exported from state.ts created in T5 (no-op body), T6 fills it — cost: none |
- | T2↔T6 | both modify bindings.ts (T2 per plan text; T6 markScopesDirty on rebind/adopt/move) → Ruling: only T6 edits bindings.ts — T2 edits ingest.ts only |
- Task 5: review → Important ×3 (NUL in model output → never dead-letters, re-spends tokens; transcript delimiter injection + speaker spoofing; structured return needed for Task 7). Ruling: folded in MAX_EVENTS → due now, and binding-active check before paying — fix round 1 dispatched
- Task 5: Ruling: re-review's out-of-scope "last_error not storable" re-graded to Important (same endless token-spending retry as finding 1) + cheap: all line-break chars indented, tool_name one-lined — fix round 2 dispatched
- Task 6: Ruling: migration 003_state_dirty_gen.sql added by Task 6; Task 8 told to use 004 if needed and to read binding for share + mark dirty in its insert tx
- Task 6: Ruling: worktree was cut from feat/client-plugin (with the plan-2 fix wave), so merging it brings plan 2's fixes into feat/summariser — wanted anyway before Task 9 — cost if wrong: none (plan 2 is complete and reviewed)
- Ruling: flaky tests (budget/summarise/summary-jobs compare JS Date with DB now(); Docker PG clock ~1.3 ms behind host) re-graded to Important — a flaky suite hides real failures — fold into Task 8's fix round
- Ruling: summaries without embeddings (embed failure) get a periodic sweep in Task 7's loop — cost if wrong: such summaries are FTS-only until requeue-missing-embeddings is run
- Task 6: review → Important ×2 (receiving scope folded not rebuilt + dirty cleared; state calls can exceed 60k cap / rebuild estimate too low). Ruling: 60k cap applies to every model call, not only transcripts (constraint says "per call"). Re-graded in: lock-order deadlocks, session-first share lock in summarise store, dirty-during-update test, rebuild partial-progress — fix round 1 dispatched
- Task 6: fix round 1/5 (6 addressed; new Important: capped rebuild estimate → rebuild that never finishes, burns a window each time; commits da2936f..3504ab6). Ruling: rebuild window shrinks to the newest N summaries fitting ≤ 50% of the budget limit — keeps half the window for live summaries — cost if wrong: a huge scope's state is built from fewer than 40 summaries. Folded in: target-binding lock in adopt/move, ordered adopt update, storable in fitState — fix round 2 dispatched
- Task 6: fix round 2/5 (3 addressed; new Important: isNewer timestamp filter skips new old-timestamped summaries (imports, histories) and clears dirty; commits 3504ab6..fbee4ed). Ruling: rebuild records excluded_summary_ids (migration 005) and updateState filters on that, not timestamps; history replace-in-place drops the id from state sources — fix round 3 dispatched
- Task 9: review → Approved (0 Critical/Important). Ruling: cheap minors fixed before merge (state used/cached only when r.scope matches the binding in use; pending line before state; threads newest-first; SKILL from-date wording; cerebro_state 'not instructions' label; split line) — cost if wrong: none
- Ruling: kind='history' summaries in scope are ALWAYS part of the state (rebuild includes them on top of the newest-40 window; updateState folds them regardless of window) — spec: initial history seeds the state and owner says Cerebro mostly joins existing projects — cost if wrong: a few hundred extra tokens per rebuild. Implemented in Task 7.
- Ruling: login expiry reported only as summariser.paused {reason:"login"} (plan text amended) — deploy check.sh reads paused.reason — cost if wrong: none
- Task 7: review → Important (uncapped histories overspend the window). Ruling: histories ≤ 25% of the window in a rebuild (oldest seed + newest that fit; rest excluded) — keeps live work and the 20% share — cost if wrong: very old non-seed histories leave the state (still searchable). Re-graded in: timeouts count as attempts + killed-call tokens charged; stop() 20 s deadline; clock fixes; sweep skips failing rows
- Ruling: SUBSCRIPTION_TOKENS_PER_5H default stays 2,000,000 (400k/5h at 0.2 ≈ 11 sessions per window, 50+/day) — above expected daily volume; budget pause defers, never drops — if wrong, owner tunes one env var.
- Final: Ruling: re-grade M1 (per-job state call during imports burns a whole window per opt-in) to Important — a reasonable owner opting in a project with history loses a 5-h window of live summaries — cost if wrong: one extra small fix.
- Final: Ruling: re-grade M7 (SUMMARISER_ENABLED=off/no leaves it on, spending subscription) to Important — misread config silently spends the owner's plan — cost if wrong: trivial.
- Final: Ruling: M6 (README lacks summariser status/recovery docs) folded into I1's fix (it must document the new dead-summary requeue) — cost if wrong: none.
- Final: Ruling: M5 (shutdown deadline > docker stop 10 s) fixed at integration in deploy/compose.yml (stop_grace_period: 30s), since compose lives on feat/zima-deploy — cost if wrong: each deploy leaves an in-flight job waiting its 900 s lease.
- Final: Ruling: check.sh must treat paused.reason "unavailable" like "login" (alert) — done at integration with feat/zima-deploy — cost if wrong: outages show as healthy.
- Final: Ruling: migration 006 index built without CONCURRENTLY — first deploy has a small events table and migrations run before the server starts (no writers) — cost if wrong: a short lock during a later deploy.
- Final: Ruling: I5 residual + N2 (dirty/rebind rebuilds starve while imports hold spend in 75-100% of the share) carried into the integration fix pass as Important — a re-bound or freshly imported project shows no state for the whole import — cost if wrong: one small loop change.
- Final: Ruling: N1 (slow-API timeout+probe-timeout cycle is never charged, can overspend the 20% share) carried into the integration fix pass as Important — the share is the owner's hard promise about their subscription — cost if wrong: one small accounting change.

### Deferred minors

- Task 3: minor (deferred): timeout test doesn't assert the child is gone; SUMMARISER_CMD split on whitespace; no ISO resetAt test
- Task 3: minor (deferred): "limit reached" pattern broad (context-limit errors would wait for a reset); auth regex broad; no 403 test
- Task 4: minor (deferred): no tests for exactly-5h boundary, multi-entry resumesAt, used==limit; housekeeping cutoff uses caller's now; record() doesn't guard NaN/negative; check-then-spend not atomic → Task 7 loop must be single-flight
- Task 2: minor (deferred): completion overwrites an immediate due_at from a re-end with +2h when work remains
- Task 5: minor (deferred): unnamed tool result inherits latest call's name (rare cerebro-result leak to model as preview); timeouts retry forever with no cap; job lease 900 s vs long jobs (Task 7 loop must stay single-flight)
- Task 5: minor (deferred): store-path catch treats transient DB errors as non-retryable (5 in a row dead-letter a healthy job — requeue-dead recovers)
- Task 6: minor (deferred): source_summary_ids grows without bound (trim to rebuild window later)
- Task 8: minor (deferred): no relevance floor in 4-leg RRF (unrelated summary can top an FTS-less query); 64 KB body vs 20 000 UTF-16 limit on control-char text → 413; withScope c:any + duplicated notInverted refine
- Task 6: minor (deferred): escape-heavy state (≥21% quotes/backslashes) can drop oldest state items (pathological only); fitState trims on state size alone even when the call would fit
- Task 8: minor (deferred): unreachable .catch log after embedSummary (it swallows errors itself)
- Task 6: minor (deferred): rebuild can still overrun its estimate on escape-inflated state / large cache-creation usage (now unlikely: plan ≤ half window, gate on remaining)
- Task 6: minor (deferred): concurrent first POSTs of the same history period → replacement only marked dirty (use xmax<>0 in returning); every re-POST forces a rebuild (tokens) even if unchanged; pre-005 shrunk states start with empty excluded list
- Task 7: minor (deferred): phantom estimated charge for a login probe started after stop()'s kill (tick doesn't re-check stopped after the sweep); embedder calls not killed at the stop deadline; summarise.ts budget-defer fallback uses Date.now(); history posted after a rebuild is folded without the 25% cap until the next rebuild
- Final: minor (deferred): M2 thinking-only/isMeta tail sessions re-queued every 30 s (no tokens, churn only).
- Final: minor (deferred): M3 jobs for non-active bindings inflate backlog counts forever.
- Final: minor (deferred): M4 claude child inherits the full server env (no tools, so no exfil path today); allow-list later.
- Final: minor (deferred): N3 a persistent CLI error the probe also hits (e.g. retired model alias) shows as "unavailable", indistinguishable from an outage in /v1/status.
- Final: minor (deferred): I1 residuals — dead job revived only by CLI; state-path timeout charged without probe; a job's own 529 counts an attempt if the following probe succeeds.
- Final: minor (deferred): I2 --history redact variant not implemented.

## zima-deploy

### Rulings

- | T2→T3,T4,T6 | image cerebro-server:<sha7>, cli migrate / requeue-missing-embeddings | consistent; requeue also re-embeds summaries → depends on plan 3's summary_embeddings: Ruling: requeue handles summaries only if the table exists — cost: none |
- | T1→T3,T4 | OLLAMA_CPUS, search embed timeout, SUBSCRIPTION_TOKENS_PER_5H | Ruling: build T2–T4/T6 with defaults (cpus 4, 3 s timeout); T1 measurements adjust .env later — cost: a re-deploy |
- Task 3: implemented 41ef675. Ruling: cerebro-net is internal, so Ollama can't pull → Task 4's deploy.sh pulls bge-m3 into ${CEREBRO_DATA}/ollama with a one-off ollama container on the default network, then verifies BGE_M3_DIGEST — cost: none. Ruling: db password via ${CEREBRO_SECRETS}/db.env (implementer's addition) stands; Task 4 creates both db.env and server.env. Ruling: fixed container names (single stack per host) stand.
- Task 2: implemented 7eee72c. Ruling: summary embed text must be one shared helper — plan 3 Task 5 exports summaryEmbedText(row) (title + overview + facts) and requeue-missing-embeddings switches to it when the branches meet — cost: none
- Task 3: review → Important ×2 (socket pg_isready passes during first-boot init; restart test exercises compose up, not the restart policy). Ruling: re-graded Postgres worst-case memory > 2g and uncapped db CPU to must-fix (never starve AdGuard): work_mem 8MB, autovacuum_work_mem 64MB, 2 autovacuum workers, 1 parallel worker per gather, db cpus 2, memswap_limit=mem_limit, oom_score_adj 500 — fix round 1 dispatched
- Task 6: review → Important ×2 (free-space guard blind on first run/first Sunday; prod DATABASE_URL in host args). Ruling: re-graded to must-fix: prune exits 1 on empty dir after a good dump; exclusion script must syntax-check before overwriting the owner's real zima-backup.sh (+ backup copy, comment-aware idempotence); scratch≠prod assertion + leftover sweep; unconditional summary_embeddings exclude; stale tmp cleanup — fix round 1 dispatched
- Task 4: review → Important ×3 (failed compose up leaves stack down w/o rollback; no concurrent-deploy lock; no pre-migration recovery point). Ruling: rollback to :prev on a migrated schema stands (no auto-restore: would drop writes taken during the deploy) — pre-migration dump + explicit message instead — cost if wrong: a destructive migration needs a manual restore. Re-graded in: server-side check-token creation (keeps it out of transcripts), image pruning, 60 s deadline gate, migrate/build failure + multiplexing tests, README expand/contract rule — fix round 1 dispatched
- Task 4: Ruling: embedder check passes on an empty queue — lastSuccessAt is in-memory, the literal rule fails every idle server after restart; bge-m3 reachability check covers liveness — cost if wrong: a broken embedder with nothing queued goes unnoticed until work arrives
- Task 4: Ruling: docker builder prune --filter until=168h affects the whole host's build cache — only cache older than a week, removing it only slows a later rebuild of another app; no images or containers touched — cost if wrong: one slower rebuild
- Task 4: fix round 1/5 (7 addressed, 1 open: pre-migration dump overwritten/pruned on retry; commits ffd6580..3b7407f). Ruling: re-graded in :prev-from-last-gated-release, trap '' during rollback, ssh-ban vs held-lock distinction, owner-checked release, migrate-interrupt message — fix round 2 dispatched
- Final review (opus): Critical ×2 (exclusion points at cerebro/{db,ollama} not cerebro/data/ → zima-backup fills the shared USB drive; backup unit ExecStart path doesn't exist → backups silently never run), Important ×5 (no reserve on shared drive; postgres.conf change applies only at next restart; no rollback when db/ollama up fails; MemPerc counts page cache → false memory alarms; no restore runbook/README). Ruling: re-graded into the fix wave: restore-test maintenance mem, backup waits for pg_isready after boot, casaos install failure = warning, DISABLE_AUTOUPDATER, .env.example note, pending-marker for pre-migration dump (plan 3 brings 2 migrations), lock owner-tee check, SC2010 globs — ONE fix wave dispatched
- Final: Ruling: C1 replaces a previously applied wrong exclude pair (not just adds) — cost if wrong: none; I4 OOM kills in a still-running container warn, not fail — avoids a permanent failure after one recovered kill — cost: a repeated OOM is a warning until it stops the container
- Final: fix wave re-review (opus): 12/13 addressed + conf-copy additions verified (I2+I3 rollback mounts the previous conf copy; prune never removes a live conf). Residual I5: restore runbook's `< <dump>` redirect can't read root-only dumps. Ruling: controller fixed it directly (one-line doc change: `sudo cat <dump> | sudo docker exec -i cerebro-db pg_restore …`, commit 533c7a2) — no code behaviour, no second fix wave — cost if wrong: none

### Deferred minors

- Task 3: minor (deferred): x-casaos icon placeholder (replace at first deploy, Task 5)
- Task 3: minor (deferred): startup retry retries any migrate error (slow failure on bad password); postgres.conf "fits 2 GB" holds only without concurrent parallel queries (OOM kills only Cerebro by design)
- Task 6: minor (deferred): zima-backup.sh backup copy keeps original mode (chmod 600 it); restore sweep arithmetic on hostile names (08 → octal); empty psql db_size output would skip the guard; awk mirror on a single-line rsync would duplicate the command
- Final: minor (deferred): I3 recovery says "restarted them" without --wait; memory check on cgroup v1 says "not running" (Zima is v2); exclusion script active() grep|grep -q SIGPIPE on huge files

## integration

### Rulings

- Ruling: Claude CLI pinned to 2.1.311 (npm stable, 2026-10-26) instead of 2.1.325 (1 day old) — supply-chain age rule; flags verified present — cost if wrong: summaries bad_output on first deploy, visible in /v1/status lastError; bump pin.
- Ruling: imports capped at 75% of the share (last 25% reserved for live + dirty rebuilds) — fixes N2 — cost if wrong: large imports ~1/3 slower.
- Ruling: upgrade M1 (restore drops DB-level statement/idle timeouts) to Important — cheap idempotent re-apply; a post-restore runaway query could hang the server — cost if wrong: trivial.
- Ruling: upgrade M3, M5, M6, M7, M9 (first-deploy/recovery runbook gaps, never-logged-in shows running, no smoke call) to Important — the owner follows these runbooks at go-live, and a step that can't run as written stalls the deploy — cost if wrong: doc churn only.

### Deferred minors

- Final: minor (deferred): M2 check.sh fails on a 2-minute "unavailable" blip (manual check; message gives retry time).
- Final: minor (deferred): M4 summariser and embed worker stopped sequentially; untested order; worst case a few chunks wait a 10-min lease.
- Final: minor (deferred): M8 restore-test.sh doesn't count summary_jobs/project_states rows.
- Final: minor (deferred): New-1 verify() skips charging a probe that answers during shutdown.
- Final: minor (deferred): New-2 after a restore, migrate's pooled connection lacks the timeouts until restart.
- Final: minor (deferred): New-3 running the server locally makes one real Claude call per start (set SUMMARISER_ENABLED=false for dev).
- Final: minor (deferred): New-4 restore step 4 can write an empty/null instance id if the server isn't listening yet.

## embed-tuning (go-live, 2026-11-14)

### Rulings

- Ruling: keep bge-m3 (owner's choice after the Zima benchmark: 0.22 chunks/s, 0.45 s idle query; granite-embedding:278m 0.67–0.76 chunks/s; paraphrase-multilingual:278m rejected — it ignores everything past ~128 tokens) — best multilingual quality, no schema change — cost if wrong: re-embed with another model later.
- Ruling: one chunk per worker call and a 6 s query-embed budget — a query waits behind at most one in-flight chunk — cost if wrong: slightly lower bulk throughput on the Zima fallback.
- Ruling: per-machine embedding (owner's request): each Mac embeds its own sessions and its own searches on its own Ollama (`EMBED_MACHINE_URLS`, mac-mini=192.168.4.42, macbook-pro=192.168.4.45, eero DHCP reservations in place); never cross-Mac; the Zima's Ollama is the universal fallback — Macs are ~75× faster (15.8–17.3 chunks/s) — cost if wrong: a sleeping Mac's work waits or crawls on the Zima.
- Ruling: OLLAMA_CPUS=2 on the Zima (fallback only) — protects Jellyfin and the other apps — cost if wrong: fallback queries ~1 s instead of 0.45 s.
- Ruling: a Zima digest mismatch keeps the server up with Macs disabled rather than failing startup — a rollback can't fix server.env, so a fatal error would leave the server down — cost if wrong: degraded embedding until fixed (check.sh warns).

### Deferred minors

- minor (deferred): all lanes share one worker state, so the Zima lane's back-off never grows while a Mac works (M1).
- minor (deferred): a down Mac's chunks get only ~30 s of Zima time per 62–77 s (M3).
- minor (deferred): searches pause the Mac lanes when only the Zima lane needs pausing; a bad chunk is embedded twice before the health check (M5).
- minor (deferred): a slow request finishing after its Mac was marked down sets it back to up (lane flaps; no bad vector stored).
- minor (deferred): the Zima lane keeps storing while the Zima's digest mismatches the pin (only mixes if the Zima's model itself changed).
- minor (deferred): one hung Mac probe (up to 15 s) delays the Zima re-check and other Macs' recovery.

## Web dashboard and chat (2026-11-14, live as cerebro-web:7774999 at http://brain.home.lab)

Rulings:
- Owner chose TanStack Start + Better Auth (email/password, sign-up off) in its own container instead of a token-in-browser page; the web-ui token stays server-side and may call only /v1/dashboard/*.
- Chat runs `claude -p` (Sonnet by default, CHAT_MODEL) inside cerebro-server on the Max subscription. It fails closed unless the CLI's init lists only mcp__cerebro__* tools, with an env allowlist, `--setting-sources ""` and `--max-turns 12`. Verified live: a request to run Bash / read secrets was declined with no tool use.
- cerebro-web connects as role cerebro_web (auth schema only), never the superuser; its password is set by deploy/zima/web-db-role.sh straight into web.env.
- Published on 127.0.0.1:8792 (8791 belongs to another app); Caddy returns 403 for /mcp/* on cerebro.home.lab.
- The cerebro-web container is not part of deploy.sh's health gate: a failed web build warns and leaves the server release live; a server rollback stops cerebro-web.

Deferred minors (review of 94718a5..876aa4f):
- The SSE error handler forwards raw error messages to the browser.
- Memory headroom in cerebro-server's 1 GB limit with several chat CLIs plus the summariser.
- The dashboard's active-query list shows search text from every Mac without redaction.
- The Better Auth session-refresh cookie never reaches the browser, so the owner is signed out every 7 days.
- The overview poll (every 7 s per tab) re-runs the slow status query and exact count(*)s.
- /mcp/chat runs JSON-RPC batches in parallel without a cap (needs a live run secret).
- Cookies are not Secure (plain-http LAN); move to https before exposing beyond the LAN.
- The summariser's `claude -p` still inherits the server env minus the API-key variables; it could use the chat's allowlist.
- A dump restores cerebro_web's grants but not its password: re-run web-db-role.sh after a restore.
- Importer: an open transcript idle for more than 10 minutes is marked done, so sessions without hooks (started before the plugin was installed) are not caught up by later imports. They are caught up once restarted with --resume.
