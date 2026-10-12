#!/bin/zsh
# The nightly files backup tells what it did: one line for each archive it wrote,
# here or offsite, and one for each it could not write, with why. Also what it
# does about a full disk, a run stopped part way, two runs at once, and the
# catch-up at login (off unless it is switched on). All on a stand-in home folder.
# Run: zsh apps/studio/test/backup_events.test.sh
set -u
here=${0:A:h}
script="$here/../backup_flint.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

home="$fx/home"; data="$home/.flint"; events="$data/backup-events.jsonl"
mkdir -p "$data/memory" "$fx/icloud" "$fx/bin" "$fx/tools"
print -r -- '{"facts":[]}' > "$data/memory/knowledge.json"
print -r -- 'KEY=1' > "$data/secrets.env"
# A stand-in for age: -r <recipient> -o <out>, the archive on stdin. FAKE_AGE_FAILS makes it stop part way.
print -r -- '#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
if [ -n "${FAKE_AGE_FAILS:-}" ]; then head -c 10 > "$out"; exit 1; fi
{ echo "age-encryption.org/v1 (stand-in)"; cat; } > "$out"' > "$fx/tools/age"; chmod +x "$fx/tools/age"

run() { # [NAME=value ...] [-- script arguments]: HOME is the stand-in, so the script's data folder is $data
  local -a envs args; local seen=0 a
  for a in "$@"; do if [[ $a == -- ]]; then seen=1; elif (( seen )); then args+=("$a"); else envs+=("$a"); fi; done
  env -i HOME="$home" PATH="$fx/bin:/usr/bin:/bin:/usr/sbin:/sbin" FLINT_BACKUP_DIR="$fx/local" \
    FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" FLINT_BACKUP_MANIFEST="$fx/manifest.txt" FLINT_AGE_BIN="$fx/tools/age" \
    "${envs[@]}" /bin/zsh "$script" "${args[@]}" >"$fx/out.log" 2>"$fx/err.log"
}
lines() { [[ -f $events ]] && wc -l < "$events" | tr -d ' ' || print 0; }
last() { tail -n "${1:-1}" "$events" 2>/dev/null; }
field() { print -r -- "$1" | sed -nE "s/.*\"$2\":\"?([^\",}]*)\"?.*/\1/p"; }
# A line of the record, to the letter: its own fields in their order, and nothing else.
OK_LINE='^\{"id":"[0-9a-f]{32}","at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","kind":"flint_tar","location":"(local|icloud)","outcome":"ok","name":"flint-[0-9]{8}-[0-9]{4}\.tar\.gz(\.age)?","bytes":[0-9]+,"sha256":"[0-9a-f]{64}"\}$'
FAILED_LINE='^\{"id":"[0-9a-f]{32}","at":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z","kind":"flint_tar","location":"(local|icloud)","outcome":"failed","name":"flint-[0-9]{8}-[0-9]{4}\.tar\.gz(\.age)?","reason":"(space|archive|unreadable|encrypt|no_tool|no_folder|interrupted)"\}$'

# ---- 1. no key: the archive here is recorded, and nothing is said about offsite ---------------------
run FLINT_BACKUP_TS=20261001-0000
check "no key: the run succeeds" '[ $? = 0 ]'
check "no key: one line, for the archive here" '[ "$(lines)" = 1 ] && [[ "$(last)" =~ $OK_LINE ]] && [ "$(field "$(last)" location)" = local ]'
check "the line carries the archive's own size and fingerprint" '[ "$(field "$(last)" bytes)" = "$(stat -f %z "$fx/local/flint-20261001-0000.tar.gz")" ] && [ "$(field "$(last)" sha256)" = "$(shasum -a 256 "$fx/local/flint-20261001-0000.tar.gz" | cut -d" " -f1)" ]'
check "the record is 0600" '[ "$(stat -f %Lp "$events")" = 600 ]'
check "the archive is 0600 in a 0700 folder, and nothing part written is left" '[ "$(stat -f %Lp "$fx/local/flint-20261001-0000.tar.gz")" = 600 ] && [ "$(stat -f %Lp "$fx/local")" = 700 ] && [ -z "$(ls "$fx/local" | grep -v "\.tar\.gz$")" ]'
check "the lock is gone when the run ends" '[ ! -e "$data/backup.lock" ]'

