#!/bin/zsh
# The nightly backup end to end on a fake ~/.flint: offsite pruning (macOS head
# rejected -n 0, so every prune aborted), log rotation, and the optional age
# encryption of the offsite copy. Run: zsh apps/studio/test/backup_ops.test.sh
set -eu
here=${0:A:h}
script="$here/../backup_flint.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

run() { # extra env assignments...; HOME is the fixture, so SRC=$fx/home/.flint
  env -i HOME="$fx/home" PATH="$fx/bin:/usr/bin:/bin:/opt/homebrew/bin" FLINT_BACKUP_DIR="$fx/local" \
    FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" FLINT_BACKUP_MANIFEST="$fx/manifest.txt" "$@" /bin/zsh "$script" 2>"$fx/err.log"
}
mkdir -p "$fx/home/.flint/memory" "$fx/icloud" "$fx/bin"
print -r -- '{}' > "$fx/home/.flint/memory/knowledge.json"
print -r -- 'KEY=1' > "$fx/home/.flint/secrets.env"

# 1. Fewer offsite copies than the keep count: no "illegal line count", nothing pruned.
run FLINT_BACKUP_TS=20261001-0001 >/dev/null
check "first run wrote an offsite copy" '[ "$(ls "$fx/icloud/FlintBackups" | wc -l | tr -d " ")" = 1 ]'
check "no head error with nothing to prune" '! grep -q "illegal line count" "$fx/err.log"'

# 2. Over the keep count: the oldest offsite copies go, by name from the manifest.
for i in 1 2 3; do print -r -- "flint-2026090$i-0230.tar.gz" >> "$fx/manifest.txt"; : > "$fx/icloud/FlintBackups/flint-2026090$i-0230.tar.gz"; done
run FLINT_BACKUP_TS=20261001-0002 FLINT_BACKUP_KEEP_OFFSITE=2 >/dev/null
check "pruned down to the keep count" '[ "$(ls "$fx/icloud/FlintBackups" | wc -l | tr -d " ")" = 2 ]'
check "the oldest went first" '[ ! -e "$fx/icloud/FlintBackups/flint-20260901-0230.tar.gz" ]'
check "manifest matches" '[ "$(wc -l < "$fx/manifest.txt" | tr -d " ")" = 2 ]'

# 3. A log over 20 MB is rotated (copy-truncate), and rotated logs stay out of the backup.
mkfile -n 21m "$fx/home/.flint/ollama.err.log" 2>/dev/null || head -c 22020096 /dev/zero > "$fx/home/.flint/ollama.err.log"
out=$(run FLINT_BACKUP_TS=20261001-0003)
check "rotated the big log" '[ -f "$fx/home/.flint/ollama.err.log.1.gz" ] && [ ! -s "$fx/home/.flint/ollama.err.log" ]'
check "said so" 'print -r -- "$out" | grep -q "rotated ollama.err.log (21 MB)"'
latest=$(ls -t "$fx/local"/flint-*.tar.gz | head -1)
check "rotated logs are not backed up" '! tar -tzf "$latest" | grep -q "\.log\.1\.gz"'

# 4. Age: encrypted offsite copy when a recipient is set and age exists...
print -r -- '#!/bin/sh
# fake age: -r <recipient> -o <out>, reads stdin
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
{ echo "age-encryption.org/v1 (fake)"; cat; } > "$out"' > "$fx/bin/age"; chmod +x "$fx/bin/age"
run FLINT_BACKUP_TS=20261001-0004 FLINT_BACKUP_AGE_RECIPIENT=age1testrecipient >/dev/null
check "offsite copy is .age" 'ls "$fx/icloud/FlintBackups" | grep -q "\.tar\.gz\.age$"'
check "it went through age" 'head -c 28 "$(ls -t "$fx/icloud/FlintBackups"/*.age | head -1)" | grep -q "age-encryption.org/v1"'
# ...and NO offsite copy (rather than a plaintext one) when age is missing.
rm "$fx/bin/age"; before=$(ls "$fx/icloud/FlintBackups" | wc -l | tr -d ' ')
run FLINT_BACKUP_TS=20261001-0005 FLINT_BACKUP_AGE_RECIPIENT=age1testrecipient PATH="$fx/bin:/usr/bin:/bin" >/dev/null || true
check "no plaintext fallback" '[ "$(ls "$fx/icloud/FlintBackups" | wc -l | tr -d " ")" = "$before" ]'
check "and it said why" 'grep -q "offsite SKIPPED: FLINT_BACKUP_AGE_RECIPIENT is set but age is not installed" "$fx/err.log"'

(( fail )) && exit 1
print "ok: prune (no head -n 0), rotation, and age-only offsite all behave"
