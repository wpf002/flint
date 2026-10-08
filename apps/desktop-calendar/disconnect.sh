#!/bin/zsh
# Disconnects Flint from your Apple Calendar (Machine plan P2.6):
#
#   ~/flint/apps/desktop-calendar/disconnect.sh              disconnect
#   ~/flint/apps/desktop-calendar/disconnect.sh --uninstall  disconnect, and remove Flint Calendar.app too
#   ~/flint/apps/desktop-calendar/disconnect.sh --force      turn the source off even if Flint can't be told
#
# 1. Stops Flint Calendar's background agent first, so no read lands after the
#    disconnect, and checks that it stopped (if it didn't, nothing else
#    changes). Then removes its LaunchAgent, so a login can't start it again
#    even if this is interrupted.
# 2. Tells Flint: `flint-calendar --disconnect` reads no calendar and pushes one
#    snapshot that says "revoked", which archives every Apple event Flint has.
#    It keeps trying for a minute while the runtime is down or restarting. Then
#    this waits (up to 2 minutes) until `apple-calendar` says Disconnected.
# 3. Turns the source off: removes the FLINT_SOURCE_APPLE_CALENDAR lines (with
#    or without "export ") from ~/.flint/runtime.override.env (it stays 0600)
#    and restarts the runtime. If Flint wasn't told yet, or hasn't archived yet,
#    the source stays on until it has: run this again a few minutes later, or
#    with --force to turn it off anyway (Apple events then stay as last read).
# 4. With --uninstall, deletes /Applications/Flint Calendar.app (once Flint has
#    been told, since only the app can tell it).
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
# A line that sets the source, as the runtime's parser reads one (apps/runtime/src/config.ts, runtimeEnv).
SOURCE_LINE="^(export[[:space:]]+)?$KEY="
PLIST="$AGENTS/$LABEL.plist"
SHOWN_OVERRIDE="${OVERRIDE/#$HOME/~}"

say() { print -rl -- "$@"; }
stop() { print -rl -- "$@" >&2; exit 1; }
loaded() { launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; }

UNINSTALL=0
FORCE=0
case "${1:-}" in
  --uninstall) UNINSTALL=1 ;;
  --force) FORCE=1 ;;
  "") ;;
  *) stop "Run disconnect.sh alone, with --uninstall to remove Flint Calendar too, or with --force to turn the source off even if Flint can't be told." ;;
esac
trap 'rm -f "$OVERRIDE.new"' EXIT

# A settings file that can't be read could never have the source line taken out: stop before anything changes.
[ ! -e "$OVERRIDE" ] || [ -r "$OVERRIDE" ] || stop "Flint can't read $SHOWN_OVERRIDE, so nothing changed." \
  "Make it yours again with this command, then run this again:" \
  "  sudo chown $USER $SHOWN_OVERRIDE && chmod 600 $SHOWN_OVERRIDE"

# 1. The agent stops first, and is checked stopped; then its file goes, so no login brings it back.
if loaded; then
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  for i in {1..40}; do loaded || break; sleep 0.25; done
  if loaded; then
    stop "Flint Calendar's background part didn't stop, so nothing else changed. Run this again in a minute."
  fi
fi
rm -f "$PLIST"

# 2. Flint is told, and archives. --disconnect exits 0 told, 3 nothing to tell, 2 not told yet, 1 refused.
archived=1
pending=""
if [ -x "$DEST/Contents/MacOS/flint-calendar" ]; then
  set +e
  "$DEST/Contents/MacOS/flint-calendar" --disconnect
  told=$?
  set -e
  case "$told" in
    0)
      say "Waiting for Flint to archive your Apple events. This takes up to 2 minutes."
      archived=0
      pending=archiving
      for i in {1..24}; do
        line=$(cd "$REPO" && pnpm --silent --filter @flint/runtime apple-calendar 2>/dev/null | tail -n 1 || true)
        if [[ "$line" == Disconnected* ]]; then archived=1; break; fi
        sleep 5
      done
      ;;
    3) ;;
    1) say "Your Apple events stay in Flint as they were last read. You can forget any of them in Flint." ;;
    *)
      # 2: the runtime was down or restarting the whole minute; anything else (a crash, a signal) is no answer
      # either. The source stays on, so the next run can still tell Flint, unless Will asked to force it off.
      if [ "$FORCE" = 1 ]; then
        say "Flint couldn't be told, so your Apple events stay in Flint as they were last read. You can forget any of them in Flint."
      else
        archived=0
        pending=told
      fi
      ;;
  esac
else
  say "Flint Calendar isn't installed, so your Apple events stay in Flint as they were last read."
fi

# 3. The source off, unless Flint is still to be told or still archiving.
if [ "$archived" = 1 ] && [ -f "$OVERRIDE" ]; then
  rc=0
  grep -E "$SOURCE_LINE" "$OVERRIDE" >/dev/null 2>&1 || rc=$?
  [ "$rc" -le 1 ] || stop "Flint can't read $SHOWN_OVERRIDE, so the source is still on." \
    "Make it yours again with this command, then run this again:" \
    "  sudo chown $USER $SHOWN_OVERRIDE && chmod 600 $SHOWN_OVERRIDE"
  if [ "$rc" = 0 ]; then
    ( umask 077; : > "$OVERRIDE.new" )
    chmod 600 "$OVERRIDE.new"
    rc=0
    grep -vE "$SOURCE_LINE" "$OVERRIDE" >> "$OVERRIDE.new" 2>/dev/null || rc=$?
    [ "$rc" -le 1 ] || stop "Flint can't read $SHOWN_OVERRIDE, so the source is still on." \
      "Make it yours again with this command, then run this again:" \
      "  sudo chown $USER $SHOWN_OVERRIDE && chmod 600 $SHOWN_OVERRIDE"
    mv "$OVERRIDE.new" "$OVERRIDE"
    launchctl kickstart -k "gui/$UID/$RUNTIME_LABEL" >/dev/null 2>&1 || say "Flint's runtime couldn't be restarted, so the source turns off at its next restart."
  fi
  chmod 600 "$OVERRIDE"
fi

# 4. The app, when asked; kept while Flint is still to be told, since only it can tell Flint.
if [ "$UNINSTALL" = 1 ] && [ -e "$DEST" ]; then
  if [ "$pending" = told ]; then
    say "Flint Calendar was kept in Applications, so running this again can still tell Flint."
  else
    rm -rf "$DEST"
    say "Flint Calendar was removed from Applications."
  fi
fi

say ""
if [ "$archived" = 1 ]; then
  say "Flint Calendar is disconnected."
elif [ "$pending" = told ]; then
  say "Flint Calendar is stopped, but Flint couldn't be told yet, so the source stays on for now. Run this command again in a few minutes to finish." \
    "If Flint still can't be told, run it with --force to turn the source off anyway."
else
  say "Flint Calendar is stopped, but Flint is still archiving your Apple events, so the source stays on for now. Run this command again in a few minutes to finish."
fi
say "To remove its calendar permission too, run this command:" "  tccutil reset Calendar com.flint.calendar"
say "You can also turn Flint Calendar off in System Settings > Privacy & Security > Calendars."