# ---- 2. with a key: one line here, one offsite, each with its own file's size and fingerprint -------
print -r -- 'age1testrecipient' > "$data/backup-age-recipient"
run FLINT_BACKUP_TS=20261001-0001
check "with a key: two more lines" '[ "$(lines)" = 3 ]'
l="$(last 2 | head -1)"; o="$(last)"
check "the first is the archive here" '[[ "$l" =~ $OK_LINE ]] && [ "$(field "$l" location)" = local ] && [ "$(field "$l" name)" = flint-20261001-0001.tar.gz ]'
check "the second is the encrypted one offsite" '[[ "$o" =~ $OK_LINE ]] && [ "$(field "$o" location)" = icloud ] && [ "$(field "$o" name)" = flint-20261001-0001.tar.gz.age ]'
check "the offsite line's fingerprint is the encrypted file's" '[ "$(field "$o" sha256)" = "$(shasum -a 256 "$fx/icloud/FlintBackups/flint-20261001-0001.tar.gz.age" | cut -d" " -f1)" ] && [ "$(field "$o" bytes)" = "$(stat -f %z "$fx/icloud/FlintBackups/flint-20261001-0001.tar.gz.age")" ]'
check "no line holds a path or a folder" '! grep -q "/" "$events"'
check "each event has an id of its own" '[ "$(sed -nE "s/.*\"id\":\"([0-9a-f]{32})\".*/\1/p" "$events" | sort -u | wc -l | tr -d " ")" = 3 ]'

# ---- 3. the encryption fails: said so, nothing left offsite, and the archive here still counts -------
run FLINT_BACKUP_TS=20261001-0002 FAKE_AGE_FAILS=1
check "a failed encryption does not fail the run" '[ $? = 0 ]'
check "it is recorded as failed, with why" '[[ "$(last)" =~ $FAILED_LINE ]] && [ "$(field "$(last)" location)" = icloud ] && [ "$(field "$(last)" reason)" = encrypt ]'
check "nothing part written is left offsite" '[ ! -e "$fx/icloud/FlintBackups/flint-20261001-0002.tar.gz.age" ]'
check "and the archive here was recorded before it" '[ "$(field "$(last 2 | head -1)" outcome)" = ok ] && [ "$(field "$(last 2 | head -1)" name)" = flint-20261001-0002.tar.gz ]'

# ---- 4. a key but no age, and a key but no offsite folder: each a copy that was not made ------------
run FLINT_BACKUP_TS=20261001-0003 FLINT_AGE_BIN=/nonexistent/age
check "no age: recorded as failed, for want of the tool" '[ "$(field "$(last)" reason)" = no_tool ] && [ "$(field "$(last)" name)" = flint-20261001-0003.tar.gz.age ]'
run FLINT_BACKUP_TS=20261001-0004 FLINT_BACKUP_OFFSITE="$fx/not-here/FlintBackups"
check "no offsite folder: recorded as failed, for want of the folder" '[ "$(field "$(last)" reason)" = no_folder ] && [ "$(field "$(last)" location)" = icloud ]'
check "and the folder was not made" '[ ! -e "$fx/not-here" ]'

# ---- 5. not enough room: no archive is written, and the record says why ------------------------------
before="$(lines)"
run FLINT_BACKUP_TS=20261001-0005 FLINT_BACKUP_FREE_KB=4096
check "a full disk fails the run" '[ $? != 0 ]'
check "one line: the archive here failed for want of space" '[ "$(lines)" = $(( before + 1 )) ] && [[ "$(last)" =~ $FAILED_LINE ]] && [ "$(field "$(last)" location)" = local ] && [ "$(field "$(last)" reason)" = space ]'
check "no archive was written, whole or in part" '[ -z "$(ls "$fx/local" | grep 20261001-0005)" ]'
check "it said so in the log" 'grep -q "local SKIPPED: not enough free space" "$fx/err.log"'
check "the lock is gone after a run that failed" '[ ! -e "$data/backup.lock" ]'
# With room for twice the newest archive and the 1 GB floor, it runs.
run FLINT_BACKUP_TS=20261001-0006 FLINT_BACKUP_FREE_KB=2097152
check "with room, it runs" '[ $? = 0 ] && [ -f "$fx/local/flint-20261001-0006.tar.gz" ]'

