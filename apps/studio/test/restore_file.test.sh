#!/bin/zsh
# restore_file.sh, on a fixture ~/.flint and ~/FlintBackups, with a stand-in for
# launchctl, a stand-in for the server's process, and a pseudo-terminal for the
# confirmation: nothing here reaches launchd or the real Flint.
# Run: zsh apps/studio/test/restore_file.test.sh
#
# What must hold:
#  - it restores only the three files it names, and says what every backup holds;
#  - a copy that is valid but emptied is never offered by default: the newest
#    backup that does not hold less than half of an older one is, and it says
#    which it passed over and why;
#  - a date at the end chooses that day's backup, and anything else there is refused;
#  - it asks first, at a terminal: nothing can be piped in to answer for the owner;
#  - the file as it was is kept beside the restored one, never deleted;
#  - the server's process is gone before the file is swapped, so it cannot save
#    over the copy on its way out, and the server is started again however the
#    run ends: a refusal, a failure after the stop, Control-C.
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
set -u
here=${0:A:h}
script="$here/../restore_file.sh"
fx=$(mktemp -d)
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

bin="$fx/bin"; mkdir -p "$bin"
home="$fx/home"; data="$home/.flint"; backups="$fx/FlintBackups"; tmp="$fx/tmp"
plist="$home/Library/LaunchAgents/com.flint.server.plist"

# A stand-in for launchctl. Whether the server's job is loaded is the file
# $FX/loaded. Like launchd it does not wait: unload tells the server's process
# to stop and returns at once, and a load can be refused while the job is still
# being let go. load and unload are written to $FX/calls.log, with the start of
# the memory file as it was at that moment, and the mode of the script's
# working folder.
cat > "$bin/launchctl" <<'STUB'
#!/bin/zsh
pidfile="$FX/server.pid"
alive() { [[ -r $pidfile ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; }
row() { print -r -- "$1"$'\t'"$2"$'\t'"$3"; }
record() {
  local d modes=
  for d in "${TMPDIR:-/nowhere}"/flint-restore-file.*(N/); do modes+="$(stat -f %Lp "$d")"; done
  print -r -- "launchctl $* [knowledge: $(head -c 40 "$HOME/.flint/memory/knowledge.json" 2>/dev/null)] [work: $modes]" >> "$FX/calls.log"
}
case ${1:-} in
  list)
    row PID Status Label
    row 412 0 com.example.other
    if [[ -e $FX/loaded ]]; then
      if alive; then row "$(<"$pidfile")" 0 com.flint.server; else row - 0 com.flint.server; fi
    fi ;;
  unload) record "$@"; rm -f "$FX/loaded"; alive && kill -TERM "$(<"$pidfile")" ;;
  load)
    record "$@"
    [[ -e $FX/load-fails ]] && exit 0
    # The first loads are refused, as many as $FX/load-refusals says.
    left=0; [[ -r $FX/load-refusals ]] && left="$(<"$FX/load-refusals")"
    if (( left > 0 )); then print -r -- $(( left - 1 )) > "$FX/load-refusals"; exit 0; fi
    : > "$FX/loaded" ;;
esac
exit 0
STUB
chmod +x "$bin/launchctl"

# A stand-in for the server's process, run as: zsh ~/.flint/server.mjs <how it stops>.
#   lingers   takes a second to stop, and saves what it holds in memory on the way out
#   stubborn  does not stop when asked
cat > "$fx/server.mjs" <<'FAKE'
case ${1:-} in
  lingers) trap 'sleep 1; print -r -- "{\"savedAt\":3,\"seq\":0,\"facts\":[],\"rejected\":[]}" > "$HOME/.flint/memory/knowledge.json"; exit 0' TERM ;;
  stubborn) trap "" TERM ;;
esac
while :; do sleep 0.1; done
FAKE
# It runs from ~/.flint/server.mjs, as the real one does, unless a test moves it
# ($fake_path): then only launchd's own record says which process the server is.
is_fake() { [[ $1 =~ '^[0-9]+$' ]] && ps -o command= -p "$1" 2>/dev/null | grep -qF -- "$fake_path"; }
start_fake() { # <lingers|stubborn>: started detached, so like the real one it is nobody's child here
  local i
  ( HOME="$home" /bin/zsh "$fake_path" "$1" >/dev/null 2>&1 </dev/null & print -r -- $! > "$fx/server.pid" )
  for i in {1..50}; do is_fake "$(<"$fx/server.pid")" && return 0; sleep 0.1; done
  return 1
}
stop_fake() { # only the process this test started
  local pid
  [[ -r $fx/server.pid ]] || return 0
  pid="$(<"$fx/server.pid")"
  is_fake "$pid" && kill -KILL "$pid" 2>/dev/null
  rm -f "$fx/server.pid"
}
fake_gone() { local i; for i in {1..40}; do is_fake "$(<"$fx/server.pid")" || return 0; sleep 0.1; done; return 1; }
fake_path="$data/server.mjs"
trap 'stop_fake; chmod -R u+rwx "$fx" 2>/dev/null; rm -rf "${fx:?}"' EXIT

