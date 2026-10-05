#!/bin/zsh
# Auto-deploy: the Mac Studio pulls the latest code from GitHub and rebuilds
# Flint whenever you push. Runs on a timer (com.flint.deploy). Your workflow:
# edit code anywhere -> git push -> within a couple minutes the Studio pulls it
# and Flint updates itself. No manual steps on the Studio.
set -e
REPO="${FLINT_REPO:-$HOME/flint}"   # the deploy-only checkout; never point this at a dev clone
cd "$REPO"

STATE="${FLINT_STATE_DIR:-$HOME/.flint}"
# A deploy that failed (a gate that hit something transient, a database that was
# busy) is retried every 30 minutes, up to 6 times, without waiting for the next
# push: "<sha> <parts> <tries>", parts the comma-joined server,runtime that failed.
RETRY="$STATE/deploy-retry"
RETRY_EVERY_MIN=30
RETRY_MAX=6
ts() { date '+%F %T'; }

before=$(git rev-parse HEAD 2>/dev/null || echo none)
# A stalled connection used to hold the fetch ~3 minutes, past the next tick.
# Abort once the transfer drops below 1 KB/s for 20s; the next run retries.
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet origin main || { echo "$(ts) fetch failed"; exit 0; }
git reset --hard --quiet origin/main   # match GitHub exactly (Studio is deploy-only, never edited directly)
after=$(git rev-parse HEAD)

# Deploys the given parts of $1 and leaves the ones that failed in $failed.
# The log lines are the ones the runtime's git source reads (sources/git.ts).
deploy() {
  local sha=$1 parts=$2
  failed=""
  # A pulled commit can add or bump a dependency. install-server.sh now runs a
  # gate (typecheck + tests) that needs devDependencies present, so install
  # before building or the deploy fails on a missing package rather than on
  # anything actually wrong with the code.
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || \
    echo "$(ts) WARNING: pnpm install failed; build may fail"
  # The gate is never skipped unattended: FLINT_SKIP_TESTS is for a person at the
  # keyboard, not for a timer that deploys whatever lands on main.
  unset FLINT_SKIP_TESTS
  # The server and the runtime deploy independently (Machine plan 3.0.6): either
  # can fail without stopping the other.
  if [[ ",$parts," == *,server,* ]]; then
    if ./apps/server/install-server.sh; then echo "$(ts) deployed $sha"
    else echo "$(ts) server deploy FAILED at $sha"; failed=server; fi
  fi
  if [[ ",$parts," == *,runtime,* ]]; then
    if ./apps/runtime/install-runtime.sh; then echo "$(ts) runtime deployed $sha"
    else echo "$(ts) runtime deploy FAILED at $sha (the server is unaffected)"; failed="${failed:+$failed,}runtime"; fi
  fi
}
# Remembers what failed (and how often), or forgets: its time is the last attempt's.
remember() {
  if [ -n "$failed" ]; then mkdir -p "$STATE"; echo "$1 $failed $2" > "$RETRY"; else rm -f "$RETRY"; fi
}

failed=""
if [ "$before" != "$after" ]; then
  echo "$(ts) new code $before -> $after — redeploying Flint..."
  # The runtime only when its code (or the rules it imports) changed, or when it
  # was never installed.
  parts=server
  if [ -x ./apps/runtime/install-runtime.sh ] && { [ ! -e "$HOME/.flint/runtime/current" ] || git diff --name-only "$before" "$after" 2>/dev/null | grep -qE '^(apps/runtime/|packages/policy/)'; }; then
    parts=server,runtime
  fi
  deploy "$after" "$parts"
  remember "$after" 0
elif [ -s "$RETRY" ] && read -r rsha rparts rtries < "$RETRY" && [ "$rsha" = "$after" ]; then
  if [ "$rtries" -ge "$RETRY_MAX" ] 2>/dev/null; then
    # Out of retries: the next push deploys again. The server's state stays truthful.
    if [[ ",$rparts," == *,server,* ]]; then echo "$(ts) server deploy FAILED at $after (no retries left)"; else echo "$(ts) up to date ($after)"; fi
  elif [ -n "$(find "$RETRY" -mmin +$((RETRY_EVERY_MIN - 1)) 2>/dev/null)" ]; then
    echo "$(ts) retrying the failed deploy of $after ($rparts), attempt $((rtries + 1)) of $RETRY_MAX"
    deploy "$after" "$rparts"
    remember "$after" $((rtries + 1))
  else
    if [[ ",$rparts," == *,server,* ]]; then echo "$(ts) server deploy FAILED at $after (retrying)"; else echo "$(ts) up to date ($after)"; fi
  fi
else
  echo "$(ts) up to date ($after)"
fi
# A failed server deploy fails this run.
[[ ",$failed," == *,server,* ]] && exit 1

# The native app is not part of the server deploy. Checked every tick, not only
# on new code; it does nothing unless apps/desktop-mac changed since it last built.
./apps/desktop-mac/update_app.sh || echo "$(date '+%F %T') app: update_app.sh failed"
