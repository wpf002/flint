#!/bin/zsh
# rollback.sh: put the previous version of Flint back, and pause updates.
#
# For when an update broke Flint and reverting the pull request on GitHub has not
# fixed it within about ten minutes (docs/RECOVERY.md). Run it on the Studio, in
# Terminal:
#
#     ~/flint/apps/studio/rollback.sh
#
# What it does, in order:
#   1. pauses updates (~/.flint/deploy-hold) while it asks and works, so the
#      deploy job changes nothing under it;
#   2. for the server, then the runtime, says which version is running and which
#      one it kept from before (each by its short name and how long ago it was
#      installed), and asks you to type ROLLBACK to go back to it. Nothing you
#      leave alone is touched;
#   3. puts back the server from before its last update (server.mjs.prev, which
#      every server install keeps) and restarts it;
#   4. puts back the runtime release that ran before this one and restarts it,
#      unless that update changed the database: a database update is never
#      undone automatically, so then the runtime is left as it is;
#   5. checks each answers. If the earlier version does not answer either, the
#      current one is put back;
#   6. leaves updates paused when something was rolled back, so the deploy job
#      does not put the broken version straight back. When nothing was, the
#      pause it made is lifted again.
#
# The version before the running one is not always the good one. When the revert
# has already been installed, the version before it is the broken one, and going
# back would install it again. So when the running version carries a revert the
# earlier one does not, or Flint cannot check, ROLLBACK is not enough: it tells
# you so, and goes back only if you type that version's own name.
#
# Nothing is deleted: the version it rolls back from is kept (server.mjs.rolled-back,
# and the runtime release stays in its folder). Updates stay paused until the
# hold file is removed:   rm ~/.flint/deploy-hold
# The deploy job then installs the newest version again within a few minutes.
# It takes no options. Every line it prints is a sentence.
set -u
here=${0:A:h}
source "$here/recovery_lib.sh"

