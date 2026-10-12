#!/bin/zsh
# restore_file.sh: put one of Flint's own files back from a backup on this Mac.
#
# For when Flint's memory, chat history or notes file is damaged or has been
# emptied (docs/RECOVERY.md). Run it on the Studio, in Terminal:
#
#     ~/flint/apps/studio/restore_file.sh memory          what Flint has learned about you
#     ~/flint/apps/studio/restore_file.sh history         your conversations
#     ~/flint/apps/studio/restore_file.sh notifications   your notes
#
# and, to take the copy from one day's backup, with that day at the end:
#
#     ~/flint/apps/studio/restore_file.sh memory 2026-10-10
#
# It reads every nightly backup on this Mac (~/FlintBackups) and says what each
# holds: how many facts, conversations or notes, and how large the copy is.
#
# Which copy it offers. A copy that is valid but nearly empty is the danger: the
# server starts fresh on a file it cannot read and then saves a small, valid one,
# so the newest backup can hold the emptied file. So the newest copy is not
# taken on trust. A copy is passed over when it holds less than half of what an
# older copy holds (facts for memory, notes for notifications, size for
# history, where one conversation can hold everything), and the newest copy
# that is left is offered. It says which were passed over and why. A date at the
# end of the command overrides that: the copy from that day is offered, whatever
# it holds.
#
# It asks you to type RESTORE. The file as it is now is never deleted: it is
# kept beside the restored one, under a name ending in .before-restore-<time>.
# The server is stopped while the file is swapped (it keeps these files in
# memory and would write over the copy), the swap waits until the server's
# process is really gone, and the server is started again however this ends.
#
# It restores only the three files named above, by name: nothing you type is
# ever used as a path. Every line it prints is a sentence.
set -u
here=${0:A:h}
source "$here/recovery_lib.sh"
typeset -F SECONDS

DATA="$HOME/.flint"
LOCAL="${FLINT_BACKUP_DIR:-$HOME/FlintBackups}"
AGENTS="$HOME/Library/LaunchAgents"
TMP="${${TMPDIR:-/tmp}%/}"
LABEL=com.flint.server
plist="$AGENTS/$LABEL.plist"
# How long the server gets to stop before the file is swapped, in seconds. launchd
# kills a job that has not stopped when its exit timeout runs out (20 seconds
# unless the job's file says otherwise, and the server's does not), so 30 is
# past the longest real wait.
# (FLINT_RESTORE_STOP_WAIT is for the tests alone: they cannot wait that long.)
STOP_WAIT=30
[[ ${FLINT_RESTORE_STOP_WAIT:-} =~ '^[0-9]{1,3}$' ]] && STOP_WAIT=$FLINT_RESTORE_STOP_WAIT

usage=$'Say which file to restore: memory, history or notifications. For example:\n  ~/flint/apps/studio/restore_file.sh memory\nTo take the copy from one day\'s backup, add that day:\n  ~/flint/apps/studio/restore_file.sh memory 2026-10-10'
(( $# == 1 || $# == 2 )) || refuse "$usage"
# key: where the file keeps what it holds, and noun: what one of those is called.
# measure: what "less than half" is counted in (count: those things; size: bytes).
case $1 in
  memory) member=memory/knowledge.json what="Flint's memory of you" key=facts shape=array noun=fact measure=count ;;
  history) member=memory/conversations.json what="your conversation history" key=conversations shape=dictionary noun=conversation measure=size ;;
  notifications) member=notifications.json what="your notes" key=items shape=array noun=note measure=count ;;
  *) refuse "$usage" ;;
