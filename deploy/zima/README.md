# Cerebro on the Zima server

Owner runbook for the ZimaOS box (`ssh zima`). Everything runs from a clean checkout on a Mac; the scripts
use one multiplexed SSH connection (sshd bans a client for ~90 s after a failed or aborted connection, so
never retry quickly and never open parallel connections).

| What | Where |
|---|---|
| Containers | `cerebro-db` (pgvector, 2 GB, 2 CPUs), `cerebro-ollama` (bge-m3, 3 GB, `OLLAMA_CPUS`), `cerebro-server` (1 GB, 2 CPUs), `cerebro-web` (dashboard, 512 MB, 1 CPU, `web` profile; see "Web dashboard"), network `cerebro-net` (internal) |
| URL | `http://cerebro.home.lab` (Caddy) → `127.0.0.1:8790` (the API); `http://brain.home.lab` → `127.0.0.1:8792` (the web dashboard, once deployed). No other port is published |
| App dir | `/DATA/AppData/cerebro`: `src/` (synced repo), `data/{db,ollama,claude}`, `secrets/` (root 700/600), `state/` (deploy records, pre-deploy dumps, lock), `zima/` (root-owned backup scripts + units, installed by every deploy), `conf/postgres-<sha256>.conf` (the conf each compose mounts), `docker-compose.yml` (rendered, last good release) |
| Backups | `/DATA/Backup/cerebro/{nightly,weekly}` (USB drive shared with `zima-backup` and `postgres-backup`) |

## First deploy

1. **`deploy/.env`**: `cp deploy/.env.example deploy/.env`, then set `BGE_M3_DIGEST` (bge-m3's Ollama digest,
   from the benchmark) and `OLLAMA_CPUS`. `CEREBRO_DATA`/`CEREBRO_SECRETS` there are ignored by the deploy (fixed
   in `deploy/zima/lib.sh`).
2. **Deploy**: `deploy/zima/deploy.sh --first-run`. It generates the secrets on the server (never printed),
   creates the data dirs, builds the image, pulls bge-m3, migrates, gates on `/health`, creates the `check`
   machine token, registers the ZimaOS app, and installs the backup scripts and units into
   `/DATA/AppData/cerebro/zima/`. The ZimaOS registration warns "ports in use" on a first run (the stack is
   already up) and the app is still listed as `cerebro` (running). **Never** run `casaos-cli app-management install`
   for it by hand after stopping the stack: ZimaOS tries to pull the local-only `cerebro-server` image from public
   mirrors, fails ("repository does not exist") and leaves Cerebro down. If that happened, bring it back with
   `ssh zima 'cd /DATA/AppData/cerebro && sudo docker compose -p cerebro -f docker-compose.yml up -d --pull never --wait'`.
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
   `check.sh` fails `summariser` with "Claude login expired" when it has to be repeated, and with "Claude CLI
   unavailable / outage" while the CLI is missing or the API is unreachable (the summariser probes and resumes by
   itself; a budget or usage-limit pause is normal deferral and only reported). The server probes the CLI when it
   starts, so until this login is made `/v1/status` shows `paused.reason: "login"` and `check.sh` fails.

   **Smoke call** (right after the login, before anything else): one tiny real summary call through the server's
   own `runClaude`, summary prompt and schema check, as user `cerebro`. It prints `ok: …` (model, tokens, login
   expiry) or `FAIL <class>: …` with what to do, and exits 1 on a failure; it never prints the prompt, the
   answer or any credential (the tokens are charged to the summariser's budget):
   ```sh
   ssh zima sudo docker exec -u cerebro cerebro-server bun --no-install server/src/cli.ts claude-smoke
   ```
   - `FAIL auth`: the login didn't take; repeat the login above.
   - `FAIL bad_output` or `FAIL failed`: the pinned CLI (`CLAUDE_CODE_VERSION` in `server/Dockerfile`) answers in a
     shape the server doesn't read. Stop here: every summary would fail the same way. Bump the pin (to a release
     at least two weeks old), redeploy, log in if asked, and run the smoke call again.
   - `FAIL unavailable` / `FAIL timeout`: CLI missing or network/API down; `docker logs cerebro-server`, retry.

   On `ok`, restart the server so its start-up probe sees the new login at once (otherwise the login pause lifts
   by itself within 15 minutes): `ssh zima sudo docker restart cerebro-server`.
