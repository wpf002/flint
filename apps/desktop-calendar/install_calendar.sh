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
#  2. the source scan (macOS only grants full access, so read-only is these
#     rules; SOURCE_FORBIDDEN is the exact list). A Swift source may not name an
#     EventKit method that writes (save, remove, commit, reset, a span, a
#     write-only or reminders request, a new event or calendar), nor use what
#     could reach one without naming it: a selector, class or function made from
#     data (Selector, NSSelectorFromString, the sel_, class_, method_, objc_ and
#     dlsym families), a method looked up or cast (method(for:), unsafeBitCast,
#     @convention(c), @_silgen_name, AnyObject lookup, Unmanaged), a method
#     called by name (perform, sendAction, KVC, predicates, expressions, sort
#     descriptors, bindings), or another program (Process, posix_spawn, system);
#  3. Info.plist key by key, and the entitlements exactly;
#  4. the headless core tests, against the runtime's golden fixture;
#  5. the build, in a temp dir, then the binary scan: no write selector, no
#     selector that finds or calls a method by name (KVC, predicates, bindings,
#     methodForSelector:) and none that starts with "_" (Apple's private
#     methods), and no import of a function or class that makes a selector,
#     class or function from data or starts another program (IMPORT_FORBIDDEN).
#     Its strings are checked for write selectors too, but Swift keeps a string
#     of 15 bytes or fewer inside the code, where no scan of strings sees it: a
#     selector made from strings is stopped by its imports, not by its name;
#  6. signing with the hardened runtime and the entitlements; then the signed
#     entitlements, the runtime flag and the designated requirement (identifier
#     com.flint.calendar and the Flint Dev certificate), which the signature must
#     satisfy and which must be the installed app's too, or macOS would ask Will
#     for access again;
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

# In the Swift sources, line by line: EventKit's writes by name; then the ways to reach a method without naming it
# (a selector, class or function made from data; a method looked up, cast or called by name; another program).
SOURCE_FORBIDDEN='(^|[^A-Za-z0-9_])(save|remove|commit|reset)\(|span:|(save|remove)(Event|Calendar|Reminder|Source)|requestWriteOnlyAccessToEvents|requestFullAccessToReminders|requestAccess\(to:|EK(Event|Calendar|Reminder|Source)\((eventStore|for)|EKSpan'\
'|(^|[^A-Za-z0-9_])(Selector|AnyObject|AnyClass|Unmanaged|Process)([^A-Za-z0-9_]|$)|NS(Selector|Class|Protocol)FromString|(^|[^A-Za-z0-9_])(sel|class|method|imp|protocol|objc|object|dyld)_[A-Za-z]|dlsym|dlopen'\
'|(instanceM|m)ethod\(for:|methodSignature|unsafeBitCast|unsafeDowncast|withMemoryRebound|assumingMemoryBound|bindMemory|@convention\(c\)|@_silgen_name|@objc[[:space:]]+(protocol|optional)'\
'|(^|[^A-Za-z0-9_])perform(Selector)?\(|performSelector|makeObjectsPerform|sendAction|tryToPerform|value\(forKey|setValue\([^)]*forKey|setValuesForKeys|dictionaryWithValues|mutable(Array|Set|OrderedSet)Value|\.bind\(|classNamed'\
'|NS(Predicate|CompoundPredicate|ComparisonPredicate|Expression|SortDescriptor|Invocation|MethodSignature|XPCConnection|AppleScript|Task|User[A-Za-z]*Task)([^A-Za-z0-9_]|$)|posix_spawn|(^|[^A-Za-z0-9_])(system|popen|fork|vfork|execv[ep]?|execl[ep]?)\('
# In the built binary (a Swift call to an Objective-C method is a message, so its selector is in the binary), as
# whole selector names and whole strings: EventKit's writes.
WRITE_SELECTORS='(save|remove)(Event|Calendar|Reminder|Source)[A-Za-z]*:.*|commit:?|reset|requestWriteOnlyAccessToEvents.*|requestFullAccessToReminders.*|requestAccessToEntityType:.*|(event|reminder|calendar)WithEventStore:|calendarForEntityType:eventStore:'
# As whole selector names only: the selectors that find or call a method by its name, and Apple's private ones.
BYNAME_SELECTORS='(instanceM|m)ethodForSelector:|(instanceM|m)ethodSignatureForSelector:|valueForKey(Path)?:|setValue:forKey(Path)?:|dictionaryWithValuesForKeys:|setValuesForKeysWithDictionary:|mutable(Array|Set|OrderedSet)ValueForKey(Path)?:|bind:toObject:withKeyPath:options:|(predicate|expression)WithFormat:.*|expressionForFunction:.*|evaluateWithObject:.*|sortDescriptorWithKey:.*|classNamed:|_.*'
# What the binary imports (nm -u): a selector, class or function made from data, a method swapped or looked up, a
# library loaded, KVC's predicates, expressions, sort descriptors and bindings controllers, or another program.
IMPORT_FORBIDDEN='^_(sel_[A-Za-z_]+|NS(Selector|Class|Protocol)FromString|objc_(getClass|lookUpClass|getRequiredClass|getMetaClass|copyClassList|getClassList|allocateClassPair)|(class|method|imp|protocol)_[A-Za-z_]+|object_(getClass|setClass)|dyld_[A-Za-z_]+|dl(sym|open)|NSCreateObjectFileImageFromMemory|posix_spawnp?|execv[ep]?|execl[ep]?|v?fork|system|popen|xpc_connection_create[A-Za-z_]*'\
'|OBJC_CLASS_\$_(NS(Predicate|CompoundPredicate|ComparisonPredicate|Expression|SortDescriptor|Invocation|InvocationOperation|MethodSignature|Task|XPCConnection|AppleScript|User[A-Za-z]*Task)|NS(Object|Array|Tree|Dictionary|UserDefaults)Controller|NSScript[A-Za-z]*)'\
'|\$s10ObjectiveC8SelectorV.*|\$sSo(11NSPredicate|12NSExpression|16NSSortDescriptor|6NSTask)C.*)$'
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