# ---- 6. the archive cannot be made: never left under a snapshot's name, and recorded -----------------
# A stand-in tar that writes half a file and fails.
print -r -- '#!/bin/sh
for a in "$@"; do case "$prev" in -czf) out="$a";; esac; prev="$a"; done
[ -n "$out" ] && [ "$out" != - ] && printf "half" > "$out"
exit 1' > "$fx/bin/tar"; chmod +x "$fx/bin/tar"
before="$(lines)"
run FLINT_BACKUP_TS=20261001-0007
check "a tar that fails fails the run" '[ $? != 0 ]'
check "recorded as failed" '[ "$(lines)" = $(( before + 1 )) ] && [ "$(field "$(last)" reason)" = archive ] && [ "$(field "$(last)" name)" = flint-20261001-0007.tar.gz ]'
check "nothing is left under the snapshot's name, or part written" '[ -z "$(ls "$fx/local" | grep 20261001-0007)" ]'
# One that writes a file tar cannot list back.
print -r -- '#!/bin/sh
for a in "$@"; do case "$prev" in -czf) out="$a";; -tzf) exit 1;; esac; prev="$a"; done
[ -n "$out" ] && [ "$out" != - ] && printf "not an archive" > "$out"
exit 0' > "$fx/bin/tar"
run FLINT_BACKUP_TS=20261001-0008
check "an archive that cannot be listed is recorded as unreadable, and removed" '[ $? != 0 ] && [ "$(field "$(last)" reason)" = unreadable ] && [ -z "$(ls "$fx/local" | grep 20261001-0008)" ]'

# ---- 7. stopped part way: the part-written archive goes, and the record says it was interrupted ------
print -r -- '#!/bin/sh
for a in "$@"; do case "$prev" in -czf) out="$a";; esac; prev="$a"; done
[ -n "$out" ] && [ "$out" != - ] && printf "half" > "$out"
: > "$FAKE_TAR_STARTED"
sleep 2
exit 0' > "$fx/bin/tar"
before="$(lines)"
env -i HOME="$home" PATH="$fx/bin:/usr/bin:/bin:/usr/sbin:/sbin" FLINT_BACKUP_DIR="$fx/local" FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" \
  FLINT_BACKUP_MANIFEST="$fx/manifest.txt" FLINT_AGE_BIN="$fx/tools/age" FLINT_BACKUP_TS=20261001-0009 FAKE_TAR_STARTED="$fx/started" \
  /bin/zsh "$script" >"$fx/out.log" 2>"$fx/err.log" &
pid=$!
for i in {1..50}; do [[ -e $fx/started ]] && break; sleep 0.1; done
# While it runs: a second run stops at once and writes nothing.
run FLINT_BACKUP_TS=20261001-0010
check "a second run while one is going stops, saying so" '[ $? = 0 ] && grep -q "another backup is running" "$fx/out.log" && [ -z "$(ls "$fx/local" | grep 20261001-0010)" ]'
kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null; st=$?
check "a run that is stopped ends as stopped" '[ $st = 130 ]'
check "it is recorded as interrupted" '[ "$(lines)" = $(( before + 1 )) ] && [ "$(field "$(last)" reason)" = interrupted ] && [ "$(field "$(last)" name)" = flint-20261001-0009.tar.gz ]'
check "the part-written archive is gone" '[ -z "$(ls "$fx/local" | grep 20261001-0009)" ]'
check "and so is its lock" '[ ! -e "$data/backup.lock" ]'
rm -f "$fx/bin/tar" "$fx/started"

# ---- 8. a lock nobody holds: one six hours old is taken over, a fresh one is respected ---------------
mkdir "$data/backup.lock"
run FLINT_BACKUP_TS=20261001-0011
check "a fresh lock stops the run" 'grep -q "another backup is running" "$fx/out.log" && [ ! -e "$fx/local/flint-20261001-0011.tar.gz" ]'
touch -t "$(date -v-7H +%Y%m%d%H%M)" "$data/backup.lock"
run FLINT_BACKUP_TS=20261001-0012
check "a lock seven hours old is nobody's: the run goes ahead" '[ -f "$fx/local/flint-20261001-0012.tar.gz" ] && [ ! -e "$data/backup.lock" ]'

# A data folder that cannot be written to: no lock can be taken and no line written, and the archive is still made.
chmod 500 "$data"
run FLINT_BACKUP_TS=20261001-0013
chmod 700 "$data"
check "a data folder that cannot be written to is still backed up" '[ -f "$fx/local/flint-20261001-0013.tar.gz" ] && [ ! -e "$data/backup.lock" ]'

