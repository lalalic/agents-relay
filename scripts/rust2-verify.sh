#!/bin/sh
# New rust2 QA gate: enforce source checklist, Rust compilation/lints and executable Node/Rust differential fixtures.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"
if [ "$(git branch --show-current)" != rust2 ]; then
  echo 'Refusing rust2 verification outside branch rust2' >&2
  exit 2
fi
node scripts/rust2-checklist-verify.mjs
cargo fmt --check --manifest-path rust/Cargo.toml
cargo test --offline --manifest-path rust/Cargo.toml
cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings
# Every independent head-to-head suite must run: no selective success claims.
set -- rust/tests/head_to_head*.mjs
for file in "$@";do
  if [ ! -f "$file" ];then echo "Missing differential test: $file" >&2;exit 3;fi
done
node --test "$@"
