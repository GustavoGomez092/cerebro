# Cerebro on the Zima server

Owner runbook for the ZimaOS box (`ssh zima`). Everything runs from a clean checkout on a Mac; the scripts
use one multiplexed SSH connection (sshd bans a client for ~90 s after a failed or aborted connection, so
never retry quickly and never open parallel connections).

| What | Where |
|---|---|
| Containers | `cerebro-db` (pgvector, 2 GB, 2 CPUs), `cerebro-ollama` (bge-m3, 3 GB, `OLLAMA_CPUS`), `cerebro-server` (1 GB, 2 CPUs), network `cerebro-net` (internal) |
| URL | `http://cerebro.home.lab` (Caddy) → `127.0.0.1:8790` (the only published port) |
| App dir | `/DATA/AppData/cerebro`: `src/` (synced repo), `data/{db,ollama,claude}`, `secrets/` (root 700/600), `state/` (deploy records, pre-deploy dumps, lock), `zima/` (root-owned backup scripts + units, installed by every deploy), `docker-compose.yml` (rendered, last good release) |
| Backups | `/DATA/Backup/cerebro/{nightly,weekly}` (USB drive shared with `zima-backup` and `postgres-backup`) |

## First deploy

1. **`deploy/.env`**: `cp deploy/.env.example deploy/.env`, then set `BGE_M3_DIGEST` (bge-m3's Ollama digest,
   from the benchmark) and `OLLAMA_CPUS`. `CEREBRO_DATA`/`CEREBRO_SECRETS` there are ignored by the deploy (fixed
   in `deploy/zima/lib.sh`).
2. **Deploy**: `deploy/zima/deploy.sh --first-run`. It generates the secrets on the server (never printed),
   creates the data dirs, builds the image, pulls bge-m3, migrates, gates on `/health`, creates the `check`
   machine token, registers the ZimaOS app, and installs the backup scripts and units into
   `/DATA/AppData/cerebro/zima/`. If the ZimaOS registration fails (a warning; the server is live), register it
   with `ssh zima sudo casaos-cli app-management install -f /DATA/AppData/cerebro/docker-compose.yml`.
3. **Caddy route** (repo `HomeLab/proxy`, see its README "Add a service"): add
   ```
   http://cerebro.home.lab {
   	reverse_proxy 127.0.0.1:8790
   }
   ```
   plus `cerebro` in `EXPECTED` (`tests/test_sites.py`) and a label in `LABELS` (`tools/directory.py`), then
   `./deploy.sh` and `./check.sh` there. Caddy runs on the host network, so `127.0.0.1:8790` reaches the server.
4. **Claude login** (the summariser runs `claude -p` inside the container, as user `cerebro`, with its config
   in `/data/claude` = `/DATA/AppData/cerebro/data/claude`). From a terminal on the Mac:
   ```sh
   ssh -t zima sudo docker exec -it -u cerebro -e CLAUDE_CONFIG_DIR=/data/claude cerebro-server claude auth login
   ssh -t zima sudo docker exec -it -u cerebro -e CLAUDE_CONFIG_DIR=/data/claude cerebro-server claude auth status
   ```
   `check.sh` fails `summariser` with "Claude login expired" when it has to be repeated.
5. **A token per Mac**, created on the server in a plain terminal (never inside a recorded Claude Code session:
   the token is printed once):
   ```sh
   ssh -t zima sudo docker exec -it cerebro-server bun --no-install server/src/cli.ts token create <mac-name>
   ```
   Then on that Mac: `claude plugin install cerebro@cerebro` (URL `http://cerebro.home.lab`, that token).
6. **Backup timer** (the deploy refreshes the scripts and the unit files in `zima/`, not the installed units;
   repeat this when `systemd/` changes):
   ```sh
   ssh zima 'sudo cp /DATA/AppData/cerebro/zima/systemd/cerebro-backup.service /DATA/AppData/cerebro/zima/systemd/cerebro-backup.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now cerebro-backup.timer'
   ssh zima 'sudo systemctl start cerebro-backup.service && sudo journalctl -u cerebro-backup.service -n 20 --no-pager'
   ```