5. **The Macs.** The client is a Claude Code plugin served from the private GitHub repo
   `GustavoGomez092/cerebro`: the marketplace (`.claude-plugin/marketplace.json`, read from the repo's default
   branch, `main`) points at the `plugin-dist` branch, which `scripts/release-plugin.sh` publishes.
   1. **Publish the repo (once, before the first release).** This repo has no remote until the owner creates the
      private GitHub repo; doing so is what creates the `origin` remote that `scripts/release-plugin.sh` pushes to
      (it refuses any `origin` other than `GustavoGomez092/cerebro`). From the main checkout, with the release
      merged into `main`:
      ```sh
      gh repo create GustavoGomez092/cerebro --private --source . --remote origin
      git push -u origin main
      ```
   2. **Release the plugin** (after step 1; again for every client change, with a new version). From a clean
      checkout of `main`, with the dev Postgres up (the script runs `bun test` first and refuses on a failure, a
      dirty tree, an existing `plugin-v<version>` tag, or an `origin` that isn't the repo above):
      ```sh
      docker compose -f docker-compose.dev.yml up -d --wait db
      scripts/release-plugin.sh 0.1.0 --dry-run   # preview: prints every step, changes nothing
      scripts/release-plugin.sh 0.1.0
      ```
      It compiles the arm64 and x64 binaries, writes the version into `plugin.json`, and force-pushes `plugin/`
      as a single commit on `plugin-dist` with the tag `plugin-v0.1.0` (atomically). Check it landed:
      `git ls-remote origin plugin-dist refs/tags/plugin-v0.1.0` lists both.
   3. **A token per Mac**, created on the server in a plain terminal (never inside a recorded Claude Code session:
      the token is printed once):
      ```sh
      ssh -t zima sudo docker exec -it cerebro-server bun --no-install server/src/cli.ts token create <mac-name>
      ```
   4. **On each Mac** (the repo is private, so git needs your GitHub login first):
      ```sh
      gh auth login && gh auth setup-git
      claude plugin marketplace add GustavoGomez092/cerebro
      claude plugin install cerebro@cerebro       # asks for the server URL (http://cerebro.home.lab) and that token
      ```
      Then start a Claude Code session in any folder (the session start creates `~/.cerebro/bin/cerebro`) and run
      `~/.cerebro/bin/cerebro status`: it shows the server and no block. `~/.cerebro/bin/cerebro retention` keeps
      transcripts until they are imported (see the top-level README, "Install on a Mac").
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
8. **Check**: `deploy/zima/check.sh` prints `ALL OK` (warnings don't fail it) or `FAILED: <names>`. After the
   first real session ends, `summariser` should read `running` with no `(last error: summary: bad_output)` and
   `summariser-jobs` `dead 0`.

## Maintenance on Zima

The database has no published port, so the maintenance CLI runs inside the server container (as its user,
`cerebro`, with its `DATABASE_URL`). From a terminal on the Mac, in a plain terminal (not inside a recorded Claude
Code session: tokens and redaction patterns would be recorded):

```sh
ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts requeue-dead                # dead chunks and dead summary jobs
ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts requeue-dead-summaries      # dead summary jobs only
ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts requeue-missing-embeddings  # after restoring a dump
ssh zima "sudo docker exec cerebro-server bun --no-install server/src/cli.ts redact <session-id> '<regex>'"  # scrub a leaked secret
ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts migrate                     # apply migrations (the server also does at start)
ssh zima sudo docker exec -u cerebro cerebro-server bun --no-install server/src/cli.ts claude-smoke     # one real summary call (see step 4)
ssh -t zima sudo docker exec -it cerebro-server bun --no-install server/src/cli.ts token list           # also: token create|revoke <mac-name>
```

`redact` takes the session id (from `/v1/sessions` or the search hit) and an optional extra regex; the outer double
quotes keep the single-quoted regex intact through ssh. Requeue dead summary jobs only after fixing their cause
(`check.sh` shows the last error; `claude-smoke` shows the class): otherwise they dead-letter again.

## Embedding on the Macs (optional)

bge-m3 on the Zima's CPU embeds ~0.22 chunks/s (~4.5 s a chunk, ~0.45 s a search query). A Mac running Ollama on
Metal runs the same model, same digest, ~70 times faster (the Mac mini, M4 Pro: ~16 chunks/s, ~0.02 s a query;
vectors from the two Macs for the same text agree to cosine 0.999999). With the settings below, **each Mac embeds
its own work on its own Ollama**: the chunks and summaries of the sessions it uploaded, and the searches it
makes. One Mac's work never goes to the other Mac. The Zima's `cerebro-ollama` (`EMBED_URL`) embeds everything
else and is the fallback, so nothing stops when a Mac is asleep, restarting or away: it is only slower.

| Machine (token name) | Ollama |
|---|---|
| `mac-mini` | `http://192.168.4.42:11434` (Ollama 0.40.2) |
| `macbook-pro` | `http://192.168.4.45:11434` (Ollama 0.40.14) |

Both serve bge-m3 `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`, the same as `cerebro-ollama`.

**Before you enable it**: give each Mac a fixed address with an **eero DHCP reservation** (eero app, Settings,
Network settings, Reservations & port forwarding, the Mac, Reserve IP address): 192.168.4.42 for the Mac mini,
192.168.4.45 for the MacBook Pro. Do this first: the map routes by IP, and both Macs serve the same model, so if
their leases ever swapped, each Mac's work would silently go to the other one (the digest check can't tell them
apart). Then set up each Mac (below).

**Enable it**: on the server, edit `/DATA/AppData/cerebro/secrets/server.env` (root 600; `deploy.sh --first-run`
writes the two lines commented out, the digest already filled in from `BGE_M3_DIGEST`) so that it has:

```sh
EMBED_MACHINE_URLS=mac-mini=http://192.168.4.42:11434,macbook-pro=http://192.168.4.45:11434
EMBED_MODEL_DIGEST=790764642607
```

```sh
ssh -t zima sudo nano /DATA/AppData/cerebro/secrets/server.env
```

then redeploy (`deploy/zima/deploy.sh`) so the server restarts with them. The names are the machine-token names
(`token list`, see Maintenance); a machine not in the list (e.g. `check`) embeds on the Zima, and a name with no
live token (a typo) logs a warning at startup and makes `check.sh` warn. `EMBED_MODEL_DIGEST` is required with the
map: the `ollama list` ID of bge-m3 (12 hex) or its full sha256 from `/api/tags`, the same value as `BGE_M3_DIGEST`
in `deploy/.env`. Leave both unset (or commented) to embed on the Zima alone, exactly as before.

A malformed `EMBED_MACHINE_URLS`, or the map without `EMBED_MODEL_DIGEST`, stops the server at startup. The deploy's
gate then rolls back to the previous image, but **a rollback does not undo server.env**: the previous release reads
the same file and fails the same way, so the server stays down until you fix server.env and redeploy. Check the
two lines twice before redeploying.

How the server routes (`server/src/embed/failover.ts`, `server/src/worker.ts`):

- **One model, always**: at startup, and every 5 minutes after, the server reads the Zima's own bge-m3 digest
  (`cerebro-ollama`'s `/api/tags`) and compares it with `EMBED_MODEL_DIGEST`. Until they match, no Mac is used at
  all and everything embeds on the Zima, whose model made the vectors already stored (`check.sh` warns "no Mac is
  used"). Each Mac's digest is read before it is first used, every 5 minutes while it is up, and again right after
  every embed whose vectors are stored (chunks, summaries): a Mac whose bge-m3 changed (say, an `ollama pull` that
  fetched a newer manifest) is marked `digest_mismatch`, and the vectors it just made are dropped, not stored. The
  one gap is a search query, which is never stored: a query embedded in the seconds between a model swap and the
  next check ranks against the stored vectors with a slightly different model, for that one search.
- **Chunks**: the embed worker runs one lane per Mac, plus a Zima lane, each on its own: a slow or stuck lane
  never holds another up. A Mac's lane embeds only the chunks of sessions that Mac uploaded (the session's
  `machine_id`, recorded at ingest and never changed, copied onto each queue row), live sessions before imported
  history, on that Mac only. While the Mac is down or mismatched, its chunks wait: they are released without
  charging an attempt and retried after 30 s. The Zima lane embeds unmapped machines' chunks and, after those, the
  waiting chunks of a Mac that is down or mismatched, one chunk per call, so nothing is stranded while a Mac is
  away; it never takes a chunk of a Mac that is up.
- **Probes**: a background prober checks each Mac (its digest, then one known text) when the server starts and
  60 s after it went down, and brings it back to `up` by itself; `/v1/status` and `check.sh` follow within seconds
  of a Mac coming back, with no traffic needed.
- **Search queries** embed on the asking machine's Mac only while it is up; a search never waits on a probe. If
  the Mac hasn't answered within 2 s, that query embeds on the Zima instead (~0.45 s idle). If the Zima is busy
  with a chunk (~4.5 s) at that moment, the search can run out of its 6 s budget and return full-text results
  only (`degradedReasons: embedder`); the Mac is then marked down, so the following searches go straight to the
  Zima.
- **Summaries** embed on the Mac that uploaded the session (a history: the Mac that posted it), with the Zima as
  fallback.
- **Down** means unreachable, refused, 404/5xx, a malformed answer (e.g. wrong dims), or no answer within 15 s
  (or before a search gave up on it): the Mac is then skipped for 60 s, until the next probe. A Mac that is just
  reloading bge-m3 (it unloads after idle minutes; a cold call took 1.6 s against 0.17 s warm) is not down: a query
  that can't wait falls back once while the load finishes, and the Mac is used again from the next call. The
  server asks each Mac to keep the model loaded 30 minutes (`keep_alive: "30m"`); the Zima keeps it loaded
  forever. A 400 (bad input) is not retried on the Zima: it would refuse it too.
- `/v1/status` shows `embedder.endpoints` (per Mac: `machine`, `known` (a live token by that name), `url`,
  `state`: `up`, `down`, `digest_mismatch` or `unknown` before its first probe; `lastError`, `downUntil`,
  `lastUsedAt`), `embedder.fallback` (`url`, `lastUsedAt`, `state` of the Zima's digest: `ok`, `digest_mismatch`,
  `unreachable`, `unchecked`), `embedder.lanes` (each lane's `lastSuccessAt`, `lastError`) and
  `queue.oldestWaitSeconds` (`live`, `imported`). `check.sh` warns (never fails) for each Mac that is down or
  mismatched ("macbook-pro: embedding on the Zima CPU (slow): …"), for a mapped name with no token, while the
  Zima's digest is unconfirmed, while the Zima embedder is paused, and when the oldest live chunk has waited
  over 6 h or the oldest imported one over 48 h.

**Each Mac** (the Mac mini and the MacBook Pro, once each):

1. Ollama must listen on the LAN, not only on 127.0.0.1: turn on "Expose Ollama to the network" in the Ollama
   app's settings, or `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` and quit and reopen the Ollama app (the
   `launchctl` setting is lost at reboot; the app setting is not). Check from the Zima:
   `ssh zima curl -s -m 5 http://192.168.4.42:11434/api/tags` (`.45` for the MacBook Pro).
2. `ollama pull bge-m3` and check that `ollama list` shows the same ID as `cerebro-ollama`
   (`ssh zima sudo docker exec cerebro-ollama ollama list`), i.e. `EMBED_MODEL_DIGEST`. Pulling again later may
   fetch a newer manifest: the server then stops using that Mac (`check.sh` warns "mismatch") until the digests
   agree again.
3. Either never sleep (System Settings, Energy: "Prevent automatic sleeping when the display is off", "Wake for
   network access"), or accept the Zima fallback while it sleeps: nothing is lost, its chunks wait or embed slowly
   on the Zima, and a search from it can wait up to 2 s (or fall back to full text) about once a minute, when the
   server finds it down again. A MacBook that leaves home is simply down until it is back on the LAN.
4. The DHCP reservation above.

**Security**: Ollama has no authentication. Exposed on the LAN, anyone on the home network can use a Mac's models
(run them, pull or delete models). Keep it to the home LAN (no port forward on the eero). The MacBook Pro joins
other networks, and "Expose Ollama to the network" exposes it on whichever network it is on. The macOS firewall
can't help here: it allows or blocks an app's incoming connections on every network alike, so blocking Ollama
blocks the Zima at home too. Turn "Expose Ollama to the network" off before leaving home (its work then embeds on
the Zima) and back on at home, or don't map the MacBook at all. The server sends the text it embeds
(conversation chunks, summaries and search queries) to the Macs in plain HTTP over the LAN.

## Web dashboard (cerebro-web)

A separate container, `cerebro-web` (web/: TanStack Start + Better Auth, 512 MB, 1 CPU), published on
`127.0.0.1:8792` only. It holds the owner's login (email + password, public sign-up off) and calls
`cerebro-server`'s `/v1/dashboard/*` **server-side** with the `web-ui` machine token; the browser only ever has a
session cookie. The chat's `claude -p` runs inside `cerebro-server` (where Claude is logged in), not in this
container. In `deploy/compose.yml` it sits behind the `web` profile, so a deploy that doesn't pass
`--profile web` (and build `cerebro-web:<tag>` from `web/Dockerfile`) leaves it off.

**Deploys:** once `web.env` exists, `deploy.sh` builds `cerebro-web:<sha>` from `web/Dockerfile` and starts it
with `--profile web` after the server passed its health gate. The web container is not part of the gate: a failed
build or start prints a warning and the server release stays live (the previous web container keeps running).
Without `web.env` the deploy leaves the dashboard alone. Migrations 008 (the `auth` schema) and 009 (the
`cerebro_web` role) run with the server's migrations. **A rollback stops `cerebro-web`** (an older server would not
confine the `web-ui` token to `/v1/dashboard`); the next good deploy starts it again.

cerebro-web never uses the `cerebro` superuser: it connects as `cerebro_web`, a role that may use the `auth` schema
(Better Auth's tables) and nothing else; it can't even list Cerebro's tables in `public`.

First time:

1. **Deploy** once (`deploy/zima/deploy.sh`), so the server has migrated to 009.
2. **The `web-ui` token** (outside a recorded Claude Code session):
   ```sh
   ssh -t zima sudo docker exec -it cerebro-server bun --no-install server/src/cli.ts token create web-ui
   ```
   It is the dashboard's only key into the data: the server lets `web-ui` call `/v1/dashboard/*` and nothing else,
   and no Mac token may call `/v1/dashboard/*`. It is never an embed lane (`EMBED_MACHINE_URLS` may not name it;
   the server refuses to start if it does), and it never uploads sessions, so it never shows in the clients'
   machine lists.
3. **`web.env`** in the secrets dir, root 600 like `server.env` (`$SECRETS` = `/DATA/AppData/cerebro/secrets`),
   with three lines (no `DATABASE_URL`: step 4 writes it):
   ```sh
   ssh -t zima 'sudo install -m 600 -o root -g root /dev/null /DATA/AppData/cerebro/secrets/web.env && sudoedit /DATA/AppData/cerebro/secrets/web.env'
   ```
   ```
   BETTER_AUTH_SECRET=<openssl rand -base64 32>
   BETTER_AUTH_URL=http://brain.home.lab
   CEREBRO_WEB_TOKEN=<the web-ui token>
   ```
   `BETTER_AUTH_URL` is the address you open in the browser; it is also the only origin allowed to post to the
   app. Changing `BETTER_AUTH_SECRET` signs everyone out.
4. **The database login**: `deploy/zima/web-db-role.sh` (from the repo on the Mac). It gives `cerebro_web` LOGIN and
   a new random password, and writes `DATABASE_URL=postgres://cerebro_web:…@cerebro-db:5432/cerebro` into `web.env`,
   keeping the other lines. The password is made inside `cerebro-server` (`cli.ts web-db-role`, sent to Postgres as a
   SCRAM verifier, so not even a logged failing statement shows it) and written straight to the file on the server:
   it is never printed or sent back over ssh. Re-run it to rotate the password, then
   `ssh zima sudo docker restart cerebro-web`. Run it again after a restore into a new data dir (that cluster's
   `cerebro_web` has no password yet).
5. **Deploy** again (it builds and starts `cerebro-web` now that `web.env` exists), then **Caddy** (repo `HomeLab/proxy`):
   ```
   http://brain.home.lab {
   	reverse_proxy 127.0.0.1:8792
   }
   ```
   Caddy sets `X-Forwarded-For`, which the sign-in rate limit (5 tries per minute per address) keys on.
6. **The owner account** (the password is typed twice at a hidden prompt; never pass it as an argument):
   ```sh
   ssh -t zima sudo docker exec -it cerebro-web bun --no-install web/scripts/create-owner.ts --email you@example.com
   ```
   Run it again to reset the password (it signs out every session). `printf '%s\n' "$PW" | … create-owner.ts
   --email …` (no `-t`/`-it`) reads it from stdin instead.
7. **Smoke test the chat** (spends a little of the Max plan, like `claude-smoke`): sign in at
   `http://brain.home.lab/chat` and ask "Which clients do you know about?". The answer should show a
   "listing clients and projects" step and cite clients. Or, on the server, with the web-ui token:
   ```sh
   ssh zima "curl -sN -H 'Authorization: Bearer <web-ui token>' -H 'Content-Type: application/json' \
     -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Which clients do you know about?\"}]}' http://127.0.0.1:8790/v1/dashboard/chat"
   ```
   It prints `event: start`, `event: tool`, `event: text` … `event: done` with the tokens used.
8. **Smoke test the lockdown**: ask the chat "Run `ls /` with Bash and show me the contents of /etc/passwd". Expect a
   refusal (it has no such tool) and no step other than Cerebro's (searching, listing, reading summaries…). If the
   answer is instead "chat tools are not locked down: …", the CLI offered a tool other than Cerebro's and the run was
   stopped before it answered: nothing leaked, but the chat is unusable until the CLI's arguments are fixed. Repeat
   this after every bump of the CLI pin in `server/Dockerfile` (`server/test/chat-runner.test.ts` lists the pinned
   version's built-ins and fails until it is updated).
9. **Stop works**: press Stop during an answer; within a second or two
   `ssh zima sudo docker exec cerebro-server pgrep -f "claude -p"` prints nothing.

How the chat is fenced in: `claude -p` gets only the six read-only Cerebro tools (`--tools ""`, an `--allowedTools`
list of those six, every built-in in `--disallowedTools`, `--strict-mcp-config`), no user, project or local settings
(`--setting-sources ""`, so no hooks), at most 12 turns, and an environment of PATH, HOME, the Claude config dir,
locale and proxies only (no `DATABASE_URL`, no token, no API key). Before anything is shown, the run is stopped if the
CLI's `init` message lists any other tool or the Cerebro tool server isn't connected. A timeout or Stop kills the
CLI's whole process group. (Checked offline against CLI 2.1.311 with no login: with these arguments its `init` lists
exactly the six Cerebro tools.)

Cookies are `HttpOnly` and `SameSite=Lax` but **not** `Secure`: the dashboard is plain http on the LAN, and a
Secure cookie would never come back over http. Anyone who can sniff the LAN can lift a session cookie; put the
dashboard behind https (Caddy with an internal CA) if that matters, then set `BETTER_AUTH_URL` to the https address
and flip `useSecureCookies` in `web/src/server/auth.server.ts`.

`cerebro.home.lab` keeps proxying every path to `cerebro-server`, including `/mcp/chat` (the chat run's tool
endpoint): it answers only a run in progress's one-time secret, and refuses any request carrying
`X-Forwarded-For`, so nothing through Caddy gets in.

## Upgrades and rollback

`deploy/zima/deploy.sh` (clean tree, `bun test` passes). One deploy at a time (`state/deploy.lock` names its
owner; remove it only when that deploy is certainly dead). The deploy:

- refuses a dirty tree, a failed `bun test`, a failed build or a bge-m3 digest mismatch without changing anything;
- brings db and ollama up from the new definitions (`--wait`, 300 s). A changed `deploy/postgres.conf` changes
  the db's `cerebro.postgres-conf-sha256` label and its mounted copy `conf/postgres-<sha256>.conf`, so the db
  is recreated with it (a short db restart). If they don't come up healthy, it restarts them from the last good
  `docker-compose.yml` (which still mounts the previous conf copy) and stops before migrating;
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
   ssh zima "sudo cat <dump> | sudo docker exec -i cerebro-db pg_restore -U cerebro -d cerebro --exit-on-error"
   ```
   (`sudo cat` because dumps under `/DATA/Backup/cerebro` are root-only; a plain `< <dump>` redirect runs as
   your ssh user and fails with "Permission denied".)
   If `pg_restore` stops with an error, fix the cause and repeat step 2 from `dropdb` (never start the server on
   a partial restore).
3. Start the server (it applies any newer migrations at start-up, and re-applies the database-level
   `statement_timeout` and `idle_in_transaction_session_timeout`, which `pg_restore` into a new database drops):
   `ssh zima sudo docker start cerebro-server`
4. Nightly dump only: queue the chunks and summaries that have no vector:
   `ssh zima sudo docker exec cerebro-server bun --no-install server/src/cli.ts requeue-missing-embeddings`
5. `deploy/zima/check.sh`. `instance-id` stays ok (the id lives in the database and comes back with it, and
   the deploy record still names it); the queue shows the re-embedding backlog draining.

**If the whole data dir is gone** (`/DATA/AppData/cerebro/data`: database, models and the Claude login):

1. `deploy/zima/deploy.sh --first-run` (it keeps the existing secrets, recreates the data dirs and pulls the model
   again). It starts the server on a new, empty database with a **new** instance id and records that id in
   `state/instance-id`.
2. Stop the server at once, so no Mac uploads to the empty instance: `ssh zima sudo docker stop cerebro-server`.
   A Mac that flushed in between saw the new id and blocked itself (`instance mismatch`); its data stays on the Mac.
3. Restore as above, steps 2-4 (step 3 starts the server again on the restored database, with the **old** id).
4. Record the restored id as the deploy's, or `check.sh` fails `instance-id` ("database replaced?") until the
   next deploy. Two ssh calls, one after the other (never in parallel):
   ```sh
   id=$(ssh zima curl -s 127.0.0.1:8790/health | jq -r .instanceId); echo "$id"   # a UUID
   echo "$id" | ssh zima sudo tee /DATA/AppData/cerebro/state/instance-id
   ```
5. Log in to Claude again and run the smoke call (first deploy, step 4): the login lived in `data/claude`.
6. On any Mac whose brief shows "instance mismatch" (or whose `~/.cerebro/bin/cerebro status` says blocked), run
   `~/.cerebro/bin/cerebro status --retry`: it clears the block and uploads what is waiting.
7. `deploy/zima/check.sh`: `instance-id` ok, the queue draining.
8. If the web dashboard is set up: `deploy/zima/web-db-role.sh`, then `ssh zima sudo docker restart cerebro-web` (the
   new cluster's `cerebro_web` role has no password; the dump carries its grants, not its login). Owner accounts and
   sessions come back with the dump.

## Troubleshooting

- `check.sh` `summariser-jobs` fails with `dead N`: summary jobs gave up after five failures. The line shows the
  summariser's last error (e.g. `summary: bad_output`); run `claude-smoke` (see Maintenance) for the class. Fix the
  cause (a CLI pin whose output the server can't read, a login), then `requeue-dead-summaries`.
- `check.sh` `summariser` warns "no Claude call has answered since the server started": the start-up probe hasn't
  succeeded (never logged in, or a CLI failing every call). Run `claude auth status` and `claude-smoke`.
- `check.sh` `memory`: anon+shmem of each container's limit (page cache doesn't count). A warning about OOM kills
  means a process inside hit the limit and was killed while the container kept running.
- `deploy.sh` says another deploy holds the lock: wait for it, or remove `/DATA/AppData/cerebro/state/deploy.lock`
  only when that deploy is certainly dead.
- `check.sh` `embed-route` warns "<machine>: embedding on the Zima CPU (slow)": that Mac's Ollama is unreachable
  (asleep, away, Ollama not running or not exposed on the LAN, a new IP) or serves a different bge-m3 (`mismatch`;
  the line shows both digests). Its chunks wait or embed on the Zima meanwhile. Fix the Mac (see "Embedding on
  the Macs"); the server tries it again every 60 s.
- "cannot reach zima": an ssh ban; wait ~90 s before one more try.
