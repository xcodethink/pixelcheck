#!/usr/bin/env bash
# Fail if internal source files reintroduce console.{log,error,warn,info,debug}.
#
# Allowed exceptions:
#   - src/cli.ts           — CLI is the user-facing rendering layer (chalk + console.log are intentional UX)
#   - src/commands/*.ts    — interactive subcommands (doctor / init wizard) are user-facing UX, same role as cli.ts
#   - string literals containing "console.log" (e.g. filenames in artifacts dirs)
#   - comments mentioning console.* (no actual call)
#
# All other source files must use the structured logger from src/core/logger.ts.

set -euo pipefail

cd "$(dirname "$0")/.."

# Match `console.log(`, `console.error(`, etc. — the open paren is what makes it
# a call rather than a string or comment.
PATTERN='console\.(log|error|warn|info|debug)\('

OFFENDERS=$(
  grep -rEn "$PATTERN" src \
    --include='*.ts' \
    --exclude-dir=node_modules \
    | grep -v '^src/cli.ts:' \
    | grep -v '^src/commands/' \
    || true
)

if [ -n "$OFFENDERS" ]; then
  echo "ERROR: console.* calls found outside src/cli.ts and src/commands/." >&2
  echo "       Use getLogger() from src/core/logger.ts instead." >&2
  echo "" >&2
  echo "$OFFENDERS" >&2
  exit 1
fi

echo "no-console check: ok"
