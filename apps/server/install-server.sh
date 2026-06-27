#!/bin/zsh
# install-server.sh — build the Flint gateway server into a self-contained
# bundle at ~/.flint/server.mjs and reload its LaunchAgent.
#
# esbuild reads apps/server/src/index.ts directly but resolves the @flint/*
# workspace deps via their dist output, so core + persona are rebuilt first to
# fold in any provider/persona changes. Re-run after editing the server, the
# Ollama provider, or the persona.

set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$HOME/.flint"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="com.flint.server.plist"
mkdir -p "$DATA" "$AGENTS"

echo "building @flint/core + @flint/persona..."
pnpm --filter @flint/core build >/dev/null
pnpm --filter @flint/persona build >/dev/null

echo "bundling server -> $DATA/server.mjs ..."
ESBUILD="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1)"
# NOTE: @anthropic-ai/sdk is bundled IN (no --external) — the server is the
# frontier-escalation host and must be self-contained at ~/.flint/server.mjs,
# which has no node_modules to resolve a peer dep from.
"$ESBUILD" "$REPO/apps/server/src/index.ts" --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$DATA/server.mjs"

echo "deploying console -> $DATA/console.html ..."
cp "$REPO/apps/console/index.html" "$DATA/console.html"

echo "reloading com.flint.server..."
launchctl unload "$AGENTS/$PLIST" 2>/dev/null || true
launchctl load -w "$AGENTS/$PLIST"

echo "done. server bundled and reloaded on :8080."
