#!/bin/zsh
# morning-brief.sh — Flint's proactive morning brief. Run by launchd
# (com.flint.brief). Pulls live state from your connected systems and writes
# ~/.flint/brief-latest.md. Same TCC-safe bundle approach as nightly-reflect.
#
# Logs to ~/.flint/brief.log. Safe to run by hand any time.

set -u

export PATH="/Users/willfoti/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b}"

OLLAMA="$HOME/.flint-ollama/ollama"
DATA="$HOME/.flint"
LOG="$DATA/brief.log"
BUNDLE="$DATA/ask.mjs"

mkdir -p "$DATA"
echo "=== brief run $(date) ===" >> "$LOG"

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: $BUNDLE missing — run apps/ask/install-nightly.sh" >> "$LOG"
  exit 1
fi

if ! curl -sS -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "ollama not running — starting it" >> "$LOG"
  nohup "$OLLAMA" serve >> "$DATA/ollama.log" 2>&1 &
  for i in $(seq 1 30); do
    curl -sS -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -sS -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  echo "ERROR: ollama did not come up; skipping brief" >> "$LOG"
  exit 1
fi

node "$BUNDLE" brief >> "$LOG" 2>&1
echo "=== done $(date) (brief at $DATA/brief-latest.md) ===" >> "$LOG"
