#!/bin/zsh
# overnight-agent.sh — run Flint's overnight task UNATTENDED under the autonomy
# policy. Run by launchd (com.flint.agent). Reads the task from
# ~/.flint/overnight-task.txt and the whitelist from ~/.flint/autonomy.json;
# writes ~/.flint/overnight-report.md. Same TCC-safe bundle approach.
#
# Logs to ~/.flint/agent.log.

set -u

export PATH="/Users/willfoti/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b}"

OLLAMA="$HOME/.flint-ollama/ollama"
DATA="$HOME/.flint"
LOG="$DATA/agent.log"
BUNDLE="$DATA/ask.mjs"

mkdir -p "$DATA"
echo "=== agent run $(date) ===" >> "$LOG"

if [ ! -f "$BUNDLE" ]; then
  echo "ERROR: $BUNDLE missing — run apps/ask/install-nightly.sh" >> "$LOG"
  exit 1
fi
if [ ! -s "$DATA/overnight-task.txt" ]; then
  echo "no overnight-task.txt — nothing to do" >> "$LOG"
  exit 0
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
  echo "ERROR: ollama did not come up; skipping" >> "$LOG"
  exit 1
fi

node "$BUNDLE" agent >> "$LOG" 2>&1
echo "=== done $(date) (report at $DATA/overnight-report.md) ===" >> "$LOG"
