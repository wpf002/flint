#!/bin/zsh
# Keeps /Applications/Flint Calendar.app built from the checked-out
# apps/desktop-calendar. auto_deploy.sh calls this on every tick, once the
# runtime it pushes to is live with this commit's code (so a new wire format
# reaches the runtime first).
#
# It rebuilds only when this directory's content changes (its git tree hash).
# install_calendar.sh builds, tests, scans, signs and installs; it never opens
# the app and never loads its agent, and restarts the agent only if Will turned
# it on. A tree that fails is skipped until the directory changes again, and
# the installed app is kept. The last install's output is in
# ~/.flint/calendar-install.log.
set -u
DIR="${0:A:h}"
STATE="${FLINT_STATE_DIR:-$HOME/.flint}"
STAMP="$STATE/calendar-installed-tree"
FAILED="$STATE/calendar-failed-tree"
LOG="$STATE/calendar-install.log"

log() { echo "$(date '+%F %T') calendar: $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Flint\"" >/dev/null 2>&1 || true; }

tree=$(git -C "$DIR" rev-parse HEAD:apps/desktop-calendar 2>/dev/null) || exit 0
[ "$tree" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0
[ "$tree" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0
commit=$(git -C "$DIR" log -1 --format='%h %s' -- .)
mkdir -p "$STATE"

( umask 077; : > "$LOG" )
chmod 600 "$LOG"
if "$DIR/install_calendar.sh" >> "$LOG" 2>&1; then
  echo "$tree" > "$STAMP"; rm -f "$FAILED"
  log "installed ($commit)"
else
  echo "$tree" > "$FAILED"
  log "build failed ($commit); see $LOG"
  notify "Flint Calendar's update failed to build, so the installed app was kept."
fi
exit 0
