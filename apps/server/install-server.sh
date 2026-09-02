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

# ---- GATE: never deploy a broken Flint -----------------------------------
# (runs AFTER the workspace build — the server typechecks against their dist
# .d.ts, so stale types would produce phantom errors.)
# This script reloads the always-on assistant. Before it does, prove the code
# typechecks and the highest-consequence logic still behaves — the routing that
# decides whether a message leaves the machine, and the gate that decides
# whether a tool runs without asking. Set FLINT_SKIP_TESTS=1 to bypass in an
# emergency (and then go fix what you skipped).
if [ "${FLINT_SKIP_TESTS:-0}" != "1" ]; then
  echo "gate: typechecking..."
  pnpm --filter server typecheck || { echo "✗ typecheck failed — NOT deploying"; exit 1; }
  echo "gate: server policy tests (brain routing + auto-approval)..."
  pnpm --filter server test || { echo "✗ server tests failed — NOT deploying"; exit 1; }
  echo "gate: persona tests (voice + constitution in the prompt)..."
  pnpm --filter @flint/persona test || { echo "✗ persona tests failed — NOT deploying"; exit 1; }
  # NOTE: @flint/core is NOT gated on yet — 3 contract tests in
  # test/contracts/ollama.test.ts assert the OLD prompted-JSON tool path that was
  # replaced by native function-calling. They need a real contract decision, not
  # a rewrite-to-green. Run `pnpm --filter @flint/core test` to see them.
fi

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

# ---- VERIFY: did it actually come back up? -------------------------------
# A bundle that builds can still fail to boot. Poll the health endpoint the
# server already exposes rather than assuming the reload worked.
PORT_N="${PORT:-8080}"
echo "verifying http://127.0.0.1:$PORT_N/health ..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 3 "http://127.0.0.1:$PORT_N/health" >/dev/null 2>&1; then
    curl -fsS -m 3 "http://127.0.0.1:$PORT_N/health"; echo
    echo "done. server bundled, reloaded and answering on :$PORT_N."
    exit 0
  fi
  sleep 1
done
echo "✗ server did NOT come up on :$PORT_N — check $DATA/logs/server.err.log"
exit 1