# ---- 9. the catch-up at login: off unless switched on, and only when a night was missed --------------
before="$(lines)"; count="$(ls "$fx/local" | wc -l | tr -d ' ')"
# Every archive here is made old, as after two nights off.
for f in "$fx"/local/flint-*.tar.gz; do touch -t "$(date -v-30H +%Y%m%d%H%M)" "$f"; done
run FLINT_BACKUP_TS=20261002-0900 -- --catch-up
check "off by default: a catch-up run does nothing at all" '[ $? = 0 ] && [ "$(lines)" = "$before" ] && [ "$(ls "$fx/local" | wc -l | tr -d " ")" = "$count" ] && [ ! -s "$fx/out.log" ]'
run FLINT_BACKUP_TS=20261002-0900 FLINT_BACKUP_CATCHUP=off -- --catch-up
check "switched off in so many words: nothing" '[ "$(lines)" = "$before" ]'
print -r -- 'FLINT_DB_BACKUP_URL=postgresql://nobody@localhost/none' > "$data/backup.env"; print -r -- 'FLINT_BACKUP_CATCHUP=on' >> "$data/backup.env"; chmod 600 "$data/backup.env"
run FLINT_BACKUP_TS=20261002-0900 -- --catch-up
check "switched on in the backup settings, with the newest archive 30 hours old: it catches up" '[ $? = 0 ] && [ -f "$fx/local/flint-20261002-0900.tar.gz" ] && [ "$(field "$(last 2 | head -1)" name)" = flint-20261002-0900.tar.gz ] && grep -q "catching up" "$fx/out.log"'
before="$(lines)"
run FLINT_BACKUP_TS=20261002-0905 -- --catch-up
check "with a good archive under 26 hours old there is nothing to catch up" '[ $? = 0 ] && [ "$(lines)" = "$before" ] && [ ! -e "$fx/local/flint-20261002-0905.tar.gz" ]'
run FLINT_BACKUP_TS=20261002-0906 FLINT_BACKUP_CATCHUP=off -- --catch-up
check "the environment, when it says, wins over the file" '[ ! -e "$fx/local/flint-20261002-0906.tar.gz" ]'
run FLINT_BACKUP_TS=20261002-0907 -- --everything
check "a word it does not know is refused, and nothing runs" '[ $? = 2 ] && [ ! -e "$fx/local/flint-20261002-0907.tar.gz" ]'
# The night's own run is not the catch-up: it runs whatever the switch says.
run FLINT_BACKUP_TS=20261002-0908 FLINT_BACKUP_CATCHUP=off
check "the night's own run does not ask the switch" '[ -f "$fx/local/flint-20261002-0908.tar.gz" ]'

# ---- 10. the writer refuses anything that is not its own: a line is never built from another string ---
(
  export HOME="$home" FLINT_BACKUP_DEFINE_ONLY=1
  source "$script"
  n="$(wc -l < "$EVENTS" | tr -d ' ')"
  backup_event local ok '../flint-20261001-0000.tar.gz' 10 "$(printf 'a%.0s' {1..64})"
  backup_event local ok 'flint-20261001-0000.tar.gz' '10; rm' "$(printf 'a%.0s' {1..64})"
  backup_event local ok 'flint-20261001-0000.tar.gz' 10 'not-a-hash'
  backup_event local ok 'flint-20261001-0000.tar.gz.age' 10 "$(printf 'a%.0s' {1..64})"
  backup_event icloud ok 'flint-20261001-0000.tar.gz' 10 "$(printf 'a%.0s' {1..64})"
  backup_event local failed 'flint-20261001-0000.tar.gz' 'tar: write error'
  backup_event elsewhere ok 'flint-20261001-0000.tar.gz' 10 "$(printf 'a%.0s' {1..64})"
  backup_event local ok 'flint-20261001-0000.tar.gz","x":"y' 10 "$(printf 'a%.0s' {1..64})"
  [[ "$(wc -l < "$EVENTS" | tr -d ' ')" == "$n" ]] || { print -r -- "FAIL the writer wrote a line it should have refused"; exit 1; }
  # And it takes away only its own unfinished file.
  print -r -- keep > "$fx/local/notes.txt"; print -r -- keep > "$fx/victim"
  drop_own "$fx/local" notes.txt; drop_own "$fx/local" "../victim"; drop_own "" "flint-20261001-0000.tar.gz"; drop_own "$fx/local" ""
  [[ "$(<"$fx/local/notes.txt")" == keep && "$(<"$fx/victim")" == keep && -f "$fx/local/flint-20261001-0000.tar.gz" ]] || { print -r -- "FAIL drop_own removed something that is not this run's own"; exit 1; }
) || fail=1
check "every line of the record is one of the two shapes" '! grep -vE "$OK_LINE|$FAILED_LINE" "$events"'
check "the script sets no snapshot name it did not check" '! grep -nE "rm -(r|rf|fr) " "$script"'

(( fail )) && exit 1
print "ok: each archive is recorded, here and offsite, ok or failed with why; a full disk, a stopped run and a second run are handled; the catch-up is off until switched on"