scan_source() { # <dir>: the lines that break a rule, if any
  local files hits
  files=("$1"/*.swift(N))
  # A directory with no Swift source is not one this scan has checked.
  [ ${#files} -ge 1 ] || { echo "no Swift sources in $1" >&2; return 1; }
  hits=$(grep -nE "$SOURCE_FORBIDDEN" "${files[@]}" || true)
  [ -z "$hits" ] || { print -r -- "$hits" >&2; return 1; }
}
selectors() { otool -v -s __TEXT __objc_methname "$1" 2>/dev/null | sed -n '3,$p' | sed -E 's/^[0-9a-fA-F]+[[:space:]]+//'; }
scan_binary() { # <file>: the selectors, strings and imports that break a rule, if any
  local sels imports hits
  sels=$(selectors "$1" || true)
  imports=$(nm -u "$1" 2>/dev/null) || imports=""
  # A binary with no selector table or no imports to read is not one this scan has checked.
  [ -n "$sels" ] || { echo "could not read the selectors of $1" >&2; return 1; }
  [ -n "$imports" ] || { echo "could not read the imports of $1" >&2; return 1; }
  hits=$( { print -r -- "$sels" | grep -xE "$WRITE_SELECTORS|$BYNAME_SELECTORS" || true
            strings -a "$1" | grep -xE "$WRITE_SELECTORS" || true
            print -r -- "$imports" | grep -E "$IMPORT_FORBIDDEN" || true; } | sort -u)
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
scan_source "$DIR" || die "a Swift source breaks a read-only rule (above); Flint Calendar only reads"
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
scan_binary "$BIN" || die "the built binary breaks a read-only rule (above); Flint Calendar only reads"
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
# The text above is what the signer chose to embed; this checks that the signature really meets it.
codesign --verify --strict -R "=${WANT#designated => }" "$APP" >/dev/null 2>&1 || die "the build's signature does not satisfy $WANT"
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
