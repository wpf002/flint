#!/bin/zsh
# Nightly snapshot of Flint's irreplaceable state: memory, the training corpus,
# config, eval history and the ACTIVE adapters. Skips what can be rebuilt (the
# venv, the 50k public data, the ollama models, per-iteration checkpoints).
#
# Local snapshots keep everything, secrets included (dir is 700). The offsite
# copy (iCloud by default) drops secrets and tokens, and is written only
# encrypted to Will's age key: it holds his chat history, memory and
# notifications, which must never sit in a synced folder in plaintext.
#
# Every archive it writes, here or offsite, and every one it could not write, is
# one line in ~/.flint/backup-events.jsonl (backup_event, below). The runtime
# reads them, so Settings > Health says how old the last files backup is and
# whether the last one failed. It checks for room before it writes, and an
# archive that was not finished is never left under a snapshot's name.
#
#   backup_flint.sh              tonight's archive (com.flint.backup, 02:30)
#   backup_flint.sh --catch-up   only when the catch-up is switched on
#                                (FLINT_BACKUP_CATCHUP=on in ~/.flint/backup.env)
#                                and the last good archive is over 26 hours
#                                old: the night's run was missed. Started when
#                                you log in (com.flint.backup-catchup).
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
  --exclude './runtime/releases'   # runtime bundles, ~100 MB each, rebuilt by install-runtime.sh
  --exclude './backup.lock'        # this run's own lock (below)
)
# Offsite only. bsdtar's * crosses '/', so './*.x' matches at any depth: no
# './*token*' here, it would take the adapters' tokenizer files with it.
SECRETS=(
  --exclude './secrets.env' --exclude './*.env' --exclude './token'
  --exclude './*.env.*'            # a copy of a settings file made by hand (backup.env.before-...): the same secrets
  --exclude './*token*.txt' --exclude './tailscaled.state*' --exclude './tailscale'
  # Found in every offsite archive on 2026-09-30, keys and tokens in plaintext:
  --exclude './*.bak*'             # secrets.env.bak*, plist and mcp.json backups, at any depth
  --exclude './mcp.json*'          # the search API key and the Nexus bearer token
  --exclude './nexus-responder.*'  # participant tokens and vendor API keys
  --exclude './legion'             # helper scripts with inline credentials
  --exclude './tokens'             # per-client token files
  --exclude './enroll-code'        # the one-time code for registering an approval key
  --exclude './google'             # the Google OAuth client and refresh token (P2.5 calendar)
  --exclude './backup-fingerprint.key'   # seals each database dump's fingerprint (apps/runtime restore.ts)
)

# The offsite copy is encrypted to an age public key whose private half lives OFF
# this Mac (`age-keygen` elsewhere; restore with `age -d -i key.txt`). Put the
# public key (age1...) in ~/.flint/backup-age-recipient, or FLINT_BACKUP_AGE_RECIPIENT.
# The offsite copy is <name>.tar.gz.age. With no key, or with `age` not found, no
# offsite copy is written at all, never a plaintext one; local snapshots go on.
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

# A snapshot's own name, and nothing else: no folder in it, no other kind of file.
offsite_name() { [[ $1 =~ '^flint-[0-9]{8}-[0-9]{4}\.tar\.gz(\.age)?$' ]]; }

