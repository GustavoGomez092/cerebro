# Cerebro Zima Deployment Implementation Plan (plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **(controller/owner)** touch the live home server or the owner's accounts and are run by the controller with the owner's go-ahead, not by an implementer subagent.

**Goal:** Cerebro runs on the Zima home server at `http://cerebro.home.lab` — its own Postgres, a capped Ollama with bge-m3, and the server with the summariser logged in to the owner's Claude subscription — with backups, health checks, a ZimaOS dashboard tile, and the plugin installed on the owner's Macs.

**Architecture:** One compose project `cerebro` with three containers on a private network: `cerebro-db` (pgvector Postgres 17), `cerebro-ollama` (CPU-capped embedder), `cerebro-server` (Bun API + embed worker + summariser + Claude Code CLI). Only the server is published, on `127.0.0.1:8790`, reached through the existing Caddy as `cerebro.home.lab`. Deploy files live in this repo (`deploy/`) so other people can run their own install; `deploy/zima/` holds the owner-specific scripts following the HomeLab conventions (`deploy.sh`, `check.sh`, secrets under `/DATA/AppData/<app>/secrets`, root-only, never printed).

**Tech Stack:** Docker Compose 2.32 on ZimaOS 1.7.1, `casaos-cli` app registration, systemd timers, Caddy (`HomeLab/proxy`), AdGuard wildcard `*.home.lab`, pgvector `0.8.1-pg17`, Ollama, Bun 1.4, Claude Code CLI 2.1.x.

**Spec:** `docs/superpowers/specs/2026-11-13-cerebro-design.md` (Operations; Constraints). Server facts: the owner's `operating-zima-home-server` skill (topology, ssh ban behaviour, ZimaOS app quirks, backup drive, no `openssl` on the host, `jq` without regex). Plan-4 items from review: `docs/reviews/2026-11-13/pro-codebase-verdicts.md` (benchmark first, Ollama thread cap + keep_alive, memory limits, shm_size, Postgres tuning, backups with embeddings separate, image digest pin, healthcheck).

## Global Constraints

- Host: Ryzen 5 2400GE (8 threads), ~7 GB RAM available, `/DATA` 437 GB free (shared with media), backup USB 145 GB free. Cerebro's limits: db `mem_limit 2g`, ollama `mem_limit 3g` + `cpus 4`, server `mem_limit 1g` + `cpus 2`. Cerebro must never starve AdGuard (whole-house DNS) or the media stack.
- Only `127.0.0.1:8790` is published; Postgres and Ollama are reachable only on the `cerebro-net` network. No HTTPS site (LAN-only, plain HTTP like the other `*.home.lab` names).
- Secrets live in `/DATA/AppData/cerebro/secrets/` (root, 700/600), generated from `/dev/urandom` (the host has no `openssl`); scripts never echo them. The Claude login lives in a dedicated volume `/DATA/AppData/cerebro/claude` mounted as `CLAUDE_CONFIG_DIR`.
- Images are pinned by digest; the bge-m3 model is pinned by its Ollama digest and checked on deploy.
- One SSH connection at a time, multiplexed (`ControlMaster=auto`), no probing — failed/aborted connections get the client banned for ~60–90 s.
- Nothing restarts AdGuard, Caddy's other sites, or the shared `postgres` container. Reboots are never part of the plan.
- Every commit message ends with `Claude-Session: https://claude.ai/code/session_01LTKLaRsEuQTEb2o763vgdu`.

## Review Focus

1. **Zima reboots or loses power** (it has auto-restarted after freezes before) → all three containers come back, the server waits for the db, migrations are idempotent, the summariser resumes. Test in Task 3 and Task 5.
2. **Ollama is slow or saturated during a big import** → search stays usable (full-text immediately, vectors degrade gracefully), the box stays responsive. Measured in Task 1, enforced by the caps in Task 3.
3. **Disk fills** (raw text forever + embeddings + dumps) → status and `check.sh` warn before the 150 GB budget, backups never fill the USB drive. Test in Task 6.
4. **Restore after a lost database** → a nightly dump restores and the embeddings (excluded from nightlies) are rebuilt by re-queueing. Test in Task 6.
5. **The owner re-runs deploy** (upgrade) → zero data loss, previous image kept for rollback, health gate before switching. Test in Task 4.

---

## File Structure

