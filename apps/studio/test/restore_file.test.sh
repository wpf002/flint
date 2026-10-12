#!/bin/zsh
# restore_file.sh, on a fixture ~/.flint and ~/FlintBackups, with a stand-in for
# launchctl and a pseudo-terminal for the confirmation: nothing here reaches
# launchd or the real Flint. Run: zsh apps/studio/test/restore_file.test.sh
#
# What must hold:
#  - it restores only the three files it names, from the newest backup that holds a readable copy;
#  - it asks first, at a terminal: nothing can be piped in to answer for the owner;
#  - the file as it was is kept beside the restored one, never deleted;
#  - the server is stopped while the file is swapped and started again afterwards.
set -u
here=${0:A:h}
script="$here/../restore_file.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

bin="$fx/bin"; mkdir -p "$bin"
print -r -- '#!/bin/zsh
print -r -- "launchctl $* [knowledge: $(head -c 40 "$HOME/.flint/memory/knowledge.json" 2>/dev/null)]" >> "$FX/calls.log"
exit 0' > "$bin/launchctl"; chmod +x "$bin/launchctl"

home="$fx/home"; data="$home/.flint"; backups="$fx/FlintBackups"
snapshot() { # <timestamp> : an archive of the data folder as it is now
  ( cd "$data" && tar -czf "$backups/flint-$1.tar.gz" . ); chmod 600 "$backups/flint-$1.tar.gz"
}
fresh() {
  rm -rf "$home" "$backups" "$fx/calls.log"
  mkdir -p "$data/memory" "$home/Library/LaunchAgents" "$backups"; chmod 700 "$data" "$backups"
  : > "$home/Library/LaunchAgents/com.flint.server.plist"
  print -r -- '{"facts":["two nights ago"]}' > "$data/memory/knowledge.json"
  print -r -- '{"conversations":{"c":"old"}}' > "$data/memory/conversations.json"
  print -r -- '[{"note":"old"}]' > "$data/notifications.json"
  snapshot 20261010-0230
  print -r -- '{"facts":["last night"]}' > "$data/memory/knowledge.json"
  snapshot 20261011-0230
  print -r -- 'this is not json {{{' > "$data/memory/knowledge.json"   # the damage
}
# Run it at a pseudo-terminal and type <answer> when it asks (expect waits for the question itself).
print -r -- 'set timeout 30
spawn -noecho /usr/bin/env -i HOME=$env(T_HOME) FX=$env(T_FX) PATH=$env(T_PATH) FLINT_BACKUP_DIR=$env(T_BACKUPS) /bin/zsh $env(T_SCRIPT) {*}$argv
expect {
  "Type RESTORE to continue: " { send -- "$env(T_ANSWER)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]' > "$fx/terminal.exp"
at_terminal() { local answer=$1; shift
  out="$( { T_HOME="$home" T_FX="$fx" T_PATH="$bin:/usr/bin:/bin" T_BACKUPS="$backups" T_SCRIPT="$script" T_ANSWER="$answer" /usr/bin/expect "$fx/terminal.exp" "$@"; print -r -- $? > "$fx/status"; } 2>&1 | tr -d '\r')"
  st="$(<"$fx/status")"
}
piped() { out="$(print -r -- RESTORE | env -i HOME="$home" FX="$fx" PATH="$bin:/usr/bin:/bin" FLINT_BACKUP_DIR="$backups" /bin/zsh "$script" "$@" 2>&1)"; st=$?; }

# 1. The damaged memory file comes back from last night's backup; the damaged one is kept.
fresh; at_terminal RESTORE memory
check "it succeeds" '[ "$st" = 0 ]'
check "memory is last night's copy" '[ "$(<"$data/memory/knowledge.json")" = "{\"facts\":[\"last night\"]}" ]'
kept=("$data"/memory/knowledge.json.before-restore-*(N))
check "the damaged file is kept beside it, private" '(( ${#kept} == 1 )) && grep -q "this is not json" "$kept[1]" && [ "$(stat -f %Lp "$kept[1]")" = 600 ] && [ "$(stat -f %Lp "$data/memory/knowledge.json")" = 600 ]'
check "it said which backup, and that nothing is lost, before asking" '[[ "$out" == *"The newest readable copy of Flint'"'"'s memory of you is from the backup made on 2026-10-11 at 02:30."*"The file as it is now is kept beside it, so nothing is lost."*"Type RESTORE to continue:"* ]]'
check "it said where the old file is" '[[ "$out" == *"The file as it was is kept as knowledge.json.before-restore-"*", in the same folder."* ]]'
check "the server was stopped before the swap and started after it" '[ "$(sed -n 1p "$fx/calls.log")" = "launchctl unload $home/Library/LaunchAgents/com.flint.server.plist [knowledge: this is not json {{{]" ] && [ "$(sed -n 2p "$fx/calls.log")" = "launchctl load -w $home/Library/LaunchAgents/com.flint.server.plist [knowledge: {\"facts\":[\"last night\"]}]" ]'
check "the other files were not touched" '[ "$(<"$data/notifications.json")" = "[{\"note\":\"old\"}]" ] && [ "$(<"$data/memory/conversations.json")" = "{\"conversations\":{\"c\":\"old\"}}" ]'
check "no working copy is left behind" '! ls "${TMPDIR:-/tmp}" | grep -q "^flint-restore-file\."'

# 2. Anything but RESTORE changes nothing.
fresh; at_terminal restore memory
check "a different answer changes nothing" '[ "$st" = 1 ] && [[ "$out" == *"Nothing was changed."* ]] && grep -q "this is not json" "$data/memory/knowledge.json" && [ ! -e "$fx/calls.log" ]'
fresh; at_terminal "" memory
check "an empty answer changes nothing" '[ "$st" = 1 ] && grep -q "this is not json" "$data/memory/knowledge.json"'

# 3. Not at a terminal: refused, whatever is piped in.
fresh; piped memory
check "with RESTORE piped in it refuses" '[ "$st" = 1 ] && [[ "$out" == "Run this yourself in Terminal: it asks you to confirm before it changes anything." ]] && grep -q "this is not json" "$data/memory/knowledge.json" && [ ! -e "$fx/calls.log" ]'

# 4. A backup whose copy is itself unreadable is passed over for the one before.
fresh; snapshot 20261012-0230; at_terminal RESTORE memory
check "a backup holding the damaged file is passed over" '[ "$st" = 0 ] && [ "$(<"$data/memory/knowledge.json")" = "{\"facts\":[\"last night\"]}" ] && [[ "$out" == *"from the backup made on 2026-10-11 at 02:30."* ]]'
fresh; rm "$backups"/*; at_terminal RESTORE memory
check "with no backup holding a readable copy it says so and changes nothing" '[ "$st" = 1 ] && [[ "$out" == *"None of the backups on this Mac holds a readable copy of that file. Nothing was changed."* ]] && grep -q "this is not json" "$data/memory/knowledge.json"'

# 5. The other two files, and only the three.
fresh; print -r -- 'damaged' > "$data/notifications.json"; at_terminal RESTORE notifications
check "notes come back too" '[ "$st" = 0 ] && [ "$(<"$data/notifications.json")" = "[{\"note\":\"old\"}]" ] && [[ "$out" == *"your notes"* ]]'
fresh; rm "$data/memory/conversations.json"; at_terminal RESTORE history
check "a file that is missing altogether comes back, with nothing to keep" '[ "$st" = 0 ] && [ "$(<"$data/memory/conversations.json")" = "{\"conversations\":{\"c\":\"old\"}}" ] && [[ "$out" != *"kept as"* ]]'
for bad in secrets.env ../../etc/passwd memory/knowledge.json '' '-h'; do
  fresh; at_terminal RESTORE "$bad"
  check "it restores only the files it names (asked for: ${bad:-nothing})" '[ "$st" = 1 ] && [[ "$out" == *"Say which file to restore: memory, history or notifications."* ]] && [ ! -e "$fx/calls.log" ]'
done
fresh; at_terminal RESTORE memory history
check "one file at a time" '[ "$st" = 1 ] && [[ "$out" == *"Say which file to restore"* ]]'
bad="$(fresh; at_terminal RESTORE memory; print -r -- "$out" | grep -vE "^[A-Z].*[.:]$|^Type RESTORE to continue: RESTORE$|^RESTORE$|^$" || true)"
check "every line it prints is a sentence" '[[ -z $bad ]]'

(( fail )) && exit 1
print "ok: one file comes back from the newest readable backup, only after RESTORE is typed at a terminal, and the old file is kept"
