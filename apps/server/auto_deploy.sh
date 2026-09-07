#!/bin/zsh
# Auto-deploy: the Mac Studio pulls the latest code from GitHub and rebuilds
# Flint whenever you push. Runs on a timer (com.flint.deploy). Your workflow:
# edit code anywhere -> git push -> within a couple minutes the Studio pulls it
# and Flint updates itself. No manual steps on the Studio.
set -e
REPO="${FLINT_REPO:-$HOME/Documents/GitHub/flint}"
cd "$REPO"

before=$(git rev-parse HEAD 2>/dev/null || echo none)
git fetch --quiet origin main || { echo "$(date '+%F %T') fetch failed"; exit 0; }
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
  ./apps/server/install-server.sh
  echo "$(date '+%F %T') deployed $after"
else
  echo "$(date '+%F %T') up to date ($after)"
fi