# The three files, in the shapes the server writes.
knowledge() { # <facts> <word>
  local i out="{\"savedAt\":1,\"seq\":$1,\"facts\":["
  for (( i = 1; i <= $1; i++ )); do
    out+="{\"id\":\"k$i\",\"text\":\"$2 fact $i\",\"source\":\"user\",\"ts\":1,\"supersededBy\":null,\"vector\":[0.25,0.5]}"
    (( i < $1 )) && out+=","
  done
  print -r -- "$out],\"rejected\":[]}"
}
history_file() { # <turns> <word>: one conversation, however many turns
  local i out="{\"schemaVersion\":1,\"savedAt\":1,\"conversations\":{\"console\":["
  for (( i = 1; i <= $1; i++ )); do
    out+="{\"id\":\"t$i\",\"conversationId\":\"console\",\"status\":\"complete\",\"messages\":[{\"role\":\"user\",\"content\":\"$2 message $i\"}],\"createdAt\":1,\"updatedAt\":1}"
    (( i < $1 )) && out+=","
  done
  print -r -- "$out]}}"
}
notes() { # <notes> <word>
  local i out="{\"savedAt\":1,\"seq\":$1,\"items\":["
  for (( i = 1; i <= $1; i++ )); do
    out+="{\"id\":\"n$i\",\"title\":\"$2 note $i\",\"body\":\"b\",\"kind\":\"k\",\"ts\":1,\"read\":false}"
    (( i < $1 )) && out+=","
  done
  print -r -- "$out],\"seen\":[]}"
}
# What the server leaves after it started fresh on a file it could not read: valid, and nearly empty.
emptied() { print -r -- '{"savedAt":2,"seq":1,"facts":[{"id":"k1","text":"the only thing Flint knows now","source":"user","ts":2,"vector":[]}],"rejected":[]}'; }
knowledge 3 "two nights ago" > "$fx/two-nights.json"
knowledge 4 "last night" > "$fx/last-night.json"
history_file 2 old > "$fx/history.json"
notes 2 old > "$fx/notes.json"

