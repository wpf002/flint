#!/bin/zsh
# Disconnects Flint from your Apple Calendar (Machine plan P2.6):
#
#   ~/flint/apps/desktop-calendar/disconnect.sh              disconnect
#   ~/flint/apps/desktop-calendar/disconnect.sh --uninstall  disconnect, and remove Flint Calendar.app too
#
# 1. Stops Flint Calendar's background agent first, so no read lands after the
#    disconnect.
# 2. Tells Flint: `flint-calendar --disconnect` reads no calendar and pushes one
#    snapshot that says "revoked", which archives every Apple event Flint has.
#    Then it waits (up to 2 minutes) until `apple-calendar` says Disconnected.
# 3. Removes the LaunchAgent.
# 4. Turns the source off: removes the FLINT_SOURCE_APPLE_CALENDAR line from
#    ~/.flint/runtime.override.env (it stays 0600) and restarts the runtime.
#    If Flint hasn't archived yet, the source stays on until it has: run this
#    again a few minutes later.
# 5. With --uninstall, deletes /Applications/Flint Calendar.app.
# macOS keeps the calendar permission itself; the last lines say how to remove it.
set -eu
setopt pipefail
DIR="${0:A:h}"
REPO="${DIR:h:h}"
DEST="${FLINT_CALENDAR_DEST:-/Applications/Flint Calendar.app}"
DATA="${FLINT_DATA_DIR:-$HOME/.flint}"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.flint.calendar"
RUNTIME_LABEL="com.flint.runtime"
OVERRIDE="$DATA/runtime.override.env"
KEY="FLINT_SOURCE_APPLE_CALENDAR"
PLIST="$AGENTS/$LABEL.plist"

say() { print -rl -- "$@"; }
stop() { print -rl -- "$@" >&2; exit 1; }
loaded() { launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; }

UNINSTALL=0
case "${1:-}" in
  --uninstall) UNINSTALL=1 ;;
  "") ;;
  *) stop "Run disconnect.sh alone, or with --uninstall to remove Flint Calendar too." ;;
esac
trap 'rm -f "$OVERRIDE.new"' EXIT

# 1. The agent stops first.
if loaded; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  for i in {1..40}; do loaded || break; sleep 0.25; done
fi

# 2. Flint is told, and archives.
archived=1
if [ -x "$DEST/Contents/MacOS/flint-calendar" ]; then
  set +e
  "$DEST/Contents/MacOS/flint-calendar" --disconnect
  told=$?
  set -e
  if [ "$told" = 0 ]; then
    say "Waiting for Flint to archive your Apple events. This takes up to 2 minutes."
    archived=0
    for i in {1..24}; do
      line=$(cd "$REPO" && pnpm --silent --filter @flint/runtime apple-calendar 2>/dev/null | tail -n 1 || true)
      if [[ "$line" == Disconnected* ]]; then archived=1; break; fi
      sleep 5
    done
  elif [ "$told" != 3 ]; then
    say "Your Apple events stay in Flint as they were last read. You can forget any of them in Flint."
  fi
else
  say "Flint Calendar isn't installed, so your Apple events stay in Flint as they were last read."
fi

# 3. The agent's file goes.
rm -f "$PLIST"

# 4. The source off, unless Flint is still archiving.
if [ "$archived" = 1 ]; then
  if [ -f "$OVERRIDE" ] && grep -q "^$KEY=" "$OVERRIDE"; then
    ( umask 077; grep -v "^$KEY=" "$OVERRIDE" > "$OVERRIDE.new" || true )
    chmod 600 "$OVERRIDE.new"
    mv "$OVERRIDE.new" "$OVERRIDE"
    launchctl kickstart -k "gui/$UID/$RUNTIME_LABEL" >/dev/null 2>&1 || say "Flint's runtime couldn't be restarted, so the source turns off at its next restart."
  fi
  if [ -f "$OVERRIDE" ]; then chmod 600 "$OVERRIDE"; fi
fi

# 5. The app, when asked.
if [ "$UNINSTALL" = 1 ] && [ -e "$DEST" ]; then
  rm -rf "$DEST"
  say "Flint Calendar was removed from Applications."
fi

say ""
if [ "$archived" = 1 ]; then
  say "Flint Calendar is disconnected."
else
  say "Flint Calendar is stopped, but Flint is still archiving your Apple events, so the source stays on for now. Run this command again in a few minutes to finish."
fi
say "To remove its calendar permission too, run this command:" "  tccutil reset Calendar com.flint.calendar"
say "You can also turn Flint Calendar off in System Settings > Privacy & Security > Calendars."
