#!/bin/sh
# Build the Rust binaries from this exact committed checkout before packaging.
set -eu
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 ABSOLUTE_BINARY_DIR ABSOLUTE_NEW_PACKAGE_DIR" >&2
    exit 2
fi
case "$1:$2" in /*:/*) ;; *) echo "Both paths must be absolute" >&2; exit 2;; esac
bin=$1
out=$2
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
[ ! -e "$out" ] && [ ! -L "$out" ] || { echo "Package already exists: $out" >&2; exit 1; }
for file in agents-relay-rust agents-relayd-rust owned-process-supervisor; do
    [ -x "$bin/$file" ] || { echo "Missing binary: $bin/$file" >&2; exit 1; }
done
mkdir -p "$(dirname "$out")"
stage=$(mktemp -d "$(dirname "$out")/.relay-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
revision=$(git -C "$root" rev-parse HEAD)
# Archive committed resources, not ignored local files, and check extraction independently.
git -C "$root" archive --format=tar "$revision" skills agents workflow dashboard scripts/report-publication.mjs > "$stage/resources.tar"
tar -xf "$stage/resources.tar" -C "$stage"
rm "$stage/resources.tar"
mkdir "$stage/bin"
for file in agents-relay-rust agents-relayd-rust owned-process-supervisor; do
    install -m 755 "$bin/$file" "$stage/bin/$file"
done
printf '%s\n' "$revision" > "$stage/SOURCE_REVISION"
mv "$stage" "$out"
trap - EXIT HUP INT TERM
