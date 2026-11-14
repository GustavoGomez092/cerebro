# Cerebro backups (Zima)

- `backup.sh` (root, from `cerebro-backup.timer` daily 03:20, between `postgres-backup` 03:10 and `zima-backup` 03:30):
  `/DATA/Backup/cerebro/nightly/<date>.dump` (no embedding data: `chunk_embeddings`, `embed_queue`, and
  `summary_embeddings` when that table exists) and, on Sundays, a full `weekly/<date>.dump`. Keeps 14 nightly and
  4 weekly. Files are root-only (umask 077). Skips with a logged reason when `/DATA/Backup` is not mounted (exit 0);
  refuses with exit 1 when its dumps (estimated from the newest dump of the same kind) would leave less than
  20 GB free on the shared drive (`CEREBRO_BACKUP_RESERVE_GB`). Waits up to 2 min for the database after a boot.
- `restore-test.sh` (root, on demand): restores the latest nightly into a scratch database in `cerebro-db`, compares
  row counts with production, runs `requeue-missing-embeddings` against the scratch database, drops it.
- Restoring for real: `pg_restore` the nightly into a fresh database, then run
  `docker exec cerebro-server bun --no-install server/src/cli.ts requeue-missing-embeddings` and let the embed
  worker catch up (weekly dumps already contain the vectors).
- `secrets/` is covered by the nightly `zima-backup` snapshot of `/DATA/AppData`. The Claude login dir is not backed
  up: re-login is the recovery.
- `exclude-from-zima-backup.sh` (owner, once, root): adds `/DATA/AppData/cerebro/data/` (Postgres files, Ollama
  models, Claude login) to the excludes of `/DATA/AppData/backup/zima-backup.sh`, mirroring its `postgres/data`
  exclude (an earlier `cerebro/db` + `cerebro/ollama` pair is replaced). Idempotent, keeps
  `zima-backup.sh.bak-cerebro-<timestamp>`. Afterwards record it in the `operating-zima-home-server` skill (Backups row).
- Install the timer: copy `systemd/cerebro-backup.{service,timer}` to `/etc/systemd/system/`, `systemctl daemon-reload`,
  `systemctl enable --now cerebro-backup.timer`.
