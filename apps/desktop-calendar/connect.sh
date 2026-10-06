#!/bin/zsh
# Connects Flint to your Apple Calendar (Machine plan P2.6). Will's one command:
#
#   ~/flint/apps/desktop-calendar/connect.sh
#
# 1. Checks that Flint Calendar is installed and signed with this Mac's Flint
#    Dev key (or macOS would not keep its calendar permission), and that the
#    runtime has made its push token.
# 2. Opens Flint Calendar and waits. macOS asks once for calendar access; you
#    tick the calendars that count and click Connect. It answers with one word,
#    which `open -o` writes to a temp file.
# 3. Turns the source on: FLINT_SOURCE_APPLE_CALENDAR=on, on a line of its own
#    in ~/.flint/runtime.override.env, once, and the file stays 0600.
# 4. Restarts the runtime when that line was new, and waits until a new runtime
#    answers /health.
# 5. Writes the LaunchAgent ~/Library/LaunchAgents/com.flint.calendar.plist
#    (0600) and loads it: Flint Calendar's own binary first, then --agent, no
#    environment and no secrets. macOS shows "Background Items Added".
# 6. Files the card that turns the source on (enable-source apple_calendar).
# 7. Says what to do next.
#
# Running it again is safe: it opens the chooser again, and what is already
# done stays done.
set -eu
setopt pipefail
DIR="${0:A:h}"
REPO="${DIR:h:h}"
DEST="${FLINT_CALENDAR_DEST:-/Applications/Flint Calendar.app}"
DATA="${FLINT_DATA_DIR:-$HOME/.flint}"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.flint.calendar"
RUNTIME_LABEL="com.flint.runtime"
PORT="${RUNTIME_PORT:-8090}"
IDENTITY="${FLINT_SIGN_IDENTITY:-Flint Dev}"
KEYCHAIN="${FLINT_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
OVERRIDE="$DATA/runtime.override.env"
KEY="FLINT_SOURCE_APPLE_CALENDAR"
PLIST="$AGENTS/$LABEL.plist"
SHOWN_REPO="${REPO/#$HOME/~}"

say() { print -rl -- "$@"; }
stop() { print -rl -- "$@" >&2; exit 1; }
runtime_pid() { launchctl print "gui/$UID/$RUNTIME_LABEL" 2>/dev/null | sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p' | head -n 1 || true; }
healthy() { curl -fsS -m 2 "http://[::1]:$PORT/health" 2>/dev/null | grep '"ok":true' >/dev/null; }
loaded() { launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; }

# 1. Installed, signed with this Mac's key, and a token to push with.
[ -d "$DEST" ] || stop "Flint Calendar isn't installed yet. It installs itself when the change that adds it is deployed. To install it now, run this command, then run connect.sh again:" "  $DIR/install_calendar.sh"
LEAF=$(security find-certificate -c "$IDENTITY" -Z "$KEYCHAIN" 2>/dev/null | sed -nE 's/^SHA-1 hash: ([0-9A-Fa-f]{40})$/\1/p' | head -n 1 | tr 'A-F' 'a-f' || true)
HAVE=$(codesign -d -r- "$DEST" 2>&1 | grep '^designated => ' || true)
if ! codesign --verify --strict "$DEST" >/dev/null 2>&1 || [ -z "$LEAF" ] || [ "$HAVE" != "designated => identifier \"$LABEL\" and certificate leaf = H\"$LEAF\"" ]; then
  stop "Flint Calendar isn't signed with this Mac's Flint Dev key, so macOS wouldn't keep its calendar permission. Run this command, then run connect.sh again:" "  $DIR/install_calendar.sh"
fi
grep -qE '^[0-9a-f]{64}$' "$DATA/tokens/apple-calendar.token" 2>/dev/null \
  || stop "The runtime hasn't made Flint Calendar's push token yet. It makes it when the runtime with Apple Calendar is deployed, so check that deploy, then run this again."

# 2. The chooser. The answer comes back on Flint Calendar's stdout.
RESULT="$(mktemp)"
trap 'rm -f "$RESULT" "$OVERRIDE.new" "$PLIST.new"' EXIT
say "Opening Flint Calendar. If macOS asks, click Allow Full Access. Then tick your calendars and click Connect."
open -n -W -o "$RESULT" "$DEST" || stop "Flint Calendar didn't open, so nothing changed. Run this again."
answer=$(head -n 1 "$RESULT" 2>/dev/null | tr -d '[:space:]' || true)
case "$answer" in
  connected) ;;
  cancelled) stop "Flint Calendar wasn't connected, so nothing changed. Run this again when you're ready." ;;
  denied) stop "Calendar access is off for Flint Calendar, so nothing changed. Turn it on in System Settings > Privacy & Security > Calendars, then run this again." ;;
  restricted) stop "This Mac's settings don't let Flint Calendar read calendars, so nothing changed." ;;
  *)
    # No answer came back through open: ask instead.
    if [ -t 0 ]; then
      print -n -- 'Did Flint Calendar say "Apple Calendar Is Connected"? Type y and press Return: '
      read -r yn || yn=""
      [[ "$yn" == [yY]* ]] || stop "Nothing changed. Run this again when you're ready."
    else
      stop "Flint Calendar gave no answer, so nothing changed. Run this again."
    fi
    ;;