prune_offsite() { # by name from the manifest; never lists $OFFSITE
  local total=$(wc -l < "$MANIFEST" | tr -d ' ') kept="$MANIFEST.tmp" name
  local drop=$(( total > KEEP_OFFSITE ? total - KEEP_OFFSITE : 0 ))
  : > "$kept"
  # macOS head rejects -n 0 ("illegal line count"), which aborted every prune
  # while there was nothing to drop.
  if [ "$drop" -gt 0 ]; then
    head -n "$drop" "$MANIFEST" | while read -r name; do
      # Only a name this script writes is ever removed: a line that is anything else (a path, a file of
      # another kind, something put there by hand or by a restored copy of this list) is dropped unread.
      offsite_name "$name" || continue
      rm -f "$OFFSITE/$name" 2>/dev/null || { echo "$(date '+%F %T') offsite prune FAILED: $name" >&2; echo "$name" >> "$kept"; }
    done
  fi
  tail -n "$KEEP_OFFSITE" "$MANIFEST" | while read -r name; do offsite_name "$name" && echo "$name"; done >> "$kept"
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

# The record of each archive (BackupEvent in packages/policy/src/wire.ts): one JSON
# line in ~/.flint/backup-events.jsonl (0600), read by the runtime into its list of
# backups. Ids, enums, numbers and hashes only: the archive's own name (a time,
# nothing else), never a path and never log text. Writing it can never fail a
# backup: errexit is off inside, and it always returns 0.
EVENTS="$SRC/backup-events.jsonl"
backup_event() { # <local|icloud> ok <name> <bytes> <sha256>  |  <local|icloud> failed <name> <reason>
  emulate -L zsh
  setopt no_err_exit no_err_return no_pipefail
  local id at said
  [[ $1 == (local|icloud) && $2 == (ok|failed) ]] || return 0
  [[ $3 =~ '^flint-[0-9]{8}-[0-9]{4}\.tar\.gz(\.age)?$' ]] || return 0
  # Offsite is the encrypted archive, and only that.
  if [[ $1 == icloud ]]; then [[ $3 == *.age ]] || return 0; else [[ $3 != *.age ]] || return 0; fi
  if [[ $2 == ok ]]; then
    [[ ${4:-} =~ '^(0|[1-9][0-9]{0,14})$' && ${5:-} =~ '^[0-9a-f]{64}$' ]] || return 0
    said="\"bytes\":$4,\"sha256\":\"$5\""
  else
    [[ ${4:-} == (space|archive|unreadable|encrypt|no_tool|no_folder|interrupted) ]] || return 0
    said="\"reason\":\"$4\""
  fi
  id="$(openssl rand -hex 16 2>/dev/null)"
  [[ $id =~ '^[0-9a-f]{32}$' ]] || return 0
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  [[ $at =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' ]] || return 0
  ( umask 077; print -r -- "{\"id\":\"$id\",\"at\":\"$at\",\"kind\":\"flint_tar\",\"location\":\"$1\",\"outcome\":\"$2\",\"name\":\"$3\",$said}" >> "$EVENTS" ) 2>/dev/null || return 0
  chmod 600 "$EVENTS" 2>/dev/null
  return 0
}
size_of() { stat -f %z "$1" 2>/dev/null; }
hash_of() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

# This run's own unfinished file, taken away: only a name this script writes (a snapshot's,
# whole, encrypted or part written), and only in a folder that is named. Nothing else is ever removed here.
drop_own() { # folder name
  emulate -L zsh
  setopt no_err_exit no_err_return
  [[ -n ${1:-} && ${2:-} =~ '^flint-[0-9]{8}-[0-9]{4}\.tar\.gz(\.age|\.partial)?$' ]] || return 0
  [[ -f $1/$2 ]] && unlink "$1/$2" 2>/dev/null
  return 0
}

# Room to write tonight's archive: twice the size of the newest one here (the new
# archive, and as much again to spare), and never less than 1 GB. An archive cut
# short by a full disk is worse than none, and the database stops when the disk fills.
free_kb() { # folder
  if [ -n "${FLINT_BACKUP_FREE_KB:-}" ]; then print -r -- "$FLINT_BACKUP_FREE_KB"; return 0; fi   # a test's stand-in for a full disk
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { print $4 }'
}
need_kb() { # folder
  local -a olds; olds=("$1"/flint-*.tar.gz(Nom))
  local last=0
  (( ${#olds} )) && last="$(size_of "${olds[1]}")"
  local need=$(( ${last:-0} * 2 / 1024 ))
  (( need < 1048576 )) && need=1048576
  print -r -- "$need"
}

# The catch-up is off unless FLINT_BACKUP_CATCHUP says on in ~/.flint/backup.env (the environment, when it says,
# wins). "On" is any of the words the settings manifest takes for a switch (apps/studio/recovery_lib.sh, onoff):
# on, 1, true, yes. Quotes around the word are taken off, as the other readers of that file do. Anything else,
# a word nobody knows included, is off.
catchup_on() {
  local v="${FLINT_BACKUP_CATCHUP:-}"
  [ -z "$v" ] && [ -r "$SRC/backup.env" ] && v="$(sed -n 's/^FLINT_BACKUP_CATCHUP=//p' "$SRC/backup.env" | tail -1)"
  v="${v%$'\r'}"
  if [[ $v == \"*\" || $v == \'*\' ]]; then v="${v[2,-2]}"; fi
  [[ ${v:l} == (on|1|true|yes) ]]
}
# How old the newest good archive here is, in seconds (nothing printed when there is none).
newest_age() { # folder
  local -a olds; olds=("$1"/flint-*.tar.gz(Nom))
  (( ${#olds} )) || return 0
  print -r -- $(( $(date +%s) - $(stat -f %m "${olds[1]}") ))
}

# test/backup_excludes.test.sh sources this file for the arrays and functions alone.
[ -n "${FLINT_BACKUP_DEFINE_ONLY:-}" ] && return 0

MODE=nightly
case "${1:-}" in
  '') ;;
  --catch-up) MODE=catchup ;;
  *) echo "usage: backup_flint.sh [--catch-up]" >&2; exit 2 ;;
esac
if [ "$MODE" = catchup ]; then
  catchup_on || exit 0
  age="$(newest_age "$LOCAL")"
  # 26 hours: a night's run that is merely late is not one that was missed.
  if [ -n "$age" ] && [ "$age" -le $(( 26 * 3600 )) ]; then exit 0; fi
  echo "$(date '+%F %T') catching up: the last good archive is over 26 hours old (or there is none)"
fi

# One run at a time: the catch-up and the night's own run must not write the same archive.
# A lock left by a run that died is nobody's once it is six hours old.
# (A data folder that cannot be written to takes no lock at all: the backup of what is in it still runs.)
LOCK="$SRC/backup.lock"; LOCKED=0
if mkdir "$LOCK" 2>/dev/null; then LOCKED=1
elif [ -d "$LOCK" ]; then
  if [ $(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) )) -gt 21600 ] && rmdir "$LOCK" 2>/dev/null && mkdir "$LOCK" 2>/dev/null; then LOCKED=1
  else echo "$(date '+%F %T') another backup is running; this one stops"; exit 0
  fi
fi

# However this run ends, the record says so: an archive that was not finished is taken away (it is
# never left under a snapshot's name) and written down as failed, with why.
NAME_LOCAL="flint-$TS.tar.gz"
NAME_OFFSITE=""
STAGE=start LOCAL_DONE=0 OFFSITE_DONE=0 INTERRUPTED=0 WHY=""
finish() { # exit status
  emulate -L zsh
  setopt no_err_exit no_err_return no_unset
  local st=$1 why="${WHY:-archive}"
  [ "$INTERRUPTED" = 1 ] && why=interrupted
  if [ "$st" != 0 ]; then
    if [ "$STAGE" != start ] && [ "$LOCAL_DONE" = 0 ]; then
      drop_own "$LOCAL" "$NAME_LOCAL.partial"
      backup_event local failed "$NAME_LOCAL" "$why"
    fi
    if [ "$STAGE" = offsite ] && [ "$OFFSITE_DONE" = 0 ] && offsite_name "$NAME_OFFSITE"; then
      drop_own "$OFFSITE" "$NAME_OFFSITE"
      rm -f "$LOCAL/.offsite-sha256" 2>/dev/null
      backup_event icloud failed "$NAME_OFFSITE" "$why"
    fi
  fi
  [ "$LOCKED" = 1 ] && rmdir "$LOCK" 2>/dev/null
  return 0
}
trap 'finish $?' EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM HUP

rotate_logs "$SRC"
# The settings a rebuild puts back (settings_manifest.sh), saved into $SRC first so
# tonight's archives carry them. Never secrets, and never a reason to skip a backup.
[ -r "${0:A:h}/settings_manifest.sh" ] && { /bin/zsh "${0:A:h}/settings_manifest.sh" || true; }
mkdir -p "$LOCAL"; chmod 700 "$LOCAL"
# What a run that was killed outright left part written.
for left in "$LOCAL"/flint-*.tar.gz.partial(N); do drop_own "$LOCAL" "${left:t}"; done
STAGE=local
free="$(free_kb "$LOCAL")"; need="$(need_kb "$LOCAL")"
if [[ $free =~ '^[0-9]+$' ]] && [ "$free" -lt "$need" ]; then
  WHY=space
  echo "$(date '+%F %T') local SKIPPED: not enough free space ($(( free / 1024 )) MB free, $(( need / 1024 )) MB needed); no archive written" >&2
  exit 1
fi
# Written under another name until it is whole and can be listed: a snapshot's name is only ever a good archive's.
tar -czf "$LOCAL/$NAME_LOCAL.partial" -C "$SRC" "${EXCLUDES[@]}" .
chmod 600 "$LOCAL/$NAME_LOCAL.partial"
WHY=unreadable
tar -tzf "$LOCAL/$NAME_LOCAL.partial" >/dev/null   # a snapshot that can't be listed isn't a backup
WHY=""
mv "$LOCAL/$NAME_LOCAL.partial" "$LOCAL/$NAME_LOCAL"
LOCAL_DONE=1
backup_event local ok "$NAME_LOCAL" "$(size_of "$LOCAL/$NAME_LOCAL")" "$(hash_of "$LOCAL/$NAME_LOCAL")"
prune "$LOCAL" "$KEEP_LOCAL"
echo "$(date '+%F %T') local  $(du -h "$LOCAL/flint-$TS.tar.gz" | cut -f1)  $LOCAL/flint-$TS.tar.gz"

if [ -n "$OFFSITE" ] && [ -d "$(dirname "$OFFSITE")" ]; then
  # A folder that cannot be made is a copy that was not made: said in the record when a key says one is
  # expected, as a folder that is not there is (below). It used to end the run here with nothing written down.
  if ! mkdir -p "$OFFSITE" 2>/dev/null; then
    echo "$(date '+%F %T') offsite FAILED: the offsite folder could not be made; no copy written" >&2
    [ -n "$AGE_RECIPIENT" ] && backup_event icloud failed "flint-$TS.tar.gz.age" no_folder
    exit 1
  fi
  # First run with a manifest: seed it from the local snapshot names. Offsite
  # copies are written in the same run as local ones, under the same name, and
  # rm -f on a name that was never written offsite is harmless.
  [ -f "$MANIFEST" ] || ls -1tr "$LOCAL" | grep -E '^flint-.*\.tar\.gz$' | grep -vxF "flint-$TS.tar.gz" > "$MANIFEST" || true
  if [ -n "$AGE_RECIPIENT" ]; then
    if [ -n "$AGE_BIN" ] && [ -x "$AGE_BIN" ]; then
      name="flint-$TS.tar.gz.age"
      # From here an archive is being written offsite: a run stopped part way takes it away and says so (finish).
      NAME_OFFSITE="$name"; STAGE=offsite
      # Every side must succeed: zsh's set -e sees only the last command of a pipe,
      # and age would happily encrypt a truncated tar stream.
      # The fingerprint is taken from the bytes as they are written, never read back: launchd's zsh may
      # write into iCloud Drive by path, but macOS refuses it the file's contents afterwards (Operation
      # not permitted). Read back, the fingerprint came out empty and the copy was never recorded. It goes
      # through a file beside the local archives (0700, never offsite) so that every part of the pipe is a
      # program of its own: with the shell as the last part, Ctrl-C cut the cleanup short and left the lock.
      sum=""; sumfile="$LOCAL/.offsite-sha256"
      set +e
      tar -czf - -C "$SRC" "${EXCLUDES[@]}" "${SECRETS[@]}" . | "$AGE_BIN" -r "$AGE_RECIPIENT" | tee "$OFFSITE/$name" | shasum -a 256 > "$sumfile"
      st=("${pipestatus[@]}")
      read -r sum _ < "$sumfile" 2>/dev/null; rm -f "$sumfile"
      set -e
      if [ "${st[1]}" != 0 ] || [ "${st[2]}" != 0 ] || [ "${st[3]}" != 0 ] || [ "${st[4]}" != 0 ]; then
        rm -f "$OFFSITE/$name"
        echo "$(date '+%F %T') offsite FAILED: tar exited ${st[1]}, age ${st[2]}, the write ${st[3]}, the fingerprint ${st[4]}; nothing recorded" >&2
        backup_event icloud failed "$name" encrypt
        name=""
      fi
      OFFSITE_DONE=1
    else
      echo "$(date '+%F %T') offsite SKIPPED: an age recipient is set but age was not found (PATH=$PATH, /opt/homebrew/bin, /usr/local/bin); no plaintext copy written" >&2
      backup_event icloud failed "flint-$TS.tar.gz.age" no_tool
      name=""
    fi
  else
    echo "$(date '+%F %T') offsite SKIPPED: no age recipient (put an age1... public key in ~/.flint/backup-age-recipient); no plaintext copy written" >&2
    name=""
  fi
  if [ -n "$name" ]; then
    echo "$name" >> "$MANIFEST"
    bytes="$(size_of "$OFFSITE/$name")" || bytes=""
    if [[ $bytes =~ '^(0|[1-9][0-9]{0,14})$' && $sum =~ '^[0-9a-f]{64}$' ]]; then
      backup_event icloud ok "$name" "$bytes" "$sum"
    else
      # A copy whose size or fingerprint cannot be stated is said to be unreadable, never left unsaid.
      echo "$(date '+%F %T') offsite written, but its size or fingerprint could not be taken; recorded as unreadable" >&2
      backup_event icloud failed "$name" unreadable
    fi
    prune_offsite
    echo "$(date '+%F %T') offsite $(du -h "$OFFSITE/$name" | cut -f1)  $OFFSITE/$name"
  fi
else
  echo "$(date '+%F %T') offsite skipped: $(dirname "$OFFSITE") not present"
  # With a key here an offsite copy is expected, so a folder that is not there is a copy that was not made.
  [ -n "$AGE_RECIPIENT" ] && backup_event icloud failed "flint-$TS.tar.gz.age" no_folder
fi
exit 0