DATA="$HOME/.flint"
STATE="${FLINT_STATE_DIR:-$DATA}"
AGENTS="$HOME/Library/LaunchAgents"
REPO="${FLINT_REPO:-$HOME/flint}"
HOLD="$STATE/deploy-hold"
RT="$DATA/runtime"
(( $# == 0 )) || refuse "This takes no options. Run it as: ~/flint/apps/studio/rollback.sh"
[[ -d $DATA ]] || refuse "There is no Flint on this Mac to roll back."
[[ -t 0 && -t 1 ]] || refuse "Run this yourself in Terminal: it asks you to confirm before it changes anything."

# Updates are paused while it asks and works, so what it shows is still what is there when it
# acts. The pause is kept only when something was rolled back: on every other way out, a pause
# this run made is lifted again. One that was already there is left as it was, with its own age.
made_hold=0 server_back=0 runtime_back=0   # *_back: an earlier version of it is in place right now
if [[ ! -e $HOLD ]]; then
  mkdir -p "$STATE" && ( umask 077; print -r -- "Paused by rollback.sh on $(date '+%F %T'). Remove this file to resume updates." > "$HOLD" ) \
    || refuse "Flint could not pause updates, so it changed nothing."
  made_hold=1
fi
trap '(( made_hold && ! server_back && ! runtime_back )) && rm -f "${HOLD:?}"' EXIT
trap 'exit 130' INT TERM
if pgrep -f 'auto_deploy\.sh|install-server\.sh|install-runtime\.sh' >/dev/null 2>&1; then
  refuse "An update is being installed right now. Wait two minutes and run this again. Nothing was changed."
fi

healthy() { # <url> <tries>: does it answer ok within that many seconds?
  local i
  for i in {1..$2}; do
    curl -fsS -m 3 "$1" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 1
  done
  return 1
}

# ---- which version is which --------------------------------------------------------------
# The installers keep one line beside each version: "<commit> <when it was installed, in
# seconds>" (server.version and server.version.prev; runtime/version and runtime/version.prev).

version_of() { # <file>: its commit in REPLY and its install time in REPLY2; 1 when there is no line it can read
  emulate -L zsh
  local line=
  REPLY= REPLY2=
  [[ -r $1 ]] && IFS= read -r line < "$1"
  [[ $line =~ '^([0-9a-f]{40}) ([0-9]{9,11})$' ]] || return 1
  REPLY=$match[1] REPLY2=$match[2]
}
made_at() { REPLY="$(/usr/bin/stat -f %m "$1" 2>/dev/null)"; [[ $REPLY =~ '^[0-9]+$' ]] || REPLY=0; }   # <file or folder>: when it was made
ago() { # <seconds since 1970>: how long ago that was, in words, in REPLY
  emulate -L zsh
  local s=$(( $(date +%s) - $1 )) n
  if (( s < 60 )); then REPLY="less than a minute ago"
  elif (( s < 3600 )); then n=$(( s / 60 )); REPLY="$n minute$( (( n == 1 )) || print -n s ) ago"
  elif (( s < 172800 )); then n=$(( s / 3600 )); REPLY="$n hour$( (( n == 1 )) || print -n s ) ago"
  else REPLY="$(( s / 86400 )) days ago"; fi
}
# reverted_since <earlier commit> <running commit>: 0 when a change made after the earlier one,
# up to the running one, is a revert (its title starts with Revert, as GitHub's Revert button and
# git revert write it); 1 when none is; 2 when Flint cannot tell (it does not know a commit, or
# the running one does not come after the earlier one).
reverted_since() {
  emulate -L zsh
  local titles
  [[ $1 =~ '^[0-9a-f]{40}$' && $2 =~ '^[0-9a-f]{40}$' ]] || return 2
  git -C "$REPO" merge-base --is-ancestor "$1" "$2" 2>/dev/null || return 2
  titles="$(git -C "$REPO" log --format=%s "$1..$2" 2>/dev/null)" || return 2
  print -r -- "$titles" | grep -q '^Revert ' && return 0
  return 1
}

# offer <server|runtime> <running commit> <installed> <earlier commit> <installed> <kept as the one before: 1|0>
# Says both versions and asks. 0 only when what it asks for is typed, exactly, at the terminal.
offer() {
  emulate -L zsh
  local part=$1 cur=$2 cur_at=$3 prev=$4 prev_at=$5 kept=$6 word=ROLLBACK answer=
  ago "$cur_at"
  if [[ -n $cur ]]; then say "The $part is on version ${cur[1,7]}, installed $REPLY."
  else say "The $part is on a version Flint has no name for, installed $REPLY."; fi
  ago "$prev_at"
  if [[ -z $prev ]]; then say "Flint kept the one before it, installed $REPLY, and has no name for it."
  elif (( kept )); then say "The one before it is version ${prev[1,7]}, installed $REPLY."
  else say "Flint has no record of the one before it. The next oldest it kept is version ${prev[1,7]}, installed $REPLY."; fi
  reverted_since "$prev" "$cur"
  case $? in
    0) word=${prev[1,7]}
       say "The version it is on now reverts a change that the earlier one still has, so going back would undo that revert." ;;
    1) (( kept )) || word=${prev[1,7]} ;;
    *) word=${${prev[1,7]}:-UNNAMED}
       say "Flint could not check whether going back would undo a revert." ;;
  esac
  if [[ $word == ROLLBACK ]]; then print -n -- "Type ROLLBACK to go back to it, or press Return to leave the $part as it is: "
  else print -n -- "Type $word to go back to it anyway, or press Return to leave the $part as it is: "; fi
  read -r answer || true
  [[ "$answer" == "$word" ]]
}

# ---- 1. what to go back to, and whether to ---------------------------------------------------