snapshot() { # <timestamp> : an archive of the data folder as it is now
  ( cd "$data" && tar -czf "$backups/flint-$1.tar.gz" . ); chmod 600 "$backups/flint-$1.tar.gz"
}
fresh() {
  stop_fake
  chmod -R u+rwx "$home" 2>/dev/null
  rm -rf "${home:?}" "${backups:?}" "${tmp:?}"
  rm -f "$fx/calls.log" "$fx/loaded" "$fx/load-fails" "$fx/load-refusals"
  mkdir -p "$data/memory" "$home/Library/LaunchAgents" "$backups" "$tmp"; chmod 700 "$data" "$backups" "$tmp"
  : > "$plist"; : > "$fx/loaded"
  cp "$fx/server.mjs" "$data/server.mjs"
  cp "$fx/two-nights.json" "$data/memory/knowledge.json"
  cp "$fx/history.json" "$data/memory/conversations.json"
  cp "$fx/notes.json" "$data/notifications.json"
  snapshot 20261010-0230
  cp "$fx/last-night.json" "$data/memory/knowledge.json"
  snapshot 20261011-0230
  print -r -- 'this is not json {{{' > "$data/memory/knowledge.json"   # the damage
  wait_s=5 interrupt=0 fake_path="$data/server.mjs"
}
# Run it at a pseudo-terminal and type <answer> when it asks (expect waits for the question itself).
# With T_INTERRUPT=1 it presses Control-C once the script says it is stopping the server.
cat > "$fx/terminal.exp" <<'EXPECT'
set timeout 60
spawn -noecho /usr/bin/env -i HOME=$env(T_HOME) FX=$env(T_FX) PATH=$env(T_PATH) TMPDIR=$env(T_TMP) FLINT_BACKUP_DIR=$env(T_BACKUPS) FLINT_RESTORE_STOP_WAIT=$env(T_WAIT) /bin/zsh $env(T_SCRIPT) {*}$argv
expect {
  "Type RESTORE to continue: " { send -- "$env(T_ANSWER)\r"; exp_continue }
  "Flint is stopping its server to swap the file." { if {$env(T_INTERRUPT) eq "1"} { after 500; send -- "\003" }; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
EXPECT
all=
at_terminal() { local answer=$1; shift
  out="$( { T_HOME="$home" T_FX="$fx" T_PATH="$bin:/usr/bin:/bin" T_TMP="$tmp" T_BACKUPS="$backups" T_SCRIPT="$script" T_ANSWER="$answer" T_WAIT="$wait_s" T_INTERRUPT="$interrupt" /usr/bin/expect "$fx/terminal.exp" "$@"; print -r -- $? > "$fx/status"; } 2>&1 | tr -d '\r')"
  st="$(<"$fx/status")"
  all+="$out"$'\n'
}
piped() { out="$(print -r -- RESTORE | env -i HOME="$home" FX="$fx" PATH="$bin:/usr/bin:/bin" TMPDIR="$tmp" FLINT_BACKUP_DIR="$backups" /bin/zsh "$script" "$@" 2>&1)"; st=$?; }
restored() { cmp -s "$data/memory/knowledge.json" "$fx/$1.json"; }
untouched() { grep -q "this is not json" "$data/memory/knowledge.json" && [[ -z "$(print -l "$data"/memory/knowledge.json.before-restore-*(N))" ]]; }
call() { sed -n "$1p" "$fx/calls.log" 2>/dev/null; }
unloaded_then_loaded() { [[ "$(call 1)" == "launchctl unload $plist "* && "$(call 2)" == "launchctl load -w $plist "* && -z "$(call 3)" ]]; }
no_working_copy() { [[ -z "$(ls -A "$tmp")" ]]; }

# 1. The damaged memory file comes back from last night's backup; the damaged one is kept.
fresh; at_terminal RESTORE memory
check "it succeeds" '[ "$st" = 0 ]'
check "memory is last night's copy" 'restored last-night'
kept=("$data"/memory/knowledge.json.before-restore-*(N))
check "the damaged file is kept beside it, private" '(( ${#kept} == 1 )) && grep -q "this is not json" "$kept[1]" && [ "$(stat -f %Lp "$kept[1]")" = 600 ] && [ "$(stat -f %Lp "$data/memory/knowledge.json")" = 600 ]'
check "it said what every backup holds, oldest first" '[[ "$out" == *"The backup from 2026-10-10 at 02:30 holds 3 facts ("*" bytes)."*"The backup from 2026-10-11 at 02:30 holds 4 facts ("*" bytes)."* ]]'
check "it said the file as it is now cannot be read" '[[ "$out" == *"The file as it is now cannot be read."* ]]'
check "it said which backup, how to choose another, and that nothing is lost, before asking" '[[ "$out" == *"The newest readable copy of Flint'"'"'s memory of you is from the backup made on 2026-10-11 at 02:30. It is "*"To restore the copy from another day instead, run this again with that day at the end:"*"  ~/flint/apps/studio/restore_file.sh memory 2026-10-10"*"The file as it is now is kept beside it, so nothing is lost."*"Type RESTORE to continue:"* ]]'
check "nothing was passed over" '[[ "$out" != *"passed over"* ]]'
check "it said where the old file is" '[[ "$out" == *"The copy from 2026-10-11 at 02:30 is in place, and Flint is starting again."*"The file as it was is kept as knowledge.json.before-restore-"*", in the same folder."* ]]'
check "the server was stopped before the swap and started after it" '[[ "$(call 1)" == "launchctl unload $plist [knowledge: this is not json {{{] "* && "$(call 2)" == "launchctl load -w $plist [knowledge: $(head -c 40 "$fx/last-night.json")] "* && -z "$(call 3)" ]]'
check "the other files were not touched" 'cmp -s "$data/notifications.json" "$fx/notes.json" && cmp -s "$data/memory/conversations.json" "$fx/history.json"'
check "its working folder was in TMPDIR, private, while it ran" '[[ "$(call 1)" == *"[work: 700]" ]]'
check "no working copy is left behind" 'no_working_copy'

# 2. Anything but RESTORE changes nothing.
fresh; at_terminal restore memory
check "a different answer changes nothing" '[ "$st" = 1 ] && [[ "$out" == *"Nothing was changed."* ]] && untouched && [ ! -e "$fx/calls.log" ] && no_working_copy'
fresh; at_terminal "" memory
check "an empty answer changes nothing" '[ "$st" = 1 ] && untouched && [ ! -e "$fx/calls.log" ]'

# 3. Not at a terminal: refused, whatever is piped in.
fresh; piped memory
check "with RESTORE piped in it refuses" '[ "$st" = 1 ] && [[ "$out" == "Run this yourself in Terminal: it asks you to confirm before it changes anything." ]] && untouched && [ ! -e "$fx/calls.log" ]'

# 4. A backup whose copy cannot be read is passed over for the one before.
fresh; snapshot 20261012-0230; at_terminal RESTORE memory
check "a backup holding the damaged file is passed over" '[ "$st" = 0 ] && restored last-night && [[ "$out" == *"The backup from 2026-10-12 at 02:30 holds no readable copy."*"from the backup made on 2026-10-11 at 02:30."* ]]'
fresh; rm "$backups"/*; at_terminal RESTORE memory
check "with no backup holding a readable copy it says so and changes nothing" '[ "$st" = 1 ] && [[ "$out" == *"None of the backups on this Mac holds a readable copy of that file. Nothing was changed."* ]] && untouched && no_working_copy'

# 5. The server started fresh on the damaged file and saved a valid, nearly empty one,
#    and last night's backup took it. That copy is never the one offered.
fresh; emptied > "$data/memory/knowledge.json"; snapshot 20261012-0230; at_terminal RESTORE memory
check "an emptied memory file in the newest backup is passed over for the full one before it" '[ "$st" = 0 ] && restored last-night'
check "it said what the emptied copy and the file now hold" '[[ "$out" == *"The backup from 2026-10-12 at 02:30 holds 1 fact ("*"The file as it is now holds 1 fact ("* ]]'
check "it said which backup it passed over, with the numbers, and the rule" '[[ "$out" == *"Flint passed over the backup from 2026-10-12 at 02:30: its copy holds 1 fact, and an older one holds 4 facts."*"A copy that holds less than half of what an older copy holds has usually been emptied, so Flint passes it over."*"Flint chose the copy from the backup made on 2026-10-11 at 02:30. It is "* ]]'
kept=("$data"/memory/knowledge.json.before-restore-*(N))
check "the emptied file is kept beside it" '(( ${#kept} == 1 )) && grep -q "the only thing Flint knows now" "$kept[1]"'
fresh; emptied > "$data/memory/knowledge.json"; snapshot 20261012-0230; knowledge 1 "since" > "$data/memory/knowledge.json"; snapshot 20261013-0230; at_terminal RESTORE memory
check "several emptied nights in a row are all passed over" '[ "$st" = 0 ] && restored last-night && [[ "$out" == *"Flint passed over the backup from 2026-10-13 at 02:30:"*"Flint passed over the backup from 2026-10-12 at 02:30:"* ]]'
fresh; knowledge 2 "half" > "$data/memory/knowledge.json"; snapshot 20261012-0230; at_terminal RESTORE memory
check "a copy holding exactly half is not passed over" '[ "$st" = 0 ] && [[ "$out" != *"passed over"* ]] && [[ "$out" == *"from the backup made on 2026-10-12 at 02:30."* ]] && grep -q "half fact 2" "$data/memory/knowledge.json"'

# 6. A date at the end chooses that day's backup.
fresh; emptied > "$data/memory/knowledge.json"; snapshot 20261012-0230; at_terminal RESTORE memory 2026-10-10
check "a date chooses the backup from that day" '[ "$st" = 0 ] && restored two-nights && [[ "$out" == *"The copy you asked for is from the backup made on 2026-10-10 at 02:30. It is "* ]] && [[ "$out" != *"passed over"* && "$out" != *"Take care"* ]]'
fresh; emptied > "$data/memory/knowledge.json"; snapshot 20261012-0230; at_terminal RESTORE memory 2026-10-12
check "a date can choose a copy Flint would pass over, and it says to take care" '[ "$st" = 0 ] && grep -q "the only thing Flint knows now" "$data/memory/knowledge.json" && [[ "$out" == *"The copy you asked for is from the backup made on 2026-10-12 at 02:30."*"Take care with it: it holds less than half of what an older copy holds, so it may have been emptied."* ]]'
fresh; knowledge 5 "late" > "$data/memory/knowledge.json"; snapshot 20261011-2200; at_terminal RESTORE memory 2026-10-11
check "with two backups from that day it takes the later one" '[ "$st" = 0 ] && grep -q "late fact 5" "$data/memory/knowledge.json" && [[ "$out" == *"from the backup made on 2026-10-11 at 22:00."* ]]'
fresh; at_terminal RESTORE memory 2026-10-09
check "a day with no backup is refused, and nothing changes" '[ "$st" = 1 ] && [[ "$out" == *"There is no backup from 2026-10-09 on this Mac. Nothing was changed."* ]] && untouched && [ ! -e "$fx/calls.log" ]'
fresh; snapshot 20261012-0230; at_terminal RESTORE memory 2026-10-12
check "a day whose backup holds no readable copy is refused" '[ "$st" = 1 ] && [[ "$out" == *"The backup from 2026-10-12 holds no readable copy of that file. Nothing was changed."* ]] && untouched'
for bad in 20261010 2026-13-01 2026-10-32 2026-1-1 yesterday '2026-10-10 ' '2026-10-10;id' '../2026-10-10' history; do
  fresh; at_terminal RESTORE memory "$bad"
  check "anything that is not a date is refused (given: $bad)" '[ "$st" = 1 ] && [[ "$out" == *"Write the backup'"'"'s day as year-month-day, like 2026-10-10. Nothing was changed."* ]] && [[ "$out" != *"reading the backups"* ]] && untouched && [ ! -e "$fx/calls.log" ]'
done

# 7. The server takes a second to stop and saves what it holds on the way out. The swap waits for it.
fresh; start_fake lingers; pid="$(<"$fx/server.pid")"; at_terminal RESTORE memory; fake_gone
check "it waits for the server's process to be gone before it swaps the file" '[ "$st" = 0 ] && restored last-night && ! is_fake "$pid"'
check "it said it was stopping the server" '[[ "$out" == *"Flint is stopping its server to swap the file."*"is in place, and Flint is starting again."* ]]'
kept=("$data"/memory/knowledge.json.before-restore-*(N))
check "what the server saved on its way out is what is kept, not what is live" '(( ${#kept} == 1 )) && grep -q "\"savedAt\":3" "$kept[1]"'
check "the server is loaded again" 'unloaded_then_loaded && [ -e "$fx/loaded" ]'

fresh; fake_path="$fx/bundle-elsewhere.mjs"; cp "$fx/server.mjs" "$fake_path"; start_fake lingers; pid="$(<"$fx/server.pid")"; at_terminal RESTORE memory; fake_gone
check "a server run from somewhere else is waited for too: launchd says which process it is" '[ "$st" = 0 ] && restored last-night && ! is_fake "$pid"'

# 8. The server never stops: refused, nothing swapped, and the server is loaded again.
fresh; start_fake stubborn; wait_s=1; at_terminal RESTORE memory
check "a server that does not stop is refused, and the file is not swapped" '[ "$st" = 1 ] && [[ "$out" == *"Flint'"'"'s server did not stop, so the file was not swapped. Nothing was changed."* ]] && untouched'
check "and the server is loaded again" 'unloaded_then_loaded && [ -e "$fx/loaded" ] && [[ "$out" == *"Flint'"'"'s server is running."* ]] && no_working_copy'

# 9. A failure after the server was stopped: the server is still loaded again.
fresh; chmod 500 "$data/memory"; at_terminal RESTORE memory; chmod 700 "$data/memory"
check "when the file cannot be set aside it says so and changes nothing" '[ "$st" = 1 ] && [[ "$out" == *"Flint could not set the current file aside. Nothing was changed."* ]] && untouched'
check "and the server is loaded again" 'unloaded_then_loaded && [ -e "$fx/loaded" ] && [[ "$out" == *"Flint'"'"'s server is running."* ]] && no_working_copy'

# 10. Control-C while it waits for the server: the same.
fresh; start_fake stubborn; wait_s=20 interrupt=1; at_terminal RESTORE memory
check "Control-C while it waits changes nothing" '[ "$st" = 130 ] && untouched'
check "and the server is loaded again" 'unloaded_then_loaded && [ -e "$fx/loaded" ] && [[ "$out" == *"Flint'"'"'s server is running."* ]] && no_working_copy'

# 11. launchd does not take the server back: the copy stays, and it gives the command.
fresh; : > "$fx/load-fails"; at_terminal RESTORE memory
check "when the server does not start again it says so, with the command, and fails" '[ "$st" = 1 ] && restored last-night && [[ "$out" == *"The copy from 2026-10-11 at 02:30 is in place, but Flint'"'"'s server did not start again."*"Start it with this command:"*"  launchctl load -w ~/Library/LaunchAgents/com.flint.server.plist"*"The file as it was is kept as"* ]]'
fresh; print -r -- 2 > "$fx/load-refusals"; at_terminal RESTORE memory
check "a load that launchd refuses at first is asked for again until it holds" '[ "$st" = 0 ] && restored last-night && [ -e "$fx/loaded" ] && [[ "$(call 2)" == "launchctl load -w "* && "$(call 4)" == "launchctl load -w "* && -z "$(call 5)" ]] && [[ "$out" == *"is in place, and Flint is starting again."* ]]'
fresh; rm "$plist" "$fx/loaded"; at_terminal RESTORE memory
check "with no server LaunchAgent it swaps the file and loads nothing" '[ "$st" = 0 ] && restored last-night && [ ! -e "$fx/calls.log" ] && [[ "$out" == *"The copy from 2026-10-11 at 02:30 is in place."* && "$out" != *"starting again"* ]]'

# 12. The other two files, and only the three.
fresh; print -r -- 'damaged' > "$data/notifications.json"; at_terminal RESTORE notifications
check "notes come back too" '[ "$st" = 0 ] && cmp -s "$data/notifications.json" "$fx/notes.json" && [[ "$out" == *"holds 2 notes ("*"your notes"* ]]'
fresh; rm "$data/memory/conversations.json"; at_terminal RESTORE history
check "a file that is missing altogether comes back, with nothing to keep" '[ "$st" = 0 ] && cmp -s "$data/memory/conversations.json" "$fx/history.json" && [[ "$out" == *"holds 1 conversation ("*"That file is missing from Flint now."* ]] && [[ "$out" != *"kept as"* && "$out" != *"kept beside"* ]]'
# History is compared by size: one conversation can hold everything, so their number says little.
fresh; history_file 40 long > "$data/memory/conversations.json"; cp "$data/memory/conversations.json" "$fx/long.json"; snapshot 20261012-0230
history_file 1 new > "$data/memory/conversations.json"; snapshot 20261013-0230; at_terminal RESTORE history
check "an emptied history with as many conversations is passed over, by size" '[ "$st" = 0 ] && cmp -s "$data/memory/conversations.json" "$fx/long.json" && [[ "$out" == *"Flint passed over the backup from 2026-10-13 at 02:30: its copy is "*" bytes, and an older one is "*" KB."*"from the backup made on 2026-10-12 at 02:30."* ]]'
for bad in secrets.env ../../etc/passwd memory/knowledge.json '' '-h'; do
  fresh; at_terminal RESTORE "$bad"
  check "it restores only the files it names (asked for: ${bad:-nothing})" '[ "$st" = 1 ] && [[ "$out" == *"Say which file to restore: memory, history or notifications."* ]] && [ ! -e "$fx/calls.log" ]'
done
fresh; at_terminal RESTORE memory 2026-10-10 history
check "one file at a time" '[ "$st" = 1 ] && [[ "$out" == *"Say which file to restore"* ]] && untouched'
fresh; mv "$data/memory/knowledge.json" "$fx/elsewhere.json"; ln -s "$fx/elsewhere.json" "$data/memory/knowledge.json"; at_terminal RESTORE memory
check "a link in the file's place is refused, and what it points at is left alone" '[ "$st" = 1 ] && [[ "$out" == *"The file to restore is a link to somewhere else, so Flint left it alone. Nothing was changed."* ]] && [ -L "$data/memory/knowledge.json" ] && grep -q "this is not json" "$fx/elsewhere.json" && [ ! -e "$fx/calls.log" ]'

# 13. Everything it printed, in every run above: a sentence, or a command on a line of its own.
bad="$(print -r -- "$all" | grep -vE "^[A-Z].*[.:]$|^Type RESTORE to continue: [A-Za-z]*$|^RESTORE$|^\^C$|^$|^  ~/flint/apps/studio/restore_file\.sh (memory|history|notifications)( [0-9]{4}-[0-9]{2}-[0-9]{2})?$|^  launchctl load -w ~/Library/LaunchAgents/com\.flint\.server\.plist$" || true)"
check "every line it prints is a sentence, or a command on its own line" '[[ -z $bad ]]'
[[ -n $bad ]] && print -r -- "$bad" | head -5

(( fail )) && exit 1
print "ok: one file comes back from the newest backup that was not emptied, or from the day asked for, only after RESTORE is typed at a terminal; the server is gone before the swap and loaded after it; and the old file is kept"
