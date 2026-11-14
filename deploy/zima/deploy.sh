#!/usr/bin/env bash
# Deploy Cerebro to the ZimaOS box: deploy/zima/deploy.sh [--first-run]
#
# clean tree + `bun test` → server-side deploy lock → first run: secrets (root 700/600, generated on the
# server, never printed) and data dirs → rsync the repo to /DATA/AppData/cerebro/src → build
# cerebro-server:<sha7> → bge-m3 present with the digest pinned in deploy/.env → db + ollama up → pre-deploy
# dump when the migration list differs from the schema's → migrate in a one-off container → tag the last
# release that passed the gate as :prev → start the new server → health gate (/health ok + db within 60 s); a failed start, failed gate or an
# interrupt rolls back to :prev and exits 1 → check token, ZimaOS registration, old image cleanup.
#
# Rollback runs :prev on the schema the new release migrated, so migrations must stay backward-compatible
# (expand/contract; see README "Deploying to the Zima server").
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/zima/lib.sh
source "$HERE/lib.sh"
cd "$(git -C "$HERE" rev-parse --show-toplevel)"

FIRST_RUN=0
case "${1-}" in
  --first-run) FIRST_RUN=1 ;;
  "") ;;
  *) die "usage: deploy/zima/deploy.sh [--first-run]" ;;
esac

