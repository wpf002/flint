#!/bin/zsh
# install-nightly.sh — deploy Flint's nightly self-reflection.
#
# Bundles `ask` into a self-contained file under ~/.flint (so the launchd job
# never touches ~/Documents, which macOS TCC blocks for background agents),
# installs the wrapper + LaunchAgent, and loads it. Re-run after code changes.

set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$HOME/.flint"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="com.flint.reflect.plist"
mkdir -p "$DATA" "$AGENTS"

echo "building @flint/core + @flint/persona..."
pnpm --filter @flint/core build >/dev/null
pnpm --filter @flint/persona build >/dev/null

echo "bundling ask -> $DATA/ask.mjs ..."
ESBUILD="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1)"
"$ESBUILD" "$REPO/apps/ask/src/index.ts" --bundle --platform=node --format=esm --target=node20 \
  --external:@anthropic-ai/sdk \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$DATA/ask.mjs"

echo "installing wrapper + LaunchAgent..."
cp "$REPO/apps/ask/nightly-reflect.sh" "$DATA/nightly-reflect.sh"
chmod +x "$DATA/nightly-reflect.sh"
cp "$REPO/apps/ask/$PLIST" "$AGENTS/$PLIST"

launchctl unload "$AGENTS/$PLIST" 2>/dev/null || true
launchctl load -w "$AGENTS/$PLIST"

echo "done. nightly reflection runs at 03:00."
echo "test now: launchctl kickstart -k gui/$(id -u)/com.flint.reflect"
