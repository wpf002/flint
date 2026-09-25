#!/bin/zsh
# Keeps /Applications/Flint.app built from the checked-out apps/desktop-mac.
# auto_deploy.sh calls this on every tick, after it has reset the checkout.
#
# It rebuilds only when this directory's content changes (its git tree hash),
# and never replaces the app while it is open: it posts one notification and
# installs on the first tick after Flint.app quits. A tree that fails to build
# is skipped until the directory changes again.
set -u
DIR="${0:A:h}"
DEST="${FLINT_APP_DEST:-/Applications/Flint.app}"
STATE="${FLINT_STATE_DIR:-$HOME/.flint}"
STAMP="$STATE/app-installed-tree"
FAILED="$STATE/app-failed-tree"
NOTIFIED="$STATE/app-notified-tree"

log() { echo "$(date '+%F %T') app: $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Flint\"" >/dev/null 2>&1 || true; }
running() { pgrep -qf "^$DEST/Contents/MacOS/flint( |$)"; }

tree=$(git -C "$DIR" rev-parse HEAD:apps/desktop-mac 2>/dev/null) || exit 0
[ "$tree" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
[ "$tree" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0
commit=$(git -C "$DIR" log -1 --format='%h %s' -- .)

if running; then
  if [ "$tree" != "$(cat "$NOTIFIED" 2>/dev/null)" ]; then
    notify "A Flint.app update is ready. Quit Flint to install it."
    echo "$tree" > "$NOTIFIED"
    log "update ready ($commit); waiting for Flint.app to quit"
  fi
  exit 0
fi

"$DIR/install_app.sh" --if-closed >/dev/null 2>&1
case $? in
  0) echo "$tree" > "$STAMP"; rm -f "$FAILED"
     log "installed ($commit)"; notify "Flint.app updated: ${commit#* }" ;;
  3) log "Flint.app opened during the build; will install after it quits" ;;
  *) echo "$tree" > "$FAILED"
     log "build failed ($commit); run apps/desktop-mac/install_app.sh to see why"
     notify "Flint.app update failed to build. Kept the current app." ;;
esac
exit 0