esac

# 3. The source on, on a line of its own, once; the file stays its owner's alone (the runtime refuses it otherwise).
mkdir -p "$DATA"
chmod 700 "$DATA"
if [ -f "$OVERRIDE" ] && [ "$(grep -c "^$KEY=" "$OVERRIDE" || true)" = 1 ] && grep -qx "$KEY=on" "$OVERRIDE"; then
  changed=0
else
  ( umask 077
    { if [ -f "$OVERRIDE" ]; then grep -v "^$KEY=" "$OVERRIDE" || true; fi; print -r -- "$KEY=on"; } > "$OVERRIDE.new" )
  chmod 600 "$OVERRIDE.new"
  mv "$OVERRIDE.new" "$OVERRIDE"
  changed=1
fi
chmod 600 "$OVERRIDE"

# 4. A runtime that reads it: restarted when the line is new, and up (a new process, answering /health).
before=""
if [ "$changed" = 1 ]; then
  say "Restarting Flint's runtime so it takes Flint Calendar's snapshots."
  before=$(runtime_pid)
  launchctl kickstart -k "gui/$UID/$RUNTIME_LABEL" >/dev/null 2>&1 || stop "Flint's runtime couldn't be restarted. Check ~/.flint/runtime.err.log, then run this again."
fi
up=0
for i in {1..60}; do
  pid=$(runtime_pid)
  if { [ -z "$before" ] || { [ -n "$pid" ] && [ "$pid" != "$before" ]; }; } && healthy; then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || stop "Flint's runtime didn't come back within a minute. Check ~/.flint/runtime.err.log, then run this again."

# 5. The agent: Flint Calendar's own binary first, so macOS charges the permission to Flint Calendar itself.
mkdir -p "$AGENTS"
( umask 077; : >> "$DATA/calendar.log" )
chmod 600 "$DATA/calendar.log"
( umask 077
  cat > "$PLIST.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DEST/Contents/MacOS/flint-calendar</string><string>--agent</string></array>
  <key>AssociatedBundleIdentifiers</key><array><string>$LABEL</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>$DATA/calendar.log</string>
  <key>Umask</key><integer>63</integer>
</dict></plist>
PLIST
)
chmod 600 "$PLIST.new"
plutil -lint -s "$PLIST.new" >/dev/null || stop "The LaunchAgent came out malformed, so nothing was loaded. Run this again."
if loaded && cmp -s "$PLIST.new" "$PLIST"; then
  rm -f "$PLIST.new"
  # Read the new choice of calendars now, not in 5 minutes.
  launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true
else
  if loaded; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    for i in {1..40}; do loaded || break; sleep 0.25; done
  fi
  mv "$PLIST.new" "$PLIST"
  ok=0
  for i in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || stop "Flint Calendar's background part couldn't be started. Run this again, and if it fails twice, send Claude ~/.flint/calendar.log."
fi

# 6. The card that turns the source on, for Will to sign.
say "Filing the card that turns the source on."
( cd "$REPO" && pnpm --silent --filter @flint/runtime enable-source apple_calendar ) \
  || stop "The card couldn't be filed. Run this command to try again:" "  cd $SHOWN_REPO && pnpm --filter @flint/runtime enable-source apple_calendar"

# 7. What next.
say ""
say "Flint Calendar is connected."
say "Next, open Flint, click the shield button at the top, and approve \"Turn On the Apple Calendar Source\" with Touch ID or your Mac password."
say "About 5 minutes after that, check it with this command:" "  cd $SHOWN_REPO && pnpm --filter @flint/runtime apple-calendar"
