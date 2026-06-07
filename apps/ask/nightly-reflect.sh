#!/bin/zsh
# nightly-reflect.sh — distill Flint's lessons from recent conversations.
# Run by launchd (com.flint.reflect) once a night.
#
# IMPORTANT: this and its inputs live under ~/.flint (NOT ~/Documents). macOS
# TCC blocks background launchd agents from reading ~/Documents, so the nightly
# job runs a self-contained bundle (~/.flint/ask.mjs) instead of the repo.
# Re-deploy the bundle with apps/ask/install-nightly.sh after code changes.
#
# Logs to ~/.flint/reflect.log. Safe to run by hand any time.

set -u

# launchd has no nvm/PATH — point at the known node toolchain explicitly.
export PATH="/Users/willfoti/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b}"

OLLAMA="$HOME/.flint-ollama/ollama"
DATA="$HOME/.flint"
LOG="$DATA/reflect.log"
BUNDLE="$DATA/ask.mjs"

mkdir -p "$DATA"
echo "=== reflect run $(date) ===" >> "$LOG"

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: $BUNDLE missing — run apps/ask/install-nightly.sh" >> "$LOG"
  exit 1
fi

# Ensure the local model server is reachable; start it if not.
if ! curl -sS -m 3 http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "ollama not running — starting it" >> "$LOG"
  nohup "$OLLAMA" serve >> "$DATA/ollama.log" 2>&1 &
  for i in $(seq 1 30); do
    curl -sS -m 3 http://localhost:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -sS -m 3 http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "ERROR: ollama did not come up; skipping reflect" >> "$LOG"
  exit 1
fi

node "$BUNDLE" reflect >> "$LOG" 2>&1
node "$BUNDLE" consolidate >> "$LOG" 2>&1
echo "=== done $(date) ===" >> "$LOG"
