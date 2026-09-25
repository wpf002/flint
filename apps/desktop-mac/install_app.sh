#!/bin/zsh
# Builds Flint.app from flint.swift and installs it to /Applications.
#
#   ./apps/desktop-mac/install_app.sh              # build and install
#   ./apps/desktop-mac/install_app.sh --if-closed  # exit 3 instead of replacing a running app
#
# Signed with the stable "Flint Dev" identity (created on first run), so the
# microphone grant for voice survives updates. If the identity cannot be made,
# it falls back to ad-hoc and says so, and the mic will be asked for again.
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
IDENTITY="${FLINT_SIGN_IDENTITY:-Flint Dev}"
if FLINT_SIGN_IDENTITY="$IDENTITY" "$DIR/create_signing_identity.sh" >&2; then
  codesign --force --sign "$IDENTITY" "$APP" >/dev/null 2>&1
else
  echo "warning: no '$IDENTITY' identity; signing ad-hoc, so the mic grant will not survive updates" >&2
  codesign --force --sign - "$APP" >/dev/null 2>&1
fi
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
