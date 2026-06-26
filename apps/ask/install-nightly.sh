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
# overnight agent (02:00) + nightly reflection (03:00) + morning brief (07:00).
cp "$REPO/apps/ask/overnight-agent.sh" "$DATA/overnight-agent.sh"
cp "$REPO/apps/ask/nightly-reflect.sh" "$DATA/nightly-reflect.sh"
cp "$REPO/apps/ask/morning-brief.sh" "$DATA/morning-brief.sh"
chmod +x "$DATA/overnight-agent.sh" "$DATA/nightly-reflect.sh" "$DATA/morning-brief.sh"

for p in com.flint.agent.plist "$PLIST" com.flint.brief.plist; do
  cp "$REPO/apps/ask/$p" "$AGENTS/$p"
  launchctl unload "$AGENTS/$p" 2>/dev/null || true
  launchctl load -w "$AGENTS/$p"
done

echo "done. overnight agent 02:00; reflection 03:00; brief 07:00."
echo "overnight task: write ~/.flint/overnight-task.txt and ~/.flint/autonomy.json"
