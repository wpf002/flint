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

echo "installing wrappers + LaunchAgents..."
# Nightly reflection (03:00) + morning brief (07:00). Both run the bundle.
cp "$REPO/apps/ask/nightly-reflect.sh" "$DATA/nightly-reflect.sh"
cp "$REPO/apps/ask/morning-brief.sh" "$DATA/morning-brief.sh"
chmod +x "$DATA/nightly-reflect.sh" "$DATA/morning-brief.sh"

for p in "$PLIST" com.flint.brief.plist; do
  cp "$REPO/apps/ask/$p" "$AGENTS/$p"
  launchctl unload "$AGENTS/$p" 2>/dev/null || true
  launchctl load -w "$AGENTS/$p"
done

echo "done. nightly reflection runs at 03:00; morning brief at 07:00."
echo "test now: launchctl kickstart -k gui/$(id -u)/com.flint.brief"
