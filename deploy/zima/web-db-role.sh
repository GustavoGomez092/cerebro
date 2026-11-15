#!/usr/bin/env bash
# Gives cerebro-web its own database login (role cerebro_web, migration 009: the `auth` schema only, never the
# `cerebro` superuser) and puts its DATABASE_URL into $SECRETS/web.env (root 600), keeping the file's other lines.
#
#   deploy/zima/web-db-role.sh        # from the repo on a Mac; re-run to rotate the password
#
# The password is made inside cerebro-server (`cli.ts web-db-role`, sent to Postgres as a SCRAM verifier), captured
# on the server and written straight to web.env: it is never printed, logged or sent back over ssh.
# Then restart the dashboard: ssh zima sudo docker restart cerebro-web (or deploy).
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=deploy/zima/lib.sh
source deploy/zima/lib.sh

# Runs on the server as root (zfn). stdin is the script itself, so docker exec reads /dev/null instead.
set_web_db_url() {
  local env=$1 line
  if ! line=$(docker exec -i cerebro-server bun --no-install server/src/cli.ts web-db-role </dev/null); then
    echo "web-db-role: cerebro-server could not set the role's password (is it running and migrated?)" >&2
    return 1
  fi
  case $line in
    DATABASE_URL=postgres://cerebro_web:*) ;;
    *) echo "web-db-role: unexpected answer from cerebro-server; web.env unchanged" >&2; return 1 ;;
  esac
  {
    if [ -f "$env" ]; then grep -v '^DATABASE_URL=' "$env" || true; fi
    printf '%s\n' "$line"
  } | secret_write "$env"
  chown root:root "$env"
}

zfn set_web_db_url "$SECRETS/web.env" || die "web.env unchanged"
say "web.env now connects as cerebro_web; restart the dashboard: ssh zima sudo docker restart cerebro-web"