```
server/Dockerfile                      production image (Claude Code CLI, non-root, healthcheck, digest pins)
server/src/cli.ts                      + `requeue-missing-embeddings`, `migrate`
deploy/compose.yml                     generic compose (env-driven): db, ollama, server, network
deploy/postgres.conf                   tuned for a small shared host
deploy/.env.example                    every variable with its meaning
deploy/zima/deploy.sh                  sync → build → secrets → up → health gate → register app → pull model
deploy/zima/check.sh                   end-to-end checks, exits non-zero with a reason
deploy/zima/backup.sh + systemd/       nightly/weekly dumps with retention; restore-test.sh
deploy/zima/README.md                  owner steps, rollback, troubleshooting
HomeLab/proxy (separate repo)          Caddy site `cerebro.home.lab` + directory label
~/.claude/skills/operating-zima-home-server/SKILL.md   new Cerebro row (owner's skill, kept current)
```

---

### Task 1 (controller/owner): Benchmark bge-m3 on the 2400GE

- [ ] **Step 1:** With the owner's go-ahead (CPU load for ~10 minutes), start a throwaway container on Zima: `ollama/ollama` (same tag as Task 3) with `cpus 4`, `OLLAMA_NUM_PARALLEL=1`, pull `bge-m3`, embed 100 real-shaped chunks (1600 chars) one at a time and in batches of 8; record chunks/s, p50/p95 single-query latency while a batch is running, peak RSS. Remove the container and its volume.
- [ ] **Step 2:** Decide and ledger: thread cap (`cpus`), the query timeout (`server/src/search.ts` embed timeout, default 3 s — raise to p95 + 1 s if needed), and whether bge-m3 stays (rule: keep it if ≥ 0.25 chunks/s; otherwise flag to the owner with the measured import time for their history and a smaller multilingual alternative).
- [ ] **Step 3: Commit** `docs(deploy): bge-m3 benchmark on the Zima host` (numbers into `deploy/zima/README.md`).

---

### Task 2: Production image and maintenance commands

**Files:** Modify `server/Dockerfile`, `server/src/cli.ts`, `.dockerignore`; test `server/test/cli-maintenance.test.ts`, `deploy/test/image.test.ts` (skipped when Docker is unavailable).

**Interfaces — Produces:**
- Image `cerebro-server:<git sha7>`: `FROM oven/bun:1.4.4-slim@sha256:<digest>`; installs Claude Code CLI pinned (`npm i -g @anthropic-ai/claude-code@<exact version installed on the owner's Mac>` or the official installer at that version — record which); user `cerebro` uid 10010; `ENV CLAUDE_CONFIG_DIR=/data/claude SUMMARISER_CMD=claude`; `HEALTHCHECK CMD bun -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1))"` every 30 s; `CMD ["bun","--no-install","server/src/main.ts"]`.
- `bun server/src/cli.ts migrate` — runs migrations and exits (deploy runs it before starting the new server).
- `bun server/src/cli.ts requeue-missing-embeddings` — inserts `embed_queue` rows (priority 1) for chunks without `chunk_embeddings` and re-embeds summaries without `summary_embeddings`; prints counts. Used after restoring a dump that excludes embeddings.

- [ ] **Step 1: Failing tests**: `requeue-missing-embeddings queues exactly the chunks without vectors`; image test: `docker build` succeeds, `docker run … claude --version` prints the pinned version, the container runs as uid 10010, healthcheck passes against a compose db.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5: Commit** `build(server): production image with Claude Code CLI; migrate and requeue commands`.

---

### Task 3: Compose and Postgres tuning

**Files:** Create `deploy/compose.yml`, `deploy/postgres.conf`, `deploy/.env.example`, `deploy/test/compose.test.ts`.

**Interfaces — Produces (compose project `cerebro`):**
- `cerebro-db`: `pgvector/pgvector:0.8.1-pg17@sha256:<digest>`, `shm_size: 1g`, `mem_limit: 2g`, `command: postgres -c config_file=/etc/postgresql/postgres.conf`, volume `${CEREBRO_DATA}/db:/var/lib/postgresql/data`, `healthcheck: pg_isready`, `restart: unless-stopped`, network `cerebro-net` only.
- `postgres.conf`: `shared_buffers=512MB`, `effective_cache_size=1536MB`, `work_mem=16MB`, `maintenance_work_mem=256MB`, `max_parallel_maintenance_workers=2`, `max_connections=40`, `default_toast_compression=lz4`, `wal_compression=lz4`, `checkpoint_timeout=15min`, `listen_addresses='*'`.
- `cerebro-ollama`: `ollama/ollama:<tag>@sha256:<digest>`, `cpus: ${OLLAMA_CPUS:-4}`, `mem_limit: 3g`, env `OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_KEEP_ALIVE=-1`, volume `${CEREBRO_DATA}/ollama:/root/.ollama`, `restart: unless-stopped`, `cerebro-net` only.
- `cerebro-server`: `image: cerebro-server:${CEREBRO_TAG}`, `depends_on: { db: service_healthy, ollama: service_started }`, `env_file: ${CEREBRO_SECRETS}/server.env`, env `EMBED_URL=http://cerebro-ollama:11434`, `ports: ["127.0.0.1:8790:8790"]`, `cpus: 2`, `mem_limit: 1g`, volume `${CEREBRO_DATA}/claude:/data/claude`, `restart: unless-stopped`; ZimaOS metadata (`x-casaos`: title "Cerebro", icon, `port_map: "80"`, `hostname: cerebro.home.lab`, `index: /health`).
- Network `cerebro-net` (internal bridge; the server also joins the default network only to publish its port).

