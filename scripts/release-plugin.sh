#!/bin/sh
# Builds the Cerebro plugin binaries and publishes plugin/ as a single commit on the orphan
# branch `plugin-dist` (replacing it), tagged `plugin-v<version>`.
#
#   scripts/release-plugin.sh <version> [--dry-run]
#
# --dry-run prints every step it would take and changes nothing.
# RELEASE_TEST_CMD overrides the test command (default: bun test).
set -eu

version=""
dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    -*) echo "usage: release-plugin.sh <version> [--dry-run]" >&2; exit 2 ;;
    *) version="$arg" ;;
  esac
done
[ -n "$version" ] || { echo "usage: release-plugin.sh <version> [--dry-run]" >&2; exit 2; }

root=$(git rev-parse --show-toplevel)
cd "$root"

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
remote=$(git remote get-url origin 2>/dev/null || echo "<origin>")
echo "+ stage plugin/ into $stage with plugin.json version=$version"
echo "+ git init (orphan branch plugin-dist) && git commit -m 'cerebro plugin $version'"
echo "+ git tag plugin-v$version"
echo "+ git push --force $remote plugin-dist"
echo "+ git push $remote plugin-v$version"
if [ "$dry" = 1 ]; then
  echo "dry run: nothing was changed"
  exit 0
fi

trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage"
cp -R plugin/. "$stage/"
bun -e '
  const f = process.argv[1] + "/.claude-plugin/plugin.json";
  const j = JSON.parse(await Bun.file(f).text());
  j.version = process.argv[2];
  await Bun.write(f, JSON.stringify(j, null, 2) + "\n");
' "$stage" "$version"
git -C "$stage" init -q -b plugin-dist
git -C "$stage" add -A
git -C "$stage" -c user.name="Cerebro release" -c user.email="release@cerebro.invalid" commit -q -m "cerebro plugin $version"
git -C "$stage" tag "plugin-v$version"
git -C "$stage" push --force "$remote" plugin-dist
git -C "$stage" push "$remote" "plugin-v$version"
echo "released plugin-v$version"
