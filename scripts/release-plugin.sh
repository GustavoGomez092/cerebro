#!/bin/sh
# Builds the Cerebro plugin binaries and publishes plugin/ as a single commit on the orphan
# branch `plugin-dist` (replacing it), tagged `plugin-v<version>`.
#
#   scripts/release-plugin.sh <version> [--dry-run] [--remote <url>]
#
# The repo is the one this script lives in. The push target is `origin`, which must be the
# GitHub repo GustavoGomez092/cerebro; --remote <url> pushes elsewhere instead (testing).
# --dry-run runs the guards, prints every other step and changes nothing.
# RELEASE_TEST_CMD overrides the test command (default: bun test).
set -eu

usage() { echo "usage: release-plugin.sh <version> [--dry-run] [--remote <url>]" >&2; exit 2; }

version=""
dry=0
remote=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --remote) [ $# -ge 2 ] || usage; remote="$2"; shift ;;
    -*) usage ;;
    *) [ -z "$version" ] || usage; version="$1" ;;
  esac
  shift
done
[ -n "$version" ] || usage
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'; then
  echo "refusing to release: invalid version '$version' (expected e.g. 0.2.0)" >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "refusing to release: $root is not a git repository" >&2; exit 1; }

# Push target: an explicit --remote, otherwise origin, which must be the real GitHub repo.
if [ -z "$remote" ]; then
  remote=$(git remote get-url origin 2>/dev/null) || { echo "refusing to release: no origin remote" >&2; exit 1; }
  if ! printf '%s' "$remote" | grep -Eq '^(https://([^/@]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)GustavoGomez092/cerebro(\.git)?/?$'; then
    echo "refusing to release: origin is '$remote', not GitHub GustavoGomez092/cerebro (use --remote <url> to push elsewhere)" >&2
    exit 1
  fi
elif [ -d "$remote" ]; then
  remote=$(CDPATH= cd -- "$remote" && pwd)   # the push runs from another directory
fi

tag="plugin-v$version"
if [ -n "$(git tag -l "$tag")" ]; then
  echo "refusing to release: tag $tag already exists locally" >&2
  exit 1
fi
remote_tags=$(git ls-remote --tags "$remote" "refs/tags/$tag") || { echo "refusing to release: cannot reach $remote" >&2; exit 1; }
if [ -n "$remote_tags" ]; then
  echo "refusing to release: tag $tag already exists on $remote" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to release: working tree is dirty" >&2
  exit 1
fi

test_cmd=${RELEASE_TEST_CMD:-bun test}
echo "+ $test_cmd"
if ! sh -c "$test_cmd" >&2; then
  echo "refusing to release: tests failed" >&2
  exit 1
fi

step() {
  echo "+ $*"
  [ "$dry" = 1 ] || "$@"
}

for arch in arm64 x64; do
  step bun build client/src/cli.ts --compile --minify "--target=bun-darwin-$arch" --outfile "plugin/bin/cerebro-darwin-$arch"
done

stage="${TMPDIR:-/tmp}/cerebro-plugin-dist.$$"
echo "+ stage plugin/ (minus ignored junk) into $stage with plugin.json version=$version"
echo "+ git init (orphan branch plugin-dist) && git commit -m 'cerebro plugin $version'"
echo "+ git tag $tag"
echo "+ git push --atomic --force $remote plugin-dist $tag"
if [ "$dry" = 1 ]; then
  echo "dry run: nothing was changed"
  exit 0
fi

trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage"
cp -R plugin/. "$stage/"
# Drop whatever git would ignore (.DS_Store, ...), except the compiled binaries.
git ls-files --others --ignored --exclude-standard --directory plugin | while IFS= read -r f; do
  case "$f" in
    plugin/bin/cerebro-darwin-*) ;;
    *) rm -rf "$stage/${f#plugin/}" ;;
  esac
done
bun -e '
  const f = process.argv[1] + "/.claude-plugin/plugin.json";
  const j = JSON.parse(await Bun.file(f).text());
  j.version = process.argv[2];
  await Bun.write(f, JSON.stringify(j, null, 2) + "\n");
' "$stage" "$version"
git -C "$stage" init -q -b plugin-dist
git -C "$stage" add -A
git -C "$stage" -c commit.gpgsign=false -c user.name="Cerebro release" -c user.email="release@cerebro.invalid" commit -q -m "cerebro plugin $version"
git -C "$stage" tag "$tag"
git -C "$stage" push --atomic --force "$remote" plugin-dist "$tag"
echo "released $tag"
