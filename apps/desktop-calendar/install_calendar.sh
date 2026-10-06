#!/bin/zsh
# Builds Flint Calendar.app, the helper that reads Apple Calendar for Flint
# (Machine plan P2.6), and installs it to /Applications. update_calendar.sh
# runs it after a deploy; Will can run it by hand.
#
#   ./apps/desktop-calendar/install_calendar.sh                     build, check, sign and install
#   ./apps/desktop-calendar/install_calendar.sh --scan-source DIR   only the source scan (the tests use it)
#   ./apps/desktop-calendar/install_calendar.sh --scan-binary FILE  only the binary scan (the tests use it)
#
# It never opens the app and never loads its LaunchAgent: connect.sh does that,
# when Will runs it. Every step below is fatal, and a failure keeps the app
# that is installed:
#  1. the stable 'Flint Dev' identity must exist. Never ad-hoc: macOS keys the
#     calendar permission to the signature, and would forget it on every update;
#  2. the source scan: no EventKit call that writes, and no way to make one at
#     run time (macOS only grants full access, so read-only is this rule);
#  3. Info.plist key by key, and the entitlements exactly;
#  4. the headless core tests, against the runtime's golden fixture;
#  5. the build, in a temp dir, then the scan of the binary's selectors and strings;
#  6. signing with the hardened runtime and the entitlements; then the signed
#     entitlements, the runtime flag and the designated requirement (identifier
#     com.flint.calendar and the Flint Dev certificate), which must be the
#     installed app's too, or macOS would ask Will for access again;
#  7. the copy beside the old app, moved into place;
#  8. a restart of the agent, only when Will turned it on (it is loaded).
set -eu
setopt pipefail
DIR="${0:A:h}"
REPO="${DIR:h:h}"
DEST="${FLINT_CALENDAR_DEST:-/Applications/Flint Calendar.app}"
IDENTITY="${FLINT_SIGN_IDENTITY:-Flint Dev}"
KEYCHAIN="${FLINT_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
LABEL="com.flint.calendar"
FIXTURE="$REPO/apps/runtime/test/fixtures/apple-calendar-snapshot.json"

# EventKit calls that write, and the ways to reach one indirectly, in the Swift sources.
SOURCE_FORBIDDEN='(^|[^A-Za-z0-9_])(save|remove|commit|reset)\(|span:|(save|remove)(Event|Calendar|Reminder|Source)|requestWriteOnlyAccessToEvents|requestFullAccessToReminders|requestAccess\(to:|EK(Event|Calendar|Reminder|Source)\((eventStore|for)|EKSpan|NSSelectorFromString|NSClassFromString|Selector\("|performSelector|\.perform\(|objc_msgSend|dlsym|dlopen|setValue\([^)]*forKey(Path)?:|value\(forKey(Path)?:'
# The same, as selectors in the built binary (a Swift call to EventKit is an Objective-C message, so its
# selector is in the binary): matched against whole selector names and whole strings.
BINARY_FORBIDDEN='(save|remove)(Event|Calendar|Reminder|Source)[A-Za-z]*:.*|commit:?|reset|requestWriteOnlyAccessToEvents.*|requestFullAccessToReminders.*|requestAccessToEntityType:.*|(event|reminder|calendar)WithEventStore:|calendarForEntityType:eventStore:'
# The entitlements, exactly (plutil -p sorts the keys): the sandbox, calendars, outgoing connections, and one
# file outside the sandbox, read-only. Nothing else: no file writes, no get-task-allow, no library loading.
EXPECTED_ENTITLEMENTS='{
  "com.apple.security.app-sandbox" => true
  "com.apple.security.network.client" => true
  "com.apple.security.personal-information.calendars" => true
  "com.apple.security.temporary-exception.files.home-relative-path.read-only" => [
    0 => "/.flint/tokens/apple-calendar.token"
  ]
}'

die() { echo "error: $*" >&2; exit 1; }