# The server.
go_server=0 server_to=
if [[ -f $DATA/server.mjs && -f $DATA/server.mjs.prev ]] && ! cmp -s "$DATA/server.mjs" "$DATA/server.mjs.prev"; then
  cur= cur_at= prev= prev_at=
  version_of "$DATA/server.version" && cur=$REPLY cur_at=$REPLY2
  version_of "$DATA/server.version.prev" && prev=$REPLY prev_at=$REPLY2
  # No line for a bundle: its file was written when it was installed (a copy keeps that time).
  [[ -n $cur_at ]] || { made_at "$DATA/server.mjs"; cur_at=$REPLY; }
  [[ -n $prev_at ]] || { made_at "$DATA/server.mjs.prev"; prev_at=$REPLY; }
  if offer server "$cur" "$cur_at" "$prev" "$prev_at" 1; then go_server=1 server_to=$prev
  else say "The server was left as it is."; fi
else
  say "There is no earlier server version to go back to, so the server was left as it is."
fi

# The runtime. The release that ran before this one is the one its installer wrote down. With no
# such line (a release from before they were kept, or a second rollback), the next one down,
# newest first by when its folder was made, and never a newer one: after a rollback the running
# release is no longer the newest.
go_runtime=0
current="$(readlink "$RT/current" 2>/dev/null)" || current=
cur=${current:t} cur_at= previous= prev_at= kept=0
if [[ -n $current ]]; then
  if version_of "$RT/version" && [[ $REPLY == $cur ]]; then
    cur_at=$REPLY2
    if version_of "$RT/version.prev" && [[ $REPLY != $cur && -d $RT/releases/$REPLY ]]; then
      previous="$RT/releases/$REPLY" prev_at=$REPLY2 kept=1
    fi
  fi
  if [[ -z $previous ]]; then
    passed=0
    for release in "$RT"/releases/*(/Nom); do
      if [[ $release == $current ]]; then passed=1; continue; fi
      (( passed )) && [[ ${release:t} =~ '^[0-9a-f]{40}$' ]] && { previous=$release; break; }
    done
    [[ -n $previous ]] && { made_at "$previous"; prev_at=$REPLY; }
  fi
  [[ -n $cur_at ]] || { made_at "$current"; cur_at=$REPLY; }
fi
[[ $cur =~ '^[0-9a-f]{40}$' ]] || cur=
if [[ -z $current || -z $previous ]]; then
  say "There is no earlier runtime version to go back to, so the runtime was left as it is."
elif [[ -z $cur ]] || ! changed="$(git -C "$REPO" diff --name-only "${previous:t}" "$cur" -- apps/runtime/prisma/migrations 2>/dev/null)"; then
  say "Flint could not tell whether the last runtime update changed the database, so the runtime was left as it is. Ask before going further."
elif [[ -n $changed ]]; then
  say "The last runtime update changed the database, and a database update is never undone automatically. The runtime was left as it is. Ask before going further."
elif offer runtime "$cur" "$cur_at" "${previous:t}" "$prev_at" "$kept"; then
  go_runtime=1
else
  say "The runtime was left as it is."
fi

# ---- 2. the server ---------------------------------------------------------------------------
server_port=8080
plist_env_value "$AGENTS/com.flint.server.plist" PORT && [[ $REPLY =~ '^[0-9]{2,5}$' ]] && server_port=$REPLY
restart_server() { launchctl unload "$AGENTS/com.flint.server.plist" >/dev/null 2>&1; launchctl load -w "$AGENTS/com.flint.server.plist" >/dev/null 2>&1; }
# put <from> <to>: one of the server's files, or its version line, into place; a missing one leaves none.
put() { if [[ -f $1 ]]; then cp -p "$1" "$2"; else rm -f "$2"; fi }
if (( go_server )); then
  cp -p "$DATA/server.mjs" "$DATA/server.mjs.rolled-back" && cp -p "$DATA/server.mjs.prev" "$DATA/server.mjs" || refuse "Flint could not put the earlier server back. Nothing else was changed."
  server_back=1
  put "$DATA/server.version" "$DATA/server.version.rolled-back"
  put "$DATA/server.version.prev" "$DATA/server.version"
  if [[ -f $DATA/console.html.prev ]]; then
    cp -p "$DATA/console.html" "$DATA/console.html.rolled-back" 2>/dev/null
    cp -p "$DATA/console.html.prev" "$DATA/console.html"
  fi
  restart_server
  if healthy "http://localhost:$server_port/health" 20; then
    if [[ -n $server_to ]]; then say "The server is back on version ${server_to[1,7]}, and it answers."
    else say "The server is back on the earlier version, and it answers."; fi
  else
    cp -p "$DATA/server.mjs.rolled-back" "$DATA/server.mjs" && server_back=0
    put "$DATA/server.version.rolled-back" "$DATA/server.version"
    [[ -f $DATA/console.html.rolled-back ]] && cp -p "$DATA/console.html.rolled-back" "$DATA/console.html"
    restart_server
    if healthy "http://localhost:$server_port/health" 20; then
      say "The earlier server did not start, so Flint put the current one back. It answers."
    else
      say "Neither version of the server answers. Ask for help before doing more."
    fi
  fi
fi

# ---- 3. the runtime --------------------------------------------------------------------------
runtime_port=8090
env_value "$DATA/runtime.env" RUNTIME_PORT && [[ $REPLY =~ '^[0-9]{2,5}$' ]] && runtime_port=$REPLY
restart_runtime() {
  local i
  launchctl bootout "gui/$UID/com.flint.runtime" >/dev/null 2>&1
  for i in {1..40}; do launchctl print "gui/$UID/com.flint.runtime" >/dev/null 2>&1 || break; sleep 0.25; done
  for i in 1 2 3 4 5; do
    launchctl bootstrap "gui/$UID" "$AGENTS/com.flint.runtime.plist" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
if (( go_runtime )); then
  ln -sfn "$previous" "$RT/current" && runtime_back=1
  restart_runtime
  if healthy "http://[::1]:$runtime_port/health" 30; then
    # The lines follow the release: the one running now, and nothing known before it.
    put "$RT/version" "$RT/version.rolled-back"
    ( umask 077; print -r -- "${previous:t} $prev_at" > "$RT/version" && chmod 600 "$RT/version" ) 2>/dev/null
    rm -f "$RT/version.prev"
    say "The runtime is back on version ${${previous:t}[1,7]}, and it answers."
  else
    ln -sfn "$current" "$RT/current" && runtime_back=0
    restart_runtime
    if healthy "http://[::1]:$runtime_port/health" 30; then
      say "The earlier runtime did not start, so Flint put the current one back. It answers."
    else
      say "Neither version of the runtime answers. Ask for help before doing more."
    fi
  fi
fi

# ---- 4. updates ------------------------------------------------------------------------------
if (( server_back || runtime_back )); then
  # The pause must outlast this run. One that a database restore made (restore-production pauses
  # updates while it works) is lifted when that restore ends, so this run's own takes its place;
  # and one that was lifted meanwhile is made again.
  paused=1
  if [[ ! -e $HOLD || "$(head -c 8 "$HOLD" 2>/dev/null)" == "restore " ]]; then
    ( umask 077; print -r -- "Paused by rollback.sh on $(date '+%F %T'). Remove this file to resume updates." > "$HOLD" ) 2>/dev/null || paused=0
  fi
  if (( paused )); then
    say "Updates are paused, so nothing replaces what you went back to."
    say "Resuming them installs the newest version again. When the fix is merged, resume them with this command:"
    say "  rm ~/.flint/deploy-hold"
  else
    say "Flint could not pause updates, so the next update may replace what you went back to. Ask for help before doing more."
  fi
elif (( made_hold )); then
  say "Nothing was rolled back, so updates are not paused."
else
  say "Nothing was rolled back. Updates were already paused, and they still are."
fi
exit 0
