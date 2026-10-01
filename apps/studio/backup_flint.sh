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
# launchd's zsh may write into iCloud Drive by path but TCC denies it listing the
# folder, so a glob there matches nothing and offsite pruning silently never ran.
# Offsite snapshots are tracked here instead, one filename per line, oldest first.
MANIFEST="${FLINT_BACKUP_MANIFEST:-$SRC/offsite-backups.txt}"
TS="${FLINT_BACKUP_TS:-$(date +%Y%m%d-%H%M)}"   # tests set it, rather than wait a minute between runs

EXCLUDES=(
  --exclude './models' --exclude './brain/.venv' --exclude './brain/data'
  --exclude './brain/__pycache__' --exclude './brain/adapters*/0*_adapters.safetensors'
  --exclude './brain/adapters70b.run*' --exclude './*.log' --exclude './brain/*.log'
  --exclude './tailscaled.sock' --exclude './server.mjs' --exclude './ask.mjs'
  --exclude './*.log.[0-9]*'       # rotated logs (rotate_logs below)
)
# Offsite only. bsdtar's * crosses '/', so './*.x' matches at any depth: no
# './*token*' here, it would take the adapters' tokenizer files with it.
SECRETS=(
  --exclude './secrets.env' --exclude './*.env' --exclude './token'
  --exclude './*token*.txt' --exclude './tailscaled.state*' --exclude './tailscale'
  # Found in every offsite archive on 2026-09-30, keys and tokens in plaintext:
  --exclude './*.bak*'             # secrets.env.bak*, plist and mcp.json backups, at any depth
  --exclude './mcp.json*'          # the search API key and the Nexus bearer token
  --exclude './nexus-responder.*'  # participant tokens and vendor API keys
  --exclude './legion'             # helper scripts with inline credentials
  --exclude './tokens'             # per-client token files
)

# Optional: encrypt the offsite copy to an age public key whose private half lives
# OFF this Mac (`age-keygen` elsewhere; restore with `age -d -i key.txt`). Put the
# public key (age1...) in ~/.flint/backup-age-recipient, or FLINT_BACKUP_AGE_RECIPIENT.
# Set, the offsite copy is <name>.tar.gz.age; set but `age` not found, no offsite
# copy is written at all rather than a plaintext one.
AGE_RECIPIENT="${FLINT_BACKUP_AGE_RECIPIENT:-}"
[ -z "$AGE_RECIPIENT" ] && [ -f "$SRC/backup-age-recipient" ] && AGE_RECIPIENT="$(tr -d '[:space:]' < "$SRC/backup-age-recipient")"
# launchd runs this with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no Homebrew,
# so look where age is installed too. FLINT_AGE_BIN, when set, is the only answer.
if [ -n "${FLINT_AGE_BIN+x}" ]; then AGE_BIN="$FLINT_AGE_BIN"
else AGE_BIN="$(command -v age || true)"; for c in /opt/homebrew/bin/age /usr/local/bin/age; do [ -z "$AGE_BIN" ] && [ -x "$c" ] && AGE_BIN="$c"; done
fi

prune() { # dir keep
  ls -1t "$1"/flint-*.tar.gz 2>/dev/null | tail -n +$(( $2 + 1 )) | while read -r f; do rm -f "$f"; done
}

prune_offsite() { # by name from the manifest; never lists $OFFSITE
  local total=$(wc -l < "$MANIFEST" | tr -d ' ') kept="$MANIFEST.tmp" name
  local drop=$(( total > KEEP_OFFSITE ? total - KEEP_OFFSITE : 0 ))
  : > "$kept"
  # macOS head rejects -n 0 ("illegal line count"), which aborted every prune
  # while there was nothing to drop.
  if [ "$drop" -gt 0 ]; then
    head -n "$drop" "$MANIFEST" | while read -r name; do
      rm -f "$OFFSITE/$name" 2>/dev/null || { echo "$(date '+%F %T') offsite prune FAILED: $name" >&2; echo "$name" >> "$kept"; }
    done
  fi
  tail -n "$KEEP_OFFSITE" "$MANIFEST" >> "$kept"
  mv "$kept" "$MANIFEST"
}

