#!/bin/sh
# Rust-only production CLI. This wrapper never delegates a mutating command
# to the retired Node Relay implementation or a second SQLite database.
set -eu
: "${HOME:?HOME is required}"
SOURCE=$(/bin/realpath "$0")
RELEASE=$(dirname "$SOURCE")
RUST="$RELEASE/relay-native-job"
HELPER="$RELEASE/relay-worker-helper"
MANIFEST="$HOME/.local/state/agents-relay/canonical-rust/manifest.json"
DB="$HOME/.agents-relay/relay.sqlite"
if [ ! -x "$RUST" ] || [ ! -f "$DB" ]; then
  echo "Rust Relay CLI release or authoritative SQLite is unavailable" >&2
  exit 2
fi
export RELAY_RUST_LIVE_MODE=canonical-live
case "${1:-}" in
  --help|-h|help|version|--version)
    exec "$RUST" --help
    ;;
  status)
    exec "$RUST" "$@"
    ;;
esac
# The caller may explicitly provide --db; Rust validates that it is precisely
# the canonical authority in canonical-live mode. Never silently override it.
HAS_DB=false
HAS_MANIFEST=false
HAS_HELPER=false
FOREGROUND=false
for argument in "$@"; do
  case "$argument" in
    --db) HAS_DB=true ;;
    --manifest) HAS_MANIFEST=true ;;
    --helper) HAS_HELPER=true ;;
    --foreground) FOREGROUND=true ;;
  esac
done
if [ "$HAS_DB" = false ]; then
  set -- "$@" --db "$DB"
fi
if [ "${1:-}" = job ] && [ "${2:-}" = run ] && [ "$FOREGROUND" = true ]; then
  if [ "$HAS_MANIFEST" = false ]; then
    set -- "$@" --manifest "$MANIFEST"
  fi
  if [ "$HAS_HELPER" = false ]; then
    set -- "$@" --helper "$HELPER"
  fi
fi
exec "$RUST" "$@"
