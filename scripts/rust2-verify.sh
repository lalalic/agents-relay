#!/bin/sh
# New rust2 QA gate: enforce source checklist, Rust compilation/lints and executable Node/Rust differential fixtures.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"
branch=$(git branch --show-current)
case "$branch" in
  rust2) ;;
  hotfix/rust2-*)
    # Integration runs before a single ff-only merge; do not verify stale branches.
    if ! git merge-base --is-ancestor rust2 HEAD; then
      echo 'Refusing rust2 verification: integration branch does not contain rust2 HEAD' >&2
      exit 2
    fi
    ;;
  *)
    echo 'Refusing rust2 verification outside rust2 or a descendant integration branch' >&2
    exit 2
    ;;
esac
# Differential fixtures load Node dist/*.js, not src/*.ts. Always rebuild the
# authoritative current Node baseline before comparing its behavior to Rust;
# a stale dist can give false PASS or ERR_MODULE_NOT_FOUND after new modules.
npm run build
node scripts/rust2-checklist-verify.mjs
cargo fmt --check --manifest-path rust/Cargo.toml
cargo test --offline --manifest-path rust/Cargo.toml
cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings
# Every independent head-to-head suite must run: no selective success claims.
set -- rust/tests/head_to_head*.mjs
for file in "$@";do
  if [ ! -f "$file" ];then echo "Missing differential test: $file" >&2;exit 3;fi
done
# Individual suites invoke Cargo and share one binary output path. Running them
# concurrently can observe a short re-link gap (spawnSync ENOENT) even though
# every individual differential comparison is valid. Serialize the suites;
# within each suite, Rust and Node still exercise their normal execution logic.
node --test --test-concurrency=1 "$@"