- [ ] **Step 1: Failing test** `compose config is valid and only the server publishes a port, on 127.0.0.1` (parse `docker compose -f deploy/compose.yml --env-file deploy/.env.example config --format json`; assert services, limits, no published ports on db/ollama).
- [ ] **Step 2: Failing test (Docker)** `the stack comes back after its containers are killed` — `docker compose up -d` locally with temp data dirs, `docker kill` all three, `docker compose up -d` (simulating a reboot's restart policy), server healthy and data intact.
- [ ] **Step 3–4:** implement → GREEN. **Step 5: Commit** `feat(deploy): compose stack with resource caps and tuned Postgres`.

---

### Task 4: Zima deploy and check scripts

**Files:** Create `deploy/zima/deploy.sh`, `deploy/zima/check.sh`, `deploy/zima/lib.sh`, `deploy/zima/test/deploy.test.ts` (runs the scripts against a fake `ssh` that executes locally in a temp root).

**Interfaces — Produces:**
- `lib.sh`: `zssh` (multiplexed `ssh zima`, one ControlPath, `BatchMode=yes`), `die`, secret helpers that read/write files without echoing.
- `deploy.sh [--first-run]`: refuses a dirty tree or failing `bun test`; rsyncs the repo to `/DATA/AppData/cerebro/src`; first run creates `secrets/` (db password, `server.env` with `DATABASE_URL`, `SUMMARY_SHARE=0.2`, `SUBSCRIPTION_TOKENS_PER_5H` from Task 1/plan 3), data dirs with owners (db 999, server 10010); builds `cerebro-server:<sha7>` on the server, tags the running one `:prev`; brings up db + ollama; ensures `bge-m3` is pulled and its digest matches `deploy/.env` `BGE_M3_DIGEST`; runs `cli.ts migrate` in a one-off container; starts the new server; health gate (`/health` ok + `db` true within 60 s) else rolls back to `:prev` and exits 1; first run registers the ZimaOS app with `casaos-cli app-management install -f <compose>`, later runs copy the compose over `/var/lib/casaos/apps/cerebro/docker-compose.yml` and restart `zimaos-app-management` only if the metadata changed (the skill's documented workaround for uncontrolled apps).
- `check.sh`: `/health` via `http://cerebro.home.lab` and `127.0.0.1:8790`; `instanceId` stable since last deploy; token-authenticated `/v1/status` (using a `check` machine token in secrets): queue sizes, embedder last success < 1 h, summariser not paused for `login`, `dbBytes` < 150 GB (warn at 120); `bge-m3` present; backup timer active and last backup < 26 h; container memory under limits. Prints `ALL OK` or the failing checks and exits 1.

- [ ] **Step 1: Failing tests** (fake ssh/docker shims): `deploy refuses a dirty tree`; `first run creates secrets with 600 perms and never prints them`; `a failing health gate rolls back to :prev`; `check reports each failing condition by name`.
- [ ] **Step 2–4:** RED → implement → GREEN (shellcheck clean if installed). **Step 5: Commit** `feat(deploy): Zima deploy with health-gated rollback and end-to-end check`.

---

### Task 5 (controller/owner): First deployment, names and login

- [ ] **Step 1:** `deploy/zima/deploy.sh --first-run` (owner go-ahead; one SSH connection). Verify containers, limits (`docker stats`), and that AdGuard/media are unaffected (`dig @192.168.4.61 github.com`, Jellyfin health).
- [ ] **Step 2:** In `HomeLab/proxy`: add the `cerebro.home.lab` site (`reverse_proxy 127.0.0.1:8790`) and its directory label in `tools/directory.py`; run that repo's `./deploy.sh` and `./check.sh` (ALL OK). Commit there.
- [ ] **Step 3 (owner):** log the summariser in: `ssh -t zima sudo docker exec -it -u cerebro cerebro-server claude auth login` (subscription account); then `check.sh` shows the summariser not paused for login.
- [ ] **Step 4:** Create machine tokens — owner runs, outside any recorded Claude session: `ssh -t zima sudo docker exec -it cerebro-server bun server/src/cli.ts token create <mac-name>` once per Mac (and one named `check` stored in secrets for `check.sh`).
- [ ] **Step 5:** Simulated power loss: `sudo docker restart cerebro-db cerebro-ollama cerebro-server` → `check.sh` ALL OK within 2 minutes, no data loss (row counts before/after).
- [ ] **Step 6:** Record everything in `deploy/zima/README.md` and the owner's `operating-zima-home-server` skill (new "Cerebro" row: containers, repo, paths, secrets, limits, login/token runbooks, check/deploy commands). Commit.

---

### Task 6: Backups and restore test

**Files:** Create `deploy/zima/backup.sh`, `deploy/zima/restore-test.sh`, `deploy/zima/systemd/cerebro-backup.{service,timer}`, `deploy/zima/test/backup.test.ts`.

**Interfaces — Produces:**
- `backup.sh`: umask 077; target `/DATA/Backup/cerebro/{nightly,weekly}/<date>.dump` (skips with a logged reason if the backup drive isn't mounted); nightly = `pg_dump -Fc --exclude-table-data=chunk_embeddings --exclude-table-data=summary_embeddings --exclude-table-data=embed_queue` (embeddings are rebuildable); Sundays also a full `pg_dump -Fc`; retention 14 nightly, 4 weekly; refuses to start a dump if the drive has < 2× the last dump size free (logs and exits 1 so `check.sh` flags it); `secrets/` is covered by the existing nightly `zima-backup` snapshot of `/DATA/AppData` (root-only, like the other HomeLab secrets); the Claude login dir is not backed up (re-login is the recovery).
- `zima-backup` exclusion: add `/DATA/AppData/cerebro/db` and `/DATA/AppData/cerebro/ollama` to the excludes of `/DATA/AppData/backup/zima-backup.sh` (live Postgres files and re-downloadable models must not be rsynced nightly — the dumps cover the database), mirroring how the shared `postgres` data dir is excluded; record it in the owner's skill.
- `cerebro-backup.timer`: daily 03:20 (after `postgres-backup` 03:10, before `zima-backup` 03:30).
- `restore-test.sh`: restores the latest nightly into a scratch database inside `cerebro-db`, compares row counts of clients/projects/bindings/sessions/events/chunks/summaries with production (± rows written since), runs `requeue-missing-embeddings` against the scratch DB to prove embeddings can be rebuilt, drops the scratch DB.

- [ ] **Step 1: Failing tests** (local compose stack): `nightly dump excludes embedding data and restores to equal row counts`; `retention keeps 14 nightly and 4 weekly`; `backup refuses when the target lacks space`; `restore-test rebuilds embeddings via requeue`.
- [ ] **Step 2–4:** RED → implement → GREEN. **Step 5 (controller):** install the timer on Zima, run `backup.sh` and `restore-test.sh` once, record sizes and timings in the README. **Step 6: Commit** `feat(deploy): Cerebro backups with retention and a restore test`.

---

### Task 7 (controller/owner): Plugin rollout to the Macs

- [ ] **Step 1:** Publish the first plugin release from the private GitHub repo: `scripts/release-plugin.sh 0.1.0` (after `bun test` green; the script refuses any other origin).
- [ ] **Step 2 (owner, each Mac):** `gh auth login && gh auth setup-git`; `claude plugin marketplace add GustavoGomez092/cerebro`; `claude plugin install cerebro@cerebro` (server URL `http://cerebro.home.lab`, the Mac's token); start Claude Code in any project; `~/.cerebro/bin/cerebro retention`; optionally `~/.cerebro/bin/cerebro schedule`.
- [ ] **Step 3:** On this Mac, verify with the owner: opt-in prompt in a scratch repo → bind → a short conversation → `~/.cerebro/bin/cerebro status` shows uploads → a new session shows the brief → `cerebro_search` recalls it → after the session ends, a summary and project state appear (`/v1/state`).
- [ ] **Step 4:** Opt the Cerebro repo itself in; confirm its history (Claude Code + Codex if any) imports and the initial project history is saved. Record results in `deploy/zima/README.md`. Commit.
