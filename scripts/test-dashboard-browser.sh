#!/bin/sh
# Browser regressions must never read/write the operator's live Store.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
store=$(mktemp -d "${TMPDIR:-/tmp}/relay-dashboard-test.XXXXXX")
trap 'rm -rf "$store"' EXIT
export AGENTS_RELAY_STORE_DIR="$store/stores"
mkdir -p "$AGENTS_RELAY_STORE_DIR"
export AGENTS_RELAY_SCRIPT_NODE="$(command -v node)"
: "${CARGO_TARGET_DIR:=$root/rust/target}"
export CARGO_TARGET_DIR
cd "$root"
npm --prefix dashboard/tests/e2e ci --ignore-scripts --no-audit --no-fund
node --test dashboard/*.test.mjs
cargo test --locked --manifest-path rust/Cargo.toml --test native_dashboard_browser -- --ignored --nocapture
