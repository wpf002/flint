#!/bin/bash
# Daily health probe. Run by launchd; also fine to run by hand.
#
# Exits non-zero when a participant cannot take a turn, and writes a dated line either
# way — a log that only records failures cannot distinguish "healthy" from "the check
# stopped running", which is the failure mode this whole thing exists to catch.
set -u
REPO="${FLINT_REPO:-$HOME/Documents/GitHub/flint}"
cd "$REPO" || exit 1

# launchd starts with a minimal PATH that has neither node nor pnpm.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

LOG="$HOME/.flint/logs/nexus-health.log"
STAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

OUT=$(pnpm --filter responder responder health 2>&1)
CODE=$?

printf '%s exit=%s\n%s\n' "$STAMP" "$CODE" "$OUT" >> "$LOG"

if [ "$CODE" -ne 0 ]; then
  # Surfaced where you will actually see it, not only in a file you would have to think
  # to open. The notification is best effort; the log is the record.
  BROKEN=$(printf '%s' "$OUT" | grep -c 'FAIL' || true)
  osascript -e "display notification \"$BROKEN participant(s) cannot take a turn\" with title \"Nexus health\" sound name \"Basso\"" >/dev/null 2>&1 || true
fi

exit "$CODE"
