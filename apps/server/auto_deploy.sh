#!/bin/zsh
# Auto-deploy: the Mac Studio pulls the latest code from GitHub and rebuilds
# Flint whenever you push. Runs on a timer (com.flint.deploy). Your workflow:
# edit code anywhere -> git push -> within a couple minutes the Studio pulls it
# and Flint updates itself. No manual steps on the Studio.
set -e
REPO="${FLINT_REPO:-$HOME/flint}"   # the deploy-only checkout; never point this at a dev clone
cd "$REPO"

before=$(git rev-parse HEAD 2>/dev/null || echo none)
# A stalled connection used to hold the fetch ~3 minutes, past the next tick.
# Abort once the transfer drops below 1 KB/s for 20s; the next run retries.
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet origin main || { echo "$(date '+%F %T') fetch failed"; exit 0; }
git reset --hard --quiet origin/main   # match GitHub exactly (Studio is deploy-only, never edited directly)
after=$(git rev-parse HEAD)

if [ "$before" != "$after" ]; then
  echo "$(date '+%F %T') new code $before -> $after — redeploying Flint..."
  # A pulled commit can add or bump a dependency. install-server.sh now runs a
  # gate (typecheck + tests) that needs devDependencies present, so install
  # before building or the deploy fails on a missing package rather than on
  # anything actually wrong with the code.
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || \
    echo "$(date '+%F %T') WARNING: pnpm install failed; build may fail"
  # The gate is never skipped unattended: FLINT_SKIP_TESTS is for a person at the
  # keyboard, not for a timer that deploys whatever lands on main.
  unset FLINT_SKIP_TESTS
  # The server and the runtime deploy independently (Machine plan 3.0.6): either
  # can fail without stopping the other; a failed server deploy still fails
  # this run, after the runtime has had its turn.
  server_ok=1
  ./apps/server/install-server.sh || server_ok=0
  if [ "$server_ok" = 1 ]; then echo "$(date '+%F %T') deployed $after"; else echo "$(date '+%F %T') server deploy FAILED at $after"; fi
  # The runtime only when its code (or the rules it imports) changed, or when it
  # was never installed.
  if [ -x ./apps/runtime/install-runtime.sh ] && { [ ! -e "$HOME/.flint/runtime/current" ] || git diff --name-only "$before" "$after" 2>/dev/null | grep -qE '^(apps/runtime/|packages/policy/)'; }; then
    ./apps/runtime/install-runtime.sh && echo "$(date '+%F %T') runtime deployed $after" \
      || echo "$(date '+%F %T') runtime deploy FAILED at $after (the server is unaffected)"
  fi
  [ "$server_ok" = 1 ] || exit 1
else
  echo "$(date '+%F %T') up to date ($after)"
fi

# The native app is not part of the server deploy. Checked every tick, not only
# on new code: an update waiting for Flint.app to quit installs the tick after.
./apps/desktop-mac/update_app.sh || echo "$(date '+%F %T') app: update_app.sh failed"
