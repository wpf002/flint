#!/bin/bash
# The continuous loop, run under a supervisor.
#
# Exits cleanly on SIGTERM so the supervisor can stop it without a kill, and its own
# caps do the bounding: the daily ledger is on disk, so a restart does not hand it a
# fresh budget.
set -u
REPO="${FLINT_REPO:-$HOME/Documents/GitHub/flint}"
cd "$REPO" || exit 1

# launchd starts with a minimal PATH that has neither node nor pnpm.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

exec pnpm --filter responder responder run
