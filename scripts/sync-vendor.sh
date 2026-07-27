#!/usr/bin/env bash
# Sync the vendored stealth-core copy from a canonical upstream source.
#
# stealth-core is the anti-detection / fingerprint helper library bundled
# under src/vendor/stealth-core/. See docs/decisions/ADR-032 for why we
# vendor it instead of depending on a published package. Maintainers run
# this script when refreshing the vendored copy from a local upstream.
#
# Why this exists:
#   Manual `cp` works but invites typos, missed files, mtime confusion.
#   This script is idempotent + diff-friendly + reports what changed.
#
# Usage:
#   STEALTH_CORE_SRC=/path/to/stealth-core bash scripts/sync-vendor.sh
#
# Exits non-zero if the canonical source path is unreadable; otherwise
# always zero (a no-op when files already match).

set -euo pipefail

cd "$(dirname "$0")/.."

CANONICAL="${STEALTH_CORE_SRC:-}"
VENDOR_DIR="src/vendor/stealth-core"

if [ -z "$CANONICAL" ]; then
  echo "ERROR: set STEALTH_CORE_SRC=/path/to/stealth-core before running" >&2
  exit 1
fi

if [ ! -d "$CANONICAL/src" ]; then
  echo "ERROR: canonical stealth-core source not found at $CANONICAL/src" >&2
  echo "       set STEALTH_CORE_SRC=/path/to/stealth-core if it lives elsewhere" >&2
  exit 1
fi

if [ ! -d "$VENDOR_DIR" ]; then
  echo "Creating $VENDOR_DIR (first sync)"
  mkdir -p "$VENDOR_DIR"
fi

echo "Syncing $CANONICAL/src/*.ts → $VENDOR_DIR/"

# Track which files actually change so we can report them
CHANGED=0
ADDED=0
UNCHANGED=0

for SRC in "$CANONICAL/src"/*.ts; do
  NAME="$(basename "$SRC")"
  DST="$VENDOR_DIR/$NAME"

  if [ ! -f "$DST" ]; then
    cp "$SRC" "$DST"
    echo "  + $NAME (new)"
    ADDED=$((ADDED + 1))
    continue
  fi

  if ! cmp -s "$SRC" "$DST"; then
    cp "$SRC" "$DST"
    echo "  ~ $NAME (updated)"
    CHANGED=$((CHANGED + 1))
  else
    UNCHANGED=$((UNCHANGED + 1))
  fi
done

# Detect files in vendor that aren't in canonical (vendor has stale leftovers)
for DST in "$VENDOR_DIR"/*.ts; do
  [ -e "$DST" ] || continue
  NAME="$(basename "$DST")"
  SRC="$CANONICAL/src/$NAME"
  if [ ! -f "$SRC" ]; then
    echo "  ! $NAME (in vendor but NOT in canonical — consider removing)" >&2
  fi
done

echo ""
echo "Summary: $ADDED added / $CHANGED updated / $UNCHANGED unchanged"

if [ "$CHANGED" -gt 0 ] || [ "$ADDED" -gt 0 ]; then
  echo ""
  echo "Next steps:"
  echo "  1. npm run typecheck     # ensure vendor changes still compile"
  echo "  2. npm test              # ensure no behavioural regression"
  echo "  3. git diff $VENDOR_DIR  # review the diff"
  echo "  4. git add $VENDOR_DIR && git commit  # record the sync"
fi
