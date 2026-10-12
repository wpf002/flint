#!/bin/zsh
# rollback.sh: put the previous version of Flint back, and pause updates.
#
# For when an update broke Flint and reverting the pull request on GitHub has not
# fixed it within about ten minutes (docs/RECOVERY.md). Run it on the Studio:
#
#     ~/flint/apps/studio/rollback.sh
#
# What it does, in order:
#   1. pauses updates (~/.flint/deploy-hold), so the deploy job does not put the
#      broken version straight back;
#   2. puts back the server from before its last update (server.mjs.prev, which
#      every server install keeps) and restarts it;
#   3. puts back the runtime release from before its last update and restarts it,
#      unless that update changed the database: a database update is never
#      undone automatically, so then the runtime is left as it is;
#   4. checks each answers. If the earlier version does not answer either, the
#      current one is put back.
#
# Nothing is deleted: the version it rolls back from is kept (server.mjs.rolled-back,
# and the runtime release stays in its folder). Updates stay paused until the
# hold file is removed:   rm ~/.flint/deploy-hold
# Every line it prints is a sentence.
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

# 1. Pause updates first, whatever happens next.
mkdir -p "$STATE" && ( umask 077; print -r -- "Paused by rollback.sh on $(date '+%F %T'). Remove this file to resume updates." > "$HOLD" ) \
  || refuse "Flint could not pause updates, so it changed nothing."
say "Updates are paused."
if pgrep -f 'auto_deploy\.sh|install-server\.sh|install-runtime\.sh' >/dev/null 2>&1; then
  refuse "An update is being installed right now. Wait two minutes and run this again. Updates stay paused meanwhile."
fi

healthy() { # <url> <tries>: does it answer ok within that many seconds?
  local i
  for i in {1..$2}; do
    curl -fsS -m 3 "$1" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 1
  done
  return 1
}

# 2. The server.
server_port=8080
plist_env_value "$AGENTS/com.flint.server.plist" PORT && [[ $REPLY =~ '^[0-9]{2,5}$' ]] && server_port=$REPLY
restart_server() { launchctl unload "$AGENTS/com.flint.server.plist" >/dev/null 2>&1; launchctl load -w "$AGENTS/com.flint.server.plist" >/dev/null 2>&1; }
if [[ -f $DATA/server.mjs && -f $DATA/server.mjs.prev ]] && ! cmp -s "$DATA/server.mjs" "$DATA/server.mjs.prev"; then
  cp -p "$DATA/server.mjs" "$DATA/server.mjs.rolled-back" && cp -p "$DATA/server.mjs.prev" "$DATA/server.mjs" || refuse "Flint could not put the earlier server back. Nothing else was changed."
  if [[ -f $DATA/console.html.prev ]]; then
    cp -p "$DATA/console.html" "$DATA/console.html.rolled-back" 2>/dev/null
    cp -p "$DATA/console.html.prev" "$DATA/console.html"
  fi
  restart_server
  if healthy "http://localhost:$server_port/health" 20; then
    say "The server is back on the version from before its last update, and it answers."
  else
    cp -p "$DATA/server.mjs.rolled-back" "$DATA/server.mjs"
    [[ -f $DATA/console.html.rolled-back ]] && cp -p "$DATA/console.html.rolled-back" "$DATA/console.html"
    restart_server
    if healthy "http://localhost:$server_port/health" 20; then
      say "The earlier server did not start, so Flint put the current one back. It answers."
    else
      say "Neither version of the server answers. Ask for help before doing more."
    fi
  fi
else
  say "There is no earlier server version to go back to, so the server was left as it is."
fi

# 3. The runtime.
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
current="$(readlink "$RT/current" 2>/dev/null)" || current=
# The release installed just before the one running: the next one down, newest first by when
# its folder was made (the installer writes a release once and never into it again). Never a
# newer one: after a rollback the running release is no longer the newest.
previous= passed=0
for release in "$RT"/releases/*(/Nom); do
  if [[ $release == $current ]]; then passed=1; continue; fi
  (( passed )) && [[ ${release:t} =~ '^[0-9a-f]{40}$' ]] && { previous=$release; break; }
done
if [[ -z $current || -z $previous ]]; then
  say "There is no earlier runtime version to go back to, so the runtime was left as it is."
elif ! changed="$(git -C "$REPO" diff --name-only "${previous:t}" "${current:t}" -- apps/runtime/prisma/migrations 2>/dev/null)"; then
  say "Flint could not tell whether the last runtime update changed the database, so the runtime was left as it is. Ask before going further."
elif [[ -n $changed ]]; then
  say "The last runtime update changed the database, and a database update is never undone automatically. The runtime was left as it is. Ask before going further."
else
  ln -sfn "$previous" "$RT/current"
  restart_runtime
  if healthy "http://[::1]:$runtime_port/health" 30; then
    say "The runtime is back on the version from before its last update, and it answers."
  else
    ln -sfn "$current" "$RT/current"
    restart_runtime
    if healthy "http://[::1]:$runtime_port/health" 30; then
      say "The earlier runtime did not start, so Flint put the current one back. It answers."
    else
      say "Neither version of the runtime answers. Ask for help before doing more."
    fi
  fi
fi

say "Updates stay paused. When the fix is merged, resume them with this command:"
say "  rm ~/.flint/deploy-hold"
exit 0