7. **Keep the data dir out of the `zima-backup` snapshots** (Postgres files change every night and are covered
   by the dumps; the models are re-downloadable; the Claude login is redone by logging in):
   ```sh
   ssh zima sudo bash /DATA/AppData/cerebro/zima/exclude-from-zima-backup.sh
   ```
   It adds `--exclude '/DATA/AppData/cerebro/data/' \` right after the script's `postgres/data` exclude (a copy of
   that line), is idempotent, syntax-checks the result before replacing `/DATA/AppData/backup/zima-backup.sh`,
   and keeps the original as `zima-backup.sh.bak-cerebro-<timestamp>` (root 600). Verify with a dry run of the
   script's own rsync command (its options, sources and excludes, plus `-n --itemize-changes`, into a scratch
   destination such as `/tmp/rsync-probe/`) that nothing under `AppData/cerebro/data/` is listed while
   `AppData/cerebro/secrets/` still is, the same way the `postgres/data` exclude was checked:
   ```sh
   ssh zima "sudo rsync <the script's options> -n --itemize-changes <its excludes> <its sources> /tmp/rsync-probe/ | grep -c 'AppData/cerebro/data/'"   # 0
   ```
   Then record it in the `operating-zima-home-server` skill (Backups row).
8. **Check**: `deploy/zima/check.sh` prints `ALL OK` (warnings don't fail it) or `FAILED: <names>`.

## Upgrades and rollback

`deploy/zima/deploy.sh` (clean tree, `bun test` passes). One deploy at a time (`state/deploy.lock` names its
owner; remove it only when that deploy is certainly dead). The deploy:

- refuses a dirty tree, a failed `bun test`, a failed build or a bge-m3 digest mismatch without changing anything;
- brings db and ollama up from the new definitions (`--wait`, 300 s). A changed `deploy/postgres.conf` changes
  the db's `cerebro.postgres-conf-sha256` label, so the db is recreated with it (a short db restart). If they
  don't come up healthy, it restarts them from the last good `docker-compose.yml` and stops before migrating;
- takes a pre-deploy dump when the schema is behind the release's migrations (see "Migrations");
- starts the new server and switches only after `/health` reports `ok` and `db` within 60 s. A failed start, a
  failed gate or Ctrl-C rolls back to `cerebro-server:prev` (the last release that passed the gate) and exits 1.

**Manual rollback**: redeploy an older commit. `git switch --detach <good-sha>` in a clean checkout, then
`deploy/zima/deploy.sh`, then `git switch -` back. The image is rebuilt from that commit (or reused), the gate
runs as usual, and that release becomes the new `:prev` candidate. Nothing undoes a migration: the older code
runs on the newer schema, which is why migrations are expand/contract. A rollback started by the deploy uses the
new release's compose with the `:prev` image; a compose change the old image can't run with needs this manual
route.

## Migrations: expand/contract

Migrations run before the new server starts, and both an automatic rollback and a manual one run older code on
the migrated schema. So every migration must be backward-compatible with the release before it:

1. **Expand**: add tables, nullable columns or columns with defaults, new indexes. The old code ignores them.
2. Deploy the code that writes and reads the new shape (and backfills, if needed).
3. **Contract** in a later release, once no deployed code (including `:prev`) reads the old shape: drop or rename.

Never rename or drop in the same release that stops using a column.

When the schema is behind the release (compared with `state/schema-migrations`, written after every successful
migrate), the deploy saves `pg_dump -Fc` (embeddings excluded) to
`/DATA/AppData/cerebro/state/pre-deploy/<UTC ts>-<sha>.dump` (root 600) and names it in `pre-deploy/pending`
before migrating. While `pending` is set (a migrate failed or was interrupted part-way), later deploys take no
new dump (it would capture a half-migrated schema) and keep naming that one; a successful migrate records it in
`pre-deploy/applied` and clears `pending`. The newest 3 dumps are kept, plus the `applied` one. Rollback and
failure messages name the dump; it is never restored automatically (it would drop writes taken since): restore
it with the runbook below if a migration destroyed data.

## Backups

- `zima/backup.sh` (root, from `cerebro-backup.timer` daily 03:20, between `postgres-backup` 03:10 and
  `zima-backup` 03:30; `Persistent=true`, so a run missed while the box was off happens at boot):
  `/DATA/Backup/cerebro/nightly/<date>.dump` without embedding data (`chunk_embeddings`, `embed_queue`,
  `summary_embeddings`: rebuilt by re-queueing) and, on Sundays, a full `weekly/<date>.dump` with the vectors.
  Keeps 14 nightly and 4 weekly, root-only files.
  - Skips (exit 0, logged) when `/DATA/Backup` is not mounted.
  - Waits up to 2 min for the database to accept connections (after a power loss Docker may still be starting it).
  - The drive is shared: a run refuses (exit 1) when its dumps, each estimated from the newest dump of the same
    kind (the database size when there is none), would leave less than 20 GB free
    (`CEREBRO_BACKUP_RESERVE_GB`). `check.sh` warns when the drive is over 80 % full and fails when no dump is
    under 26 h old.
- `zima/restore-test.sh` (root, on demand, e.g. monthly): restores the newest nightly into a scratch database
  inside `cerebro-db` (with a 64 MB, serial maintenance budget, since it shares the 2 GB container with
  production), compares row counts, re-queues embeddings there, drops it.
  `ssh zima sudo /DATA/AppData/cerebro/zima/restore-test.sh`
- `secrets/`, `state/` and `src/` are in the nightly `zima-backup` snapshot of `/DATA/AppData`; `data/` is not
  (see step 7).

## Restore runbook (lost or damaged database)

**Which dump**: the newest nightly, normally: it has the most recent data, full-text search works as soon as it
is restored, and the vectors are rebuilt in the background by re-queueing. Prefer the newest weekly when the
nightlies are damaged (a failed `restore-test.sh`), or when having vector search back at once matters more than
the up to 6 days of history the weekly lacks (re-embedding everything takes hours on this CPU).

From a terminal on the Mac (`<dump>` = e.g. `/DATA/Backup/cerebro/nightly/2026-11-14.dump`):

1. Stop the server (a manual stop sticks: the restart policy is `unless-stopped`):
   `ssh zima sudo docker stop cerebro-server`
2. Replace the database inside `cerebro-db` (the db container keeps running):
   ```sh
   ssh zima sudo docker exec cerebro-db dropdb -U cerebro --force cerebro
   ssh zima sudo docker exec cerebro-db createdb -U cerebro cerebro
   ssh zima "sudo docker exec -i cerebro-db pg_restore -U cerebro -d cerebro --exit-on-error < <dump>"
   ```
   If `pg_restore` stops with an error, fix the cause and repeat step 2 from `dropdb` (never start the server on
   a partial restore).
3. Start the server (it applies any newer migrations at start-up): `ssh zima sudo docker start cerebro-server`
4. Nightly dump only: queue the chunks and summaries that have no vector:
   `ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts requeue-missing-embeddings`
5. `deploy/zima/check.sh`. `instance-id` stays ok (the id lives in the database and comes back with it); the
   queue shows the re-embedding backlog draining.

If the whole data dir is gone, run `deploy/zima/deploy.sh --first-run` first (it keeps existing secrets and pulls
the model again), then restore as above.

## Troubleshooting

- `check.sh` `memory`: anon+shmem of each container's limit (page cache doesn't count). A warning about OOM kills
  means a process inside hit the limit and was killed while the container kept running.
- `deploy.sh` says another deploy holds the lock: wait for it, or remove `/DATA/AppData/cerebro/state/deploy.lock`
  only when that deploy is certainly dead.
- "cannot reach zima": an ssh ban; wait ~90 s before one more try.