for tool in git rsync jq awk; do command -v "$tool" >/dev/null || die "needs $tool"; done
ENV_FILE=deploy/.env
[[ -f $ENV_FILE ]] || die "missing deploy/.env (copy deploy/.env.example and set BGE_M3_DIGEST)"
BGE_M3_DIGEST=$(env_get BGE_M3_DIGEST "$ENV_FILE")
BGE_M3_DIGEST=${BGE_M3_DIGEST#sha256:}
[[ ${#BGE_M3_DIGEST} -ge 12 ]] || die "set BGE_M3_DIGEST in deploy/.env (bge-m3's Ollama digest, at least 12 hex chars)"
OLLAMA_CPUS=$(env_get OLLAMA_CPUS "$ENV_FILE")
OLLAMA_CPUS=${OLLAMA_CPUS:-4}
OLLAMA_IMAGE=$(sed -n 's/^ *image: *\(ollama\/ollama[^ ]*\) *$/\1/p' deploy/compose.yml)
[[ -n $OLLAMA_IMAGE ]] || die "no ollama/ollama image in deploy/compose.yml"
HEALTH_TIMEOUT=${CEREBRO_HEALTH_TIMEOUT:-60}

[[ -z $(git status --porcelain) ]] || die "working tree is dirty; commit first (the image tag is the commit)"
bun test || die "bun test failed; not deploying"

SHA=$(git rev-parse --short=7 HEAD)
IMAGE=cerebro-server:$SHA
NEXT=$APP/docker-compose.next.yml # the release being deployed; becomes $COMPOSE once healthy
LOCK=$STATE/deploy.lock
OWNER="$SHA from $(hostname -s 2>/dev/null || hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
MIGRATIONS=$(git ls-files -- server/migrations | sed 's|.*/||' | sort)
DUMPS=$STATE/pre-deploy
DUMP=""     # pre-deploy dump taken by this run
MIGRATED="" # migrations this release applied

# deploy/compose.yml with its variables resolved and absolute paths, so ZimaOS can run its stored copy as is.
render_compose() {
  # Patterns live in variables: bash 3.2 (macOS) splits ${c//pat/rep} at a '/' even inside quotes.
  local c tag=$1 conf=$SRC/deploy/postgres.conf:
  # shellcheck disable=SC2016 # literal compose variables, not expansions
  local v_data='${CEREBRO_DATA}' v_secrets='${CEREBRO_SECRETS}' v_tag='${CEREBRO_TAG}' v_cpus='${OLLAMA_CPUS:-4}' rel='./postgres.conf:'
  c=$(cat deploy/compose.yml)
  c=${c//"$v_data"/$DATA}
  c=${c//"$v_secrets"/$SECRETS}
  c=${c//"$v_tag"/$tag}
  c=${c//"$v_cpus"/$OLLAMA_CPUS}
  c=${c//"$rel"/$conf}
  # shellcheck disable=SC2016
  [[ $c != *'${'* ]] || die "deploy/compose.yml uses a variable render_compose does not resolve"
  printf '%s\n' "$c"
}

# The x-casaos block (dashboard tile metadata) of a compose file on stdin.
casaos_meta() { awk '/^x-casaos:/ { on = 1; print; next } on && /^[^[:space:]#]/ { on = 0 } on'; }

# Polls /health until the deadline; on {ok: true, db: true} prints the instanceId and succeeds.
health_gate() {
  local body deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    body=$(zssh "curl -s -m 2 http://127.0.0.1:8790/health" || true)
    if [[ -n $body ]] && jq -e '.ok == true and .db == true' >/dev/null 2>&1 <<<"$body"; then
      jq -r '.instanceId // empty' <<<"$body"
      return 0
    fi
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

# Puts :prev back after the new server failed to start, failed the gate or was interrupted; always exits 1.
rollback() {
  trap '' INT TERM # a half-done rollback is worse than a slow one
  local msg="$IMAGE $1" logs="ssh zima sudo docker logs --tail 50 cerebro-server"
  if [[ -n $MIGRATED ]]; then
    msg="$msg; it applied migrations ($MIGRATED), so :prev runs on the migrated schema; pre-deploy dump: ${DUMP:-none taken} (not restored automatically)"
  fi
  zssh "sudo rm -f $NEXT" || true
  zssh "sudo docker image inspect cerebro-server:prev >/dev/null 2>&1" ||
    die "$msg; there is no cerebro-server:prev to roll back to; see: $logs"
  render_compose prev | zssh "sudo tee $COMPOSE >/dev/null" || die "$msg; could not write the rollback compose"
  zssh "sudo docker compose -f $COMPOSE up -d --no-deps server" ||
    die "$msg; starting cerebro-server:prev failed too; see: $logs"
  if health_gate >/dev/null; then die "$msg; rolled back to cerebro-server:prev (healthy)"; fi
  die "$msg; rolled back to cerebro-server:prev, which is NOT healthy either; see: $logs"
}

# Removes the lock only while its owner line is still this run's (never someone else's lock).
LOCKED=0
release_lock() {
  if ((LOCKED)); then
    zssh "if [ \"\$(sudo cat $LOCK/owner 2>/dev/null)\" = '$OWNER' ]; then sudo rm -rf $LOCK; fi" || true
  fi
}

# --- Functions below run on the server as root (via zfn). ---

# Creates the secrets once (kept on later runs) and the data dirs.
first_run_setup() {
  local secrets=$1 data=$2 pw
  # Data dirs first, with the default umask, so the app dir stays traversable (src/ is synced as the ssh user).
  umask 022
  mkdir -p "$data/db" "$data/ollama" "$data/claude"
  chown 999:999 "$data/db"         # postgres in the pgvector image
  chown 10010:10010 "$data/claude" # cerebro user in the server image (Claude login)
  umask 077
  mkdir -p "$secrets"
  chmod 700 "$secrets"
  chown root:root "$secrets"
  if [[ -s $secrets/db.env ]]; then
    pw=$(secret_read "$secrets/db.env" POSTGRES_PASSWORD)
    echo "secrets: keeping the existing database password"
  else
    pw=$(secret_new)
    printf 'POSTGRES_PASSWORD=%s\n' "$pw" | secret_write "$secrets/db.env"
    echo "secrets: generated the database password (not shown)"
  fi
  [[ -n $pw ]] || { echo "secrets: db.env has no POSTGRES_PASSWORD" >&2; return 1; }
  if [[ ! -s $secrets/server.env ]]; then
    printf '%s\n' "DATABASE_URL=postgres://cerebro:$pw@cerebro-db:5432/cerebro" SUMMARY_SHARE=0.2 \
      SUBSCRIPTION_TOKENS_PER_5H=2000000 SUMMARISER_ENABLED=true | secret_write "$secrets/server.env"
    echo "secrets: wrote server.env"
  fi
  chown root:root "$secrets/db.env" "$secrets/server.env"
}

# Dumps the database (embeddings excluded, like the nightlies) to DIR/NAME, root 600, never overwriting one.
# Keeps the newest 3 by name (<UTC ts>-<sha>.dump), plus this one and the one named in DIR/applied (the
# newest dump taken before a migration that was applied: the recovery point for the current schema).
pre_deploy_dump() {
  local dir=$1 name=$2 tmp keep old
  umask 077
  mkdir -p "$dir"
  chmod 700 "$dir"
  [[ ! -e $dir/$name ]] || { echo "pre-deploy dump $dir/$name already exists" >&2; return 1; }
  tmp=$(mktemp "$dir/.partial.XXXXXX")
  if ! docker exec cerebro-db pg_dump -U cerebro -d cerebro -Fc --exclude-table-data=chunk_embeddings \
    --exclude-table-data=summary_embeddings --exclude-table-data=embed_queue >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$dir/$name"
  keep=$(cat "$dir/applied" 2>/dev/null || true)
  for old in $(find "$dir" -maxdepth 1 -name '*.dump' | sort -r | tail -n +4); do
    case ${old##*/} in "$name" | "$keep") ;; *) rm -f "$old" ;; esac
  done
}

# Creates the `check` machine token for check.sh in FILE (root 600). The token is never printed.
create_check_token() {
  local out tok
  out=$(docker exec cerebro-server bun --no-install server/src/cli.ts token create check)
  tok=$(printf '%s\n' "$out" | grep '^cbr_' | head -n 1)
  [[ -n $tok ]] || { echo "check token: no token in the output of token create" >&2; return 1; }
  umask 077
  printf '%s\n' "$tok" | secret_write "$1"
  chown root:root "$1"
  echo "created the check machine token in $1 (not shown)"
}

# --- Deploy ---

say "deploying $IMAGE to $ZIMA_HOST"
# One deploy at a time (the owner has several Macs): an atomic mkdir on the server, before any change, in one
# connection that also reports a held lock's owner (exit 3). ssh's own failures (255: ban, unreachable) are
# told apart, and nothing retries: another connection while banned only extends the ban.
rc=0
held=$(zssh "sudo mkdir -p $STATE || exit 4
if sudo mkdir $LOCK 2>/dev/null; then printf '%s\n' '$OWNER' | sudo tee $LOCK/owner >/dev/null; exit 0; fi
sudo cat $LOCK/owner 2>/dev/null; exit 3") || rc=$?
case $rc in
  0) ;;
  3) die "another deploy holds $LOCK (${held:-owner unknown}); if it is stale: ssh zima sudo rm -rf $LOCK" ;;
  255) die "cannot reach zima (ssh ban? wait ~90 s before one more try; retrying sooner extends the ban)" ;;
  *) die "could not take the deploy lock (exit $rc)" ;;
esac
LOCKED=1
trap release_lock EXIT
trap 'die "interrupted; the running server is unchanged"' INT TERM

if ((FIRST_RUN)); then
  zfn first_run_setup "$SECRETS" "$DATA"
else
  zssh "sudo test -s $SECRETS/db.env && sudo test -s $SECRETS/server.env" ||
    die "no secrets on the server; run deploy/zima/deploy.sh --first-run"
fi

zssh "sudo mkdir -p $SRC && sudo chown -R \$(id -un) $SRC"
rsync -az --delete --exclude=.git --exclude=.claude --exclude=.superpowers --exclude-from=.gitignore \
  -e "ssh ${ZSSH_OPTS[*]}" ./ "$ZIMA_HOST:$SRC/"

say "building $IMAGE on the server"
zssh "sudo docker build -t $IMAGE -f $SRC/server/Dockerfile $SRC" || die "build failed; nothing changed"

# cerebro-net is internal (no internet), so the model is pulled by a one-off container on the default network
# into the same models dir; the digest check also catches a model that changed upstream.
if ! zssh "sudo test -f $BGE_MANIFEST"; then
  say "pulling bge-m3"
  zssh "sudo docker run --rm --name cerebro-ollama-pull -v $DATA/ollama:/root/.ollama --entrypoint /bin/sh $OLLAMA_IMAGE \
    -c 'ollama serve >/dev/null 2>&1 & for _ in \$(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 1; done; ollama pull bge-m3'"
fi
digest=$(zssh "sudo sha256sum $BGE_MANIFEST" | cut -d' ' -f1) || die "bge-m3 is missing from $DATA/ollama"
[[ $digest == "$BGE_M3_DIGEST"* ]] ||
  die "bge-m3 digest ${digest:0:12} does not match BGE_M3_DIGEST ${BGE_M3_DIGEST:0:12} in deploy/.env; the running server is unchanged"

render_compose "$SHA" | zssh "sudo tee $NEXT >/dev/null"
zssh "sudo docker compose -f $NEXT up -d --wait db ollama"

# A recovery point before the schema changes (rollback brings back the old code, not the old schema). The
# comparison is with the list the schema was last migrated to, so a retry after a rolled-back migration
# doesn't take a post-migration "recovery point" or push the real one out.
schema=$(zssh "sudo cat $STATE/schema-migrations 2>/dev/null" || true)
if [[ $MIGRATIONS != "$schema" ]]; then
  name="$(date -u +%Y%m%dT%H%M%SZ)-$SHA.dump"
  DUMP=$DUMPS/$name
  say "the schema is behind this release's migrations; taking a pre-deploy dump"
  zfn pre_deploy_dump "$DUMPS" "$name" || die "pre-deploy dump failed; not migrating (the running server is unchanged)"
fi
say "migrating"
trap 'die "interrupted during migration; the old server is still running but the schema may be partly migrated${DUMP:+; pre-deploy dump: $DUMP}"' INT TERM
mig_out=$(zssh "sudo docker compose -f $NEXT run --rm --no-deps server bun server/src/cli.ts migrate") || {
  printf '%s\n' "$mig_out"
  die "migration failed; the old server is still running, the schema may be partly migrated${DUMP:+; pre-deploy dump: $DUMP}"
}
trap 'die "interrupted; the schema is migrated but the running server is unchanged"' INT TERM
printf '%s\n' "$mig_out"
MIGRATED=$(sed -n 's/^migrated: //p' <<<"$mig_out")
printf '%s\n' "$MIGRATIONS" | zssh "sudo tee $STATE/schema-migrations >/dev/null"
if [[ -n $MIGRATED && -n $DUMP ]]; then
  printf '%s\n' "${DUMP##*/}" | zssh "sudo tee $DUMPS/applied >/dev/null"
fi

# :prev = the last release that passed the gate (not whatever runs: a failed rollback may have left a
# never-gated image up).
last_good=$(zssh "sudo cat $STATE/deployed 2>/dev/null" | cut -d' ' -f1 || true)
if [[ -n $last_good && $last_good != "$SHA" ]]; then
  if zssh "sudo docker tag cerebro-server:$last_good cerebro-server:prev"; then
    say "kept cerebro-server:$last_good (the last release that passed the gate) as cerebro-server:prev"
  else
    say "warning: cerebro-server:$last_good is gone; cerebro-server:prev stays as it was"
  fi
fi

say "starting $IMAGE"
trap 'rollback "was interrupted while starting"' INT TERM
zssh "sudo docker compose -f $NEXT up -d --no-deps server" || rollback "failed to start"
instance=$(health_gate) || rollback "failed the health gate"
trap 'die "interrupted after $IMAGE went live; re-run the deploy to finish registration"' INT TERM

zssh "sudo mv $NEXT $COMPOSE"
printf '%s\n' "$instance" | zssh "sudo tee $STATE/instance-id >/dev/null"
printf '%s %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | zssh "sudo tee $STATE/deployed >/dev/null"

if ! zssh "sudo test -s $SECRETS/check.token"; then
  zfn create_check_token "$SECRETS/check.token" ||
    say "warning: could not create the check machine token; check.sh needs $SECRETS/check.token"
fi

# ZimaOS reads the dashboard tile from its stored compose. A new app is registered with `install`; for an
# installed (uncontrolled) app, `apply` doesn't refresh the stored copy, so copy it over and restart app
# management only when the tile metadata changed (no container recreate).
if zssh "sudo test -f $CASA_COMPOSE"; then
  old_meta=$(zssh "sudo cat $CASA_COMPOSE" | casaos_meta)
  new_meta=$(render_compose "$SHA" | casaos_meta)
  zssh "sudo cp $CASA_COMPOSE $APP/casaos-compose.bak.yml && sudo cp $COMPOSE $CASA_COMPOSE"
  if [[ $old_meta != "$new_meta" ]]; then
    zssh "sudo systemctl restart zimaos-app-management"
    say "dashboard metadata changed; restarted zimaos-app-management"
  fi
else
  zssh "sudo casaos-cli app-management install -f $COMPOSE"
  say "registered the ZimaOS app"
fi

# Old server images: keep this release, :prev and whatever ZimaOS's stored compose references.
stored_tag=$(zssh "sudo cat $CASA_COMPOSE 2>/dev/null" | sed -n 's/^ *image: *\(cerebro-server:[^ ]*\).*$/\1/p' | head -n 1 || true)
stale=""
for t in $(zssh "sudo docker images cerebro-server --format '{{.Repository}}:{{.Tag}}'" || true); do
  case $t in
    "$IMAGE" | cerebro-server:prev | "$stored_tag" | *"<none>") ;;
    *) stale="$stale $t" ;;
  esac
done
if [[ -n $stale ]]; then zssh "sudo docker rmi$stale" || say "warning: could not untag$stale"; fi
zssh "sudo docker builder prune -f --filter until=168h >/dev/null" || say "warning: build cache prune failed"

say "$IMAGE is live (instance ${instance:-unknown})"