esac
kind=$1
day=
if (( $# == 2 )); then
  [[ $2 =~ '^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' ]] \
    || refuse "Write the backup's day as year-month-day, like 2026-10-10. Nothing was changed."
  day="$match[1]$match[2]$match[3]"
fi
[[ -d $DATA ]] || refuse "There is no Flint on this Mac."
[[ -t 0 && -t 1 ]] || refuse "Run this yourself in Terminal: it asks you to confirm before it changes anything."
target="$DATA/$member"
[[ -L $target ]] && refuse "The file to restore is a link to somewhere else, so Flint left it alone. Nothing was changed."

# ---- the server: stopping it, knowing it is gone, starting it again ---------------------

# The process launchd runs for the server, when there is one.
launchd_pid() {
  emulate -L zsh
  local pid st label
  launchctl list 2>/dev/null | while read -r pid st label; do
    [[ $label == $LABEL && $pid =~ '^[0-9]+$' ]] && print -r -- "$pid"
  done
  return 0
}
# Any process running this Flint's server bundle, however it was started.
bundle_pids() {
  emulate -L zsh
  local pid cmd
  /bin/ps -axww -o pid= -o command= 2>/dev/null | while read -r pid cmd; do
    [[ $cmd == *" $DATA/server.mjs" || $cmd == *" $DATA/server.mjs "* ]] && print -r -- "$pid"
  done
  return 0
}
server_listed() { # 0 when launchd has the server's job
  emulate -L zsh
  local pid st label
  launchctl list 2>/dev/null | while read -r pid st label; do
    [[ $label == $LABEL ]] && return 0
  done
  return 1
}
typeset -a before   # the server's processes as they were before it was stopped
server_gone() { # 0 when none of them is left, and nothing else runs the bundle
  emulate -L zsh
  local pid
  for pid in $before; do kill -0 "$pid" 2>/dev/null && return 1; done
  [[ -z "$(bundle_pids)" ]]
}
wait_gone() { # 0 once the server is gone; 1 when it is still there after STOP_WAIT seconds
  emulate -L zsh
  local deadline=$(( SECONDS + STOP_WAIT ))
  until server_gone; do
    (( SECONDS < deadline )) || return 1
    sleep 0.2
  done
  return 0
}
start_server() { # 0 when launchd has the server again
  emulate -L zsh
  local try
  [[ -f $plist ]] || return 0
  # Always ask, then look: a job launchd is still letting go of is listed for a
  # moment longer and refused meanwhile, so it is asked again until it stays.
  for try in 1 2 3 4 5; do
    launchctl load -w "$plist" >/dev/null 2>&1
    sleep 0.1
    server_listed && return 0
    (( try < 5 )) && sleep 1
  done
  return 1
}
say_start_it() {
  say "Start it with this command:"
  say "  launchctl load -w ~/Library/LaunchAgents/$LABEL.plist"
}

work="$(mktemp -d "$TMP/flint-restore-file.XXXXXX")" || refuse "Flint could not make a working folder."
chmod 700 "$work"
# However this ends (a refusal, a failure part-way, Control-C), a server that was
# stopped is started again, and the working copies are removed.
stopped=0
finish() {
  trap '' INT TERM
  if (( stopped )); then
    stopped=0
    if start_server; then
      say "Flint's server is running."
    else
      say "Flint's server did not start again."
      say_start_it
    fi
  fi
  rm -rf "${work:?}"
}
trap finish EXIT
trap 'print; exit 130' INT   # a line of its own after the ^C the terminal shows
trap 'exit 130' TERM

# ---- what a copy holds -------------------------------------------------------------------

readable() { [[ -s $1 ]] && /usr/bin/plutil -convert json -o /dev/null "$1" >/dev/null 2>&1; }
count_of() { # <file>: how many facts, conversations or notes the server would find in it, in REPLY
  emulate -L zsh
  local out
  local -a keys
  REPLY=0
  out="$(/usr/bin/plutil -extract "$key" raw -expect "$shape" -o - "$1" 2>/dev/null)" || return 0
  if [[ $shape == dictionary ]]; then keys=(${(f)out}); REPLY=${#keys}
  elif [[ $out =~ '^[0-9]+$' ]]; then REPLY=$out
  fi
  return 0
}
human() { # <bytes>: a size as a person reads it, in REPLY
  emulate -L zsh
  local b=$1
  if (( b == 1 )); then REPLY="1 byte"
  elif (( b < 1024 )); then REPLY="$b bytes"
  elif (( b < 1048576 )); then REPLY="$(( (b + 512) / 1024 )) KB"
  else REPLY="$(( b / 1048576 )).$(( (b % 1048576) * 10 / 1048576 )) MB"
  fi
}
counted() { # <n>: "1 fact", "3 facts", in REPLY
  if (( $1 == 1 )); then REPLY="1 $noun"; else REPLY="$1 ${noun}s"; fi
}
holds() { # <count> <bytes>: "3 facts (2 KB)", in REPLY
  emulate -L zsh
  local c
  counted "$1"; c=$REPLY
  human "$2"
  REPLY="$c ($REPLY)"
}
amount() { # <count> <bytes>: what the rule compares, as words, in REPLY
  if [[ $measure == count ]]; then counted "$1"; else human "$2"; fi
}

# ---- the backups, oldest first --------------------------------------------------------------

# Every nightly backup, with what its copy holds. The copy to offer is kept as
# $work/best while the rest are read: the newest that is not passed over, or the
# newest from the day that was asked for.
typeset -a c_file c_made c_day c_ok c_count c_size c_older c_far
pick=0 n=0 older_max=0 older_count=0 older_size=0
say "Flint is reading the backups on this Mac. This can take a few minutes."
for candidate in "$LOCAL"/flint-*.tar.gz(N.on); do   # the names carry the date, so by name is oldest first
  [[ ${candidate:t} =~ '^flint-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})\.tar\.gz$' ]] || continue
  n=$(( n + 1 ))
  c_file[n]=$candidate
  c_made[n]="$match[1]-$match[2]-$match[3] at $match[4]:$match[5]"
  c_day[n]="$match[1]$match[2]$match[3]"
  c_ok[n]=0 c_count[n]=0 c_size[n]=0 c_older[n]="" c_far[n]=0
  rm -f "$work/copy"
  # -q: stop at the file instead of reading the rest of a large archive.
  if ( umask 077; /usr/bin/tar -xzOqf "$candidate" "./$member" > "$work/copy" ) 2>/dev/null && readable "$work/copy"; then
    c_ok[n]=1
    c_size[n]=$(/usr/bin/stat -f %z "$work/copy")
    count_of "$work/copy"; c_count[n]=$REPLY
    if [[ $measure == count ]]; then mine=$c_count[n]; else mine=$c_size[n]; fi
    if (( 2 * mine < older_max )); then
      c_far[n]=1
      amount "$older_count" "$older_size"; c_older[n]=$REPLY
    fi
    if (( mine > older_max )); then older_max=$mine older_count=$c_count[n] older_size=$c_size[n]; fi
    holds "$c_count[n]" "$c_size[n]"
    say "The backup from $c_made[n] holds $REPLY."
    if [[ -n $day ]]; then
      [[ $c_day[n] == $day ]] && { mv -f "$work/copy" "$work/best" && pick=$n; }
    elif (( ! c_far[n] )); then
      mv -f "$work/copy" "$work/best" && pick=$n
    fi
  else
    say "The backup from $c_made[n] holds no readable copy."
  fi
done
rm -f "$work/copy"

if [[ -n $day ]] && (( ! pick )); then
  for (( i = 1; i <= n; i++ )); do
    [[ $c_day[i] == $day ]] && refuse "The backup from $2 holds no readable copy of that file. Nothing was changed."
  done
  refuse "There is no backup from $2 on this Mac. Nothing was changed."
fi
(( pick )) || refuse "None of the backups on this Mac holds a readable copy of that file. Nothing was changed."
readable "$work/best" || refuse "Flint could not keep the copy it chose. Nothing was changed."

# The file as it is now, for comparison.
existed=0
if [[ -e $target ]]; then
  existed=1
  if readable "$target"; then
    count_of "$target"; holds "$REPLY" "$(/usr/bin/stat -f %z "$target")"
    say "The file as it is now holds $REPLY."
  else
    say "The file as it is now cannot be read."
  fi
else
  say "That file is missing from Flint now."
fi

archive_age() { # <index>: how old that backup is, as words, in REPLY
  emulate -L zsh
  local hours
  hours=$(( ( $(date +%s) - $(/usr/bin/stat -f %m "$c_file[$1]") ) / 3600 ))
  if (( hours < 1 )); then REPLY="less than an hour old"
  elif (( hours < 48 )); then REPLY="$hours hours old"
  else REPLY="$(( hours / 24 )) days old"
  fi
}
made=$c_made[pick]
archive_age $pick; age=$REPLY
passed=0
if [[ -z $day ]]; then
  # Every readable copy newer than the one offered was passed over. Say each, and the rule once.
  for (( i = n; i > pick; i-- )); do
    (( c_ok[i] )) || continue
    passed=$(( passed + 1 ))
    amount "$c_count[i]" "$c_size[i]"
    if [[ $measure == count ]]; then
      say "Flint passed over the backup from $c_made[i]: its copy holds $REPLY, and an older one holds $c_older[i]."
    else
      say "Flint passed over the backup from $c_made[i]: its copy is $REPLY, and an older one is $c_older[i]."
    fi
  done
  if (( passed )); then
    say "A copy that holds less than half of what an older copy holds has usually been emptied, so Flint passes it over."
    say "Flint chose the copy from the backup made on $made. It is $age."
  else
    say "The newest readable copy of $what is from the backup made on $made. It is $age."
  fi
else
  say "The copy you asked for is from the backup made on $made. It is $age."
  (( c_far[pick] )) && say "Take care with it: it holds less than half of what an older copy holds, so it may have been emptied."
fi
# Another day to choose, when there is one: the nearest older readable copy, else the nearest newer.
other=
for (( i = pick - 1; i >= 1; i-- )); do (( c_ok[i] )) && [[ $c_day[i] != $c_day[pick] ]] && { other=$i; break; }; done
if [[ -z $other ]]; then
  for (( i = pick + 1; i <= n; i++ )); do (( c_ok[i] )) && [[ $c_day[i] != $c_day[pick] ]] && { other=$i; break; }; done
fi
if [[ -n $other ]]; then
  say "To restore the copy from another day instead, run this again with that day at the end:"
  say "  ~/flint/apps/studio/restore_file.sh $kind ${c_made[other]%% at *}"
fi
say "Restoring it puts that copy in place. Anything Flint saved in that file since the backup is left out of it."
(( existed )) && say "The file as it is now is kept beside it, so nothing is lost."
print -n -- "Type RESTORE to continue: "
read -r answer
[[ $answer == RESTORE ]] || refuse "Nothing was changed."

# ---- the swap ------------------------------------------------------------------------------

stamp="$(date +%Y%m%d-%H%M%S)"
kept="$target.before-restore-$stamp"
[[ -L $target ]] && refuse "The file to restore is a link to somewhere else, so Flint left it alone. Nothing was changed."
# Stop the server and wait until its process is gone: one that is still on its way
# out can save what it holds in memory over the copy.
before=($(launchd_pid) $(bundle_pids))
if [[ -f $plist ]]; then
  say "Flint is stopping its server to swap the file."
  stopped=1
  launchctl unload "$plist" >/dev/null 2>&1
fi
wait_gone || refuse "Flint's server did not stop, so the file was not swapped. Nothing was changed."
mkdir -p "${target:h}" 2>/dev/null || refuse "Flint could not reach the folder the file lives in. Nothing was changed."
if [[ -e $target ]]; then
  mv "$target" "$kept" 2>/dev/null || refuse "Flint could not set the current file aside. Nothing was changed."
  chmod 600 "$kept" 2>/dev/null
fi
if ! { chmod 600 "$work/best" && mv "$work/best" "$target"; } 2>/dev/null; then
  # Put back what was there, and say so.
  [[ -e $kept && ! -e $target ]] && mv "$kept" "$target" 2>/dev/null
  refuse "Flint could not put the copy in place, so it put the current file back. Nothing was changed."
fi
rc=0
if [[ ! -f $plist ]]; then
  say "The copy from $made is in place."
elif start_server; then
  say "The copy from $made is in place, and Flint is starting again."
else
  say "The copy from $made is in place, but Flint's server did not start again."
  say_start_it
  rc=1
fi
stopped=0
[[ -e $kept ]] && say "The file as it was is kept as ${kept:t}, in the same folder."
exit $rc
