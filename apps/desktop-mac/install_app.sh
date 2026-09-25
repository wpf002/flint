#!/bin/zsh
# Builds Flint.app from flint.swift and installs it to /Applications.
#
#   ./apps/desktop-mac/install_app.sh              # build and install
#   ./apps/desktop-mac/install_app.sh --if-closed  # exit 3 instead of replacing a running app
#
# The bundle is signed ad-hoc, as it always was. macOS keys the microphone grant
# to the signature, so voice may ask for the mic again after an update that
# changes flint.swift.
set -eu
DIR="${0:A:h}"
DEST="${FLINT_APP_DEST:-/Applications/Flint.app}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Flint.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/flint" "$DIR/flint.swift" -framework Cocoa -framework WebKit
cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/flint.icns" "$APP/Contents/Resources/flint.icns"
codesign --force --sign - "$APP" >/dev/null 2>&1
codesign --verify --strict "$APP"

# The build takes a few seconds; the app may have been opened meanwhile.
if [ "${1:-}" = "--if-closed" ] && pgrep -qf "^$DEST/Contents/MacOS/flint( |$)"; then
  exit 3
fi

# Copy beside the old bundle first, so a failed copy never leaves no app at all.
rm -rf "$DEST.new"
ditto "$APP" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