scan_source() { # <dir>: the lines that call a write, if any
  local hits
  hits=$(grep -nE "$SOURCE_FORBIDDEN" "$1"/*.swift 2>/dev/null || true)
  [ -z "$hits" ] || { print -r -- "$hits" >&2; return 1; }
}
selectors() { otool -v -s __TEXT __objc_methname "$1" 2>/dev/null | sed -n '3,$p' | sed -E 's/^[0-9a-fA-F]+[[:space:]]+//'; }
scan_binary() { # <file>: the selectors and strings that write, if any
  local n hits
  n=$(selectors "$1" | wc -l | tr -d ' ')
  # An app with no selector table to read is not one this scan has checked.
  [ "$n" -ge 1 ] ||{ echo "could not read the selectors of $1" >&2; return 1; }
  hits=$({ selectors "$1"; strings -a "$1"; } | grep -xE "$BINARY_FORBIDDEN" | sort -u || true)
  [ -z "$hits" ] || { print -r -- "$hits" >&2; return 1; }
}
plist_is() { [ "$(plutil -extract "$2" raw -o - "$1" 2>/dev/null)" = "$3" ] || die "Info.plist: $2 must be $3"; }
check_plist() { # <Info.plist>
  plutil -lint -s "$1" >/dev/null || die "Info.plist is not a valid property list"
  plist_is "$1" CFBundleIdentifier com.flint.calendar
  plist_is "$1" CFBundleExecutable flint-calendar
  plist_is "$1" CFBundlePackageType APPL
  plist_is "$1" LSUIElement true
  plist_is "$1" LSMinimumSystemVersion 14.0
  plist_is "$1" NSAppTransportSecurity.NSAllowsLocalNetworking true
  [ -n "$(plutil -extract NSCalendarsFullAccessUsageDescription raw -o - "$1" 2>/dev/null)" ] || die "Info.plist: NSCalendarsFullAccessUsageDescription is missing"
  # Events, read, and nothing more: no write-only or reminders key, and no way in (URL scheme, AppleScript, services).
  local k
  for k in NSCalendarsWriteOnlyAccessUsageDescription NSCalendarsUsageDescription NSRemindersUsageDescription NSRemindersFullAccessUsageDescription \
           NSContactsUsageDescription CFBundleURLTypes NSAppleScriptEnabled OSAScriptingDefinition NSServices NSAppleEventsUsageDescription; do
    if plutil -extract "$k" xml1 -o - "$1" >/dev/null 2>&1; then die "Info.plist must not have $k"; fi
  done
}
check_entitlements() { # <plist file> <what>
  [ "$(plutil -p "$1" 2>/dev/null)" = "$EXPECTED_ENTITLEMENTS" ] || die "$2: the entitlements must be exactly the four Flint Calendar needs"
}
# The designated requirement as codesign prints it.
requirement() { codesign -d -r- "$1" 2>&1 | grep '^designated => ' || true; }

case "${1:-}" in
  --scan-source) scan_source "${2:?a directory}"; exit ;;
  --scan-binary) scan_binary "${2:?a file}"; exit ;;
  "") ;;
  *) die "usage: install_calendar.sh [--scan-source DIR | --scan-binary FILE]" ;;
esac

# 1. The identity, and its certificate's SHA-1, which the requirement pins.
LEAF=$(security find-certificate -c "$IDENTITY" -Z "$KEYCHAIN" 2>/dev/null | sed -nE 's/^SHA-1 hash: ([0-9A-Fa-f]{40})$/\1/p' | head -n 1 | tr 'A-F' 'a-f' || true)
[ -n "$LEAF" ] || die "there is no '$IDENTITY' signing identity in the login keychain. Flint Calendar is never signed ad-hoc, because macOS would forget its calendar permission on every update. Run apps/desktop-mac/install_app.sh once (it makes the identity), then run this again."
WANT="designated => identifier \"$LABEL\" and certificate leaf = H\"$LEAF\""

# 2-3. Before anything is built.
scan_source "$DIR" || die "a Swift source calls an EventKit write (above); Flint Calendar only reads"
check_plist "$DIR/Info.plist"
check_entitlements "$DIR/FlintCalendar.entitlements" "FlintCalendar.entitlements"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 4. The core, headless: a plain program with no EventKit, no window and no bundle.
swiftc -O -parse-as-library -o "$WORK/core-tests" "$DIR/CalendarCore.swift" "$DIR/CalendarCoreTests.swift" || die "the core tests did not compile"
"$WORK/core-tests" --fixture "$FIXTURE" || die "the core tests failed"

# 5. The app, then its binary scan.
APP="$WORK/Flint Calendar.app"
BIN="$APP/Contents/MacOS/flint-calendar"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -parse-as-library -o "$BIN" "$DIR/CalendarCore.swift" "$DIR/FlintCalendar.swift" -framework AppKit -framework EventKit -framework CryptoKit || die "Flint Calendar did not compile"
scan_binary "$BIN" || die "the built binary holds an EventKit write (above); Flint Calendar only reads"
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
if [ -f "$REPO/apps/desktop-mac/flint.icns" ]; then cp "$REPO/apps/desktop-mac/flint.icns" "$APP/Contents/Resources/flint.icns"; fi

# 6. Signed, and checked as signed.
codesign --force --options runtime --timestamp=none --entitlements "$DIR/FlintCalendar.entitlements" --sign "$IDENTITY" "$APP" >/dev/null 2>&1 \
  || die "codesign with '$IDENTITY' failed"
codesign --verify --strict --deep "$APP" || die "the signature does not verify"
# (grep reads it all: under pipefail, grep -q stopping early would fail the pipe.)
codesign -d -v "$APP" 2>&1 | grep -E '^CodeDirectory .*flags=0x[0-9a-f]*\(runtime\)' >/dev/null || die "the hardened runtime is not on"
codesign -d --entitlements - --xml "$APP" > "$WORK/signed.plist" 2>/dev/null || die "could not read the signed entitlements"
check_entitlements "$WORK/signed.plist" "the signed app"
[ "$(requirement "$APP")" = "$WANT" ] || die "the build's designated requirement is not $WANT"
if [ -e "$DEST" ] && [ "$(requirement "$DEST")" != "$WANT" ] && [ "${FLINT_CALENDAR_REPIN:-}" != 1 ]; then
  die "the installed Flint Calendar is signed differently, so macOS would ask for calendar access again. Kept the installed app. To replace it anyway, run this with FLINT_CALENDAR_REPIN=1, then run connect.sh again."
fi

# 7. Copy beside the old app first, so a failed copy never leaves no app at all.
rm -rf "$DEST.new"
ditto "$APP" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

# 8. The agent runs the new build only if Will turned it on; it is never loaded from here.
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || echo "warning: could not restart $LABEL; it runs the new build after its next restart" >&2
fi
echo "installed $DEST"
