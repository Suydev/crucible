#!/usr/bin/env bash
# host-single.sh
# Serves one directory directly on its own derived port, in the background.
# Used by `host <dir>`.
#
# Usage: bash scripts/host-single.sh <dir> [port]

set -euo pipefail

DIR="${1:?usage: host-single.sh <dir> [port]}"
PORT="${2:-0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/server.mjs"

[ -d "$DIR" ] || { echo "not a directory: $DIR" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"

# Ask the dashboard which port this directory would get, so a folder always
# lands on the same port no matter how it is started.
if [ "$PORT" = "0" ] || [ -z "$PORT" ]; then
  PORT="$(node "$ROOT/scripts/port-for.mjs" "$DIR")"
fi

if [ -t 1 ]; then
  CYAN=$'\033[36m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  CYAN=""; GREEN=""; DIM=""; RESET=""
fi

LOG="/tmp/sim-host-$(basename "$DIR").log"
node "$ROOT/scripts/run-background.mjs" "$LOG" \
  node "$SERVER" --single --root "$DIR" --port "$PORT" >/dev/null

TRIES=60
while [ "$TRIES" -gt 0 ]; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3<&- 3>&-
    printf '%sok%s   %s serving %s\n' "$GREEN" "$RESET" "$CYAN" "http://localhost:$PORT/" "$RESET"
    printf '     %s\n' "$DIR"
    printf '     %slog: %s%s\n' "$DIM" "$LOG" "$RESET"
    exit 0
  fi
  sleep 0.1
  TRIES=$((TRIES - 1))
done

echo "failed to start; last lines of $LOG:" >&2
tail -n 20 "$LOG" >&2 || true
exit 1
