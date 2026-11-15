#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
python3 scripts/rust-cli-parity-audit.py --check
python3 scripts/rust-native-cli-surface.py
cargo build --locked --manifest-path rust/Cargo.toml --bins
node --test rust/tests/native-cli-node-parity-e2e.mjs rust/tests/native-live-dashboard-e2e.mjs
printf '%s\n' 'CLI parity inventory and current supported Rust-native E2Es: PASS'
printf '%s\n' 'Full CLI parity remains gated by python3 scripts/rust-cli-parity-audit.py --require-parity'