rotate_logs() { # dir: any *.log over 20 MB becomes <log>.1.gz (keeping 3); copy-truncate, as writers hold it open
  local f size
  for f in "$1"/*.log(N); do
    size=$(stat -f %z "$f" 2>/dev/null || echo 0)
    [ "$size" -gt $(( 20 * 1024 * 1024 )) ] || continue
    [ -f "$f.2.gz" ] && mv -f "$f.2.gz" "$f.3.gz"
    [ -f "$f.1.gz" ] && mv -f "$f.1.gz" "$f.2.gz"
    cp -p "$f" "$f.1" && : > "$f" && gzip -f "$f.1"
    echo "$(date '+%F %T') rotated $(basename "$f") ($(( size / 1048576 )) MB)"
  done
}

# test/backup_excludes.test.sh sources this file for the arrays and functions alone.
[ -n "${FLINT_BACKUP_DEFINE_ONLY:-}" ] && return 0

rotate_logs "$SRC"
mkdir -p "$LOCAL"; chmod 700 "$LOCAL"
tar -czf "$LOCAL/flint-$TS.tar.gz" -C "$SRC" "${EXCLUDES[@]}" .
chmod 600 "$LOCAL/flint-$TS.tar.gz"
tar -tzf "$LOCAL/flint-$TS.tar.gz" >/dev/null   # a snapshot that can't be listed isn't a backup
prune "$LOCAL" "$KEEP_LOCAL"
echo "$(date '+%F %T') local  $(du -h "$LOCAL/flint-$TS.tar.gz" | cut -f1)  $LOCAL/flint-$TS.tar.gz"

if [ -n "$OFFSITE" ] && [ -d "$(dirname "$OFFSITE")" ]; then
  mkdir -p "$OFFSITE"
  # First run with a manifest: seed it from the local snapshot names. Offsite
  # copies are written in the same run as local ones, under the same name, and
  # rm -f on a name that was never written offsite is harmless.
  [ -f "$MANIFEST" ] || ls -1tr "$LOCAL" | grep -E '^flint-.*\.tar\.gz$' | grep -vxF "flint-$TS.tar.gz" > "$MANIFEST" || true
  if [ -n "$AGE_RECIPIENT" ]; then
    if [ -n "$AGE_BIN" ] && [ -x "$AGE_BIN" ]; then
      name="flint-$TS.tar.gz.age"
      # Both sides must succeed: zsh's set -e sees only the last command of a pipe,
      # and age would happily encrypt a truncated tar stream.
      set +e
      tar -czf - -C "$SRC" "${EXCLUDES[@]}" "${SECRETS[@]}" . | "$AGE_BIN" -r "$AGE_RECIPIENT" -o "$OFFSITE/$name"
      st=("${pipestatus[@]}")
      set -e
      if [ "${st[1]}" != 0 ] || [ "${st[2]}" != 0 ]; then
        rm -f "$OFFSITE/$name"
        echo "$(date '+%F %T') offsite FAILED: tar exited ${st[1]}, age ${st[2]}; nothing recorded" >&2
        name=""
      fi
    else
      echo "$(date '+%F %T') offsite SKIPPED: an age recipient is set but age was not found (PATH=$PATH, /opt/homebrew/bin, /usr/local/bin); no plaintext copy written" >&2
      name=""
    fi
  else
    name="flint-$TS.tar.gz"
    tar -czf "$OFFSITE/$name" -C "$SRC" "${EXCLUDES[@]}" "${SECRETS[@]}" .
  fi
  if [ -n "$name" ]; then
    echo "$name" >> "$MANIFEST"
    prune_offsite
    echo "$(date '+%F %T') offsite $(du -h "$OFFSITE/$name" | cut -f1)  $OFFSITE/$name"
  fi
else
  echo "$(date '+%F %T') offsite skipped: $(dirname "$OFFSITE") not present"
fi
