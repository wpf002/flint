#!/bin/zsh
# Keeps /Applications/Flint.app built from the checked-out apps/desktop-mac.
# auto_deploy.sh calls this on every tick, after it has reset the checkout.
#
# It rebuilds only when this directory's content changes (its git tree hash),
# and installs at once, even while Flint.app is open: the running app sees the
# new build on disk and restarts itself onto it when Will is not using it
# (flint.swift, checkForNewBuild). A tree that fails to build is skipped until
# the directory changes again, and the current app is kept.
set -u
DIR="${0:A:h}"
DEST="${FLINT_APP_DEST:-/Applications/Flint.app}"
STATE="${FLINT_STATE_DIR:-$HOME/.flint}"
STAMP="$STATE/app-installed-tree"
FAILED="$STATE/app-failed-tree"

log() { echo "$(date '+%F %T') app: $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Flint\"" >/dev/null 2>&1 || true; }
running() { pgrep -qf "^$DEST/Contents/MacOS/flint( |$)"; }

tree=$(git -C "$DIR" rev-parse HEAD:apps/desktop-mac 2>/dev/null) || exit 0
[ "$tree" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
[ "$tree" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0
commit=$(git -C "$DIR" log -1 --format='%h %s' -- .)

if "$DIR/install_app.sh" >/dev/null 2>&1; then
  echo "$tree" > "$STAMP"; rm -f "$FAILED" "$STATE/app-notified-tree"
  if running; then
    log "installed ($commit); the open app restarts onto it when idle"
  else
    log "installed ($commit)"
  fi
  notify "Flint updated: ${commit#* }"
else
  echo "$tree" > "$FAILED"
  log "build failed ($commit); run apps/desktop-mac/install_app.sh to see why"
  notify "Flint update failed to build. Kept the current app."
fi
exit 0
