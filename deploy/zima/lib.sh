# shellcheck shell=bash
# Shared by deploy.sh and check.sh (owner-specific: the ZimaOS box reached as `ssh zima`).
# shellcheck disable=SC2034 # the paths below are used by the scripts that source this file

ZIMA_HOST=${ZIMA_HOST:-zima}
# One multiplexed connection shared with the other HomeLab scripts: sshd bans the client after any
# aborted or failed connection, so never probe and never open parallel connections.
ZSSH_OPTS=(-o ControlMaster=auto -o "ControlPath=/tmp/led-notify-ssh-%r@%h:%p" -o ControlPersist=600 -o BatchMode=yes)

APP=/DATA/AppData/cerebro
SRC=$APP/src
DATA=$APP/data
SECRETS=$APP/secrets
STATE=$APP/state
COMPOSE=$APP/docker-compose.yml # rendered: variables resolved, absolute paths (ZimaOS stores this copy)
CASA_COMPOSE=/var/lib/casaos/apps/cerebro/docker-compose.yml
BGE_MANIFEST=$DATA/ollama/models/manifests/registry.ollama.ai/library/bge-m3/latest

die() { echo "$(basename "$0"): $*" >&2; exit 1; }
say() { echo "$(basename "$0"): $*"; }

# shellcheck disable=SC2029 # commands are built locally on purpose (paths), run remotely
zssh() { ssh "${ZSSH_OPTS[@]}" "$ZIMA_HOST" "$@"; }

# Value of KEY in a dotenv file (last assignment wins, surrounding quotes dropped). Not for secrets.
env_get() {
  local v
  v=$(sed -n "s/^$1=//p" "$2" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

# --- Secret helpers. They run ON the server (shipped with `zfn`) and never print a secret. ---

# Writes stdin to FILE, mode 600, atomically. Prints nothing.
secret_write() {
  local tmp
  tmp=$(mktemp "$1.XXXXXX")
  cat > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}

# Value of VAR in the env FILE, for capture in $(…) only.
secret_read() { sed -n "s/^$2=//p" "$1" | head -n 1; }

# 40 random alphanumerics from /dev/urandom (the host has no openssl; URL-safe for DATABASE_URL).
secret_new() {
  local s
  s=$(head -c 60 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  printf '%s' "${s:0:40}"
}

# Runs the local bash function FN on the server as root, with the secret helpers defined: zfn FN [ARGS…].
# Arguments travel on the command line (plain paths only); the function body travels on stdin.
zfn() {
  local fn=$1
  shift
  { declare -f secret_write secret_read secret_new "$fn"; printf 'set -euo pipefail\n%s "$@"\n' "$fn"; } |
    zssh "sudo bash -s -- $*"
}
