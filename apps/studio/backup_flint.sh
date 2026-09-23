#!/bin/zsh
# Nightly snapshot of Flint's irreplaceable state: memory, the training corpus,
# config, eval history and the ACTIVE adapters. Skips what can be rebuilt (the
# venv, the 50k public data, the ollama models, per-iteration checkpoints).
#
# Local snapshots keep everything, secrets included (dir is 700). The offsite
# copy (iCloud by default) drops secrets and tokens: API keys can be reissued,
# and they shouldn't sit in a synced folder in plaintext.
set -eu
SRC="$HOME/.flint"
LOCAL="${FLINT_BACKUP_DIR:-$HOME/FlintBackups}"
OFFSITE="${FLINT_BACKUP_OFFSITE:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups}"
KEEP_LOCAL="${FLINT_BACKUP_KEEP:-14}"
KEEP_OFFSITE="${FLINT_BACKUP_KEEP_OFFSITE:-7}"
TS=$(date +%Y%m%d-%H%M)

EXCLUDES=(
  --exclude './models' --exclude './brain/.venv' --exclude './brain/data'
  --exclude './brain/__pycache__' --exclude './brain/adapters*/0*_adapters.safetensors'
  --exclude './brain/adapters70b.run*' --exclude './*.log' --exclude './brain/*.log'
  --exclude './tailscaled.sock' --exclude './server.mjs' --exclude './ask.mjs'
)
SECRETS=(
  --exclude './secrets.env' --exclude './*.env' --exclude './token'
  --exclude './*token*.txt' --exclude './tailscaled.state*' --exclude './tailscale'
)

prune() { # dir keep
  ls -1t "$1"/flint-*.tar.gz 2>/dev/null | tail -n +$(( $2 + 1 )) | while read -r f; do rm -f "$f"; done
}

mkdir -p "$LOCAL"; chmod 700 "$LOCAL"
tar -czf "$LOCAL/flint-$TS.tar.gz" -C "$SRC" "${EXCLUDES[@]}" .
chmod 600 "$LOCAL/flint-$TS.tar.gz"
tar -tzf "$LOCAL/flint-$TS.tar.gz" >/dev/null   # a snapshot that can't be listed isn't a backup
prune "$LOCAL" "$KEEP_LOCAL"
echo "$(date '+%F %T') local  $(du -h "$LOCAL/flint-$TS.tar.gz" | cut -f1)  $LOCAL/flint-$TS.tar.gz"

if [ -n "$OFFSITE" ] && [ -d "$(dirname "$OFFSITE")" ]; then
  mkdir -p "$OFFSITE"
  tar -czf "$OFFSITE/flint-$TS.tar.gz" -C "$SRC" "${EXCLUDES[@]}" "${SECRETS[@]}" .
  prune "$OFFSITE" "$KEEP_OFFSITE"
  echo "$(date '+%F %T') offsite $(du -h "$OFFSITE/flint-$TS.tar.gz" | cut -f1)  $OFFSITE/flint-$TS.tar.gz"
else
  echo "$(date '+%F %T') offsite skipped: $(dirname "$OFFSITE") not present"
fi
