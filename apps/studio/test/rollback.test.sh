#!/bin/zsh
# rollback.sh, on a fixture ~/.flint with stand-ins for launchctl, curl, git and
# pgrep: nothing here reaches launchd, the network or the real Flint.
# Run: zsh apps/studio/test/rollback.test.sh
#
# What must hold:
#  - updates are paused first, and stay paused;
#  - the server and the runtime go back one version, and what they were is kept;
#  - an earlier version that does not answer is replaced by the current one again;
#  - a runtime update that changed the database is never undone;
#  - it never goes "back" to a newer release, and never acts while an update is installing.
set -u
here=${0:A:h}
script="$here/../rollback.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

bin="$fx/bin"; mkdir -p "$bin"
# launchctl: record the call. curl: "healthy" unless the version in place is marked bad.
print -r -- '#!/bin/zsh
print -r -- "launchctl $*" >> "$FX/calls.log"
[[ $1 == print ]] && exit 113
exit 0' > "$bin/launchctl"
print -r -- '#!/bin/zsh
url=${@[-1]}
print -r -- "curl $url" >> "$FX/calls.log"
if [[ $url == *localhost:* ]]; then grep -q bad "$HOME/.flint/server.mjs" && exit 22
else [[ -e "$(readlink "$HOME/.flint/runtime/current")/bad" ]] && exit 22; fi
print -r -- "{\"ok\":true}"' > "$bin/curl"
print -r -- '#!/bin/zsh
# git -C <repo> diff --name-only <prev> <cur> -- <path>: says what the fixture tells it to.
[[ -e $FX/git-fails ]] && exit 128
[[ -e $FX/migration-changed ]] && print -r -- "apps/runtime/prisma/migrations/20261012000000_x/migration.sql"
exit 0' > "$bin/git"
print -r -- '#!/bin/zsh
[[ -e $FX/deploy-running ]] && exit 0
exit 1' > "$bin/pgrep"
print -r -- '#!/bin/sh
exit 0' > "$bin/sleep"
chmod +x "$bin"/*

A=$(printf 'a%.0s' {1..40}); B=$(printf 'b%.0s' {1..40}); C=$(printf 'c%.0s' {1..40})
fresh() { # a Flint two updates in: server.mjs (v2) with v1 kept, runtime releases A < B < C, running <which>
  rm -rf "$fx/home" "$fx/calls.log" "$fx/git-fails" "$fx/migration-changed" "$fx/deploy-running"
  home="$fx/home"; data="$home/.flint"
  mkdir -p "$data/runtime/releases"/{$A,$B,$C} "$home/Library/LaunchAgents"
  touch -t 202610100000 "$data/runtime/releases/$A"; touch -t 202610110000 "$data/runtime/releases/$B"; touch -t 202610120000 "$data/runtime/releases/$C"
  ln -sfn "$data/runtime/releases/${1:-$C}" "$data/runtime/current"
  print -r -- "server v2" > "$data/server.mjs"; print -r -- "server v1" > "$data/server.mjs.prev"
  print -r -- "console v2" > "$data/console.html"; print -r -- "console v1" > "$data/console.html.prev"
  print -r -- "RUNTIME_PORT=8090" > "$data/runtime.env"
  : > "$home/Library/LaunchAgents/com.flint.server.plist"; : > "$home/Library/LaunchAgents/com.flint.runtime.plist"
}
run() { out="$(env -i HOME="$fx/home" FX="$fx" PATH="$bin:/usr/bin:/bin" /bin/zsh "$script" "$@" 2>&1)"; st=$?; }
live() { print -r -- "${$(readlink "$fx/home/.flint/runtime/current"):t}"; }

# 1. Both go back one version; what they were is kept; updates are paused.
fresh; run
check "it succeeds" '[ "$st" = 0 ]'
check "updates are paused, by a file only its owner can read" '[ -s "$data/deploy-hold" ] && [ "$(stat -f %Lp "$data/deploy-hold")" = 600 ]'
check "the hold comes before anything is touched" '[[ "${out%%$'"'"'\n'"'"'*}" == "Updates are paused." ]]'
check "the server is the earlier one, and the one it replaced is kept" '[ "$(<"$data/server.mjs")" = "server v1" ] && [ "$(<"$data/server.mjs.rolled-back")" = "server v2" ]'
check "the console page goes back with it" '[ "$(<"$data/console.html")" = "console v1" ] && [ "$(<"$data/console.html.rolled-back")" = "console v2" ]'
check "the runtime is the release before, and nothing was removed" '[ "$(live)" = "$B" ] && [ -d "$data/runtime/releases/$C" ] && [ -d "$data/runtime/releases/$A" ]'
check "the server was restarted the way its installer does it" 'grep -q "^launchctl unload $home/Library/LaunchAgents/com.flint.server.plist" "$fx/calls.log" && grep -q "^launchctl load -w $home/Library/LaunchAgents/com.flint.server.plist" "$fx/calls.log"'
check "the runtime was restarted the way its installer does it" 'grep -q "^launchctl bootout gui/[0-9]*/com.flint.runtime" "$fx/calls.log" && grep -q "^launchctl bootstrap gui/[0-9]* $home/Library/LaunchAgents/com.flint.runtime.plist" "$fx/calls.log"'
check "each was checked on its own address" 'grep -q "^curl http://localhost:8080/health" "$fx/calls.log" && grep -q "^curl http://\[::1\]:8090/health" "$fx/calls.log"'
check "it says what it did and how to resume, with the command on its own line" '[[ "$out" == *"The server is back on the version from before its last update, and it answers."* && "$out" == *"The runtime is back on the version from before its last update, and it answers."* && "$out" == *$'"'"'\n'"'"'"  rm ~/.flint/deploy-hold" ]]'
bad="$(print -r -- "$out" | grep -vE "^[A-Z].*[.:]$|^  [a-z~/].*$" || true)"
check "every line is a sentence, or a command on its own line" '[[ -z $bad ]]'

# 2. Run again: it never goes "back" to the newer release, and there is no earlier server left to try.
run
check "a second run keeps the runtime where it is or goes further back, never forward" '[ "$(live)" = "$A" ]'
run
check "with nothing earlier left, the runtime is left alone and it says so" '[ "$(live)" = "$A" ] && [[ "$out" == *"There is no earlier runtime version to go back to"* ]]'

# 3. An earlier version that does not answer: the current one is put back.
fresh; print -r -- "server v1 bad" > "$data/server.mjs.prev"; : > "$data/runtime/releases/$B/bad"; touch -t 202610110000 "$data/runtime/releases/$B"; run
check "a previous server that does not answer is replaced by the current one" '[ "$(<"$data/server.mjs")" = "server v2" ] && [[ "$out" == *"The earlier server did not start, so Flint put the current one back. It answers."* ]]'
check "a previous runtime that does not answer is replaced by the current one" '[ "$(live)" = "$C" ] && [[ "$out" == *"The earlier runtime did not start, so Flint put the current one back. It answers."* ]]'
check "updates are paused all the same" '[ -s "$data/deploy-hold" ]'

# 4. The last runtime update changed the database: the runtime is never rolled back.
fresh; : > "$fx/migration-changed"; run
check "a database update is never undone: the runtime stays" '[ "$(live)" = "$C" ] && [[ "$out" == *"changed the database, and a database update is never undone automatically. The runtime was left as it is."* ]]'
check "the runtime was not restarted" '! grep -q "com.flint.runtime" "$fx/calls.log"'
check "the server still went back" '[ "$(<"$data/server.mjs")" = "server v1" ]'
fresh; : > "$fx/git-fails"; run
check "when it cannot tell whether the database changed, the runtime stays" '[ "$(live)" = "$C" ] && [[ "$out" == *"could not tell whether the last runtime update changed the database"* ]]'

# 5. An update is being installed right now: pause, and touch nothing.
fresh; : > "$fx/deploy-running"; run
check "while an update is installing it stops" '[ "$st" = 1 ] && [[ "$out" == *"An update is being installed right now. Wait two minutes and run this again."* ]]'
check "having paused updates" '[ -s "$data/deploy-hold" ]'
check "and changed nothing else" '[ "$(<"$data/server.mjs")" = "server v2" ] && [ "$(live)" = "$C" ] && [ ! -e "$fx/calls.log" ]'

# 6. Nothing earlier to go back to; no Flint at all; a stray option.
fresh; rm "$data/server.mjs.prev"; rm -rf "$data/runtime/releases/$A" "$data/runtime/releases/$B"; run
check "with no earlier versions it says so and still pauses updates" '[ "$st" = 0 ] && [[ "$out" == *"There is no earlier server version to go back to"* && "$out" == *"There is no earlier runtime version to go back to"* ]] && [ -s "$data/deploy-hold" ]'
fresh; cp "$data/server.mjs" "$data/server.mjs.prev"; run
check "a previous server identical to the current one is not a version to go back to" '[[ "$out" == *"There is no earlier server version to go back to"* ]] && [ ! -e "$data/server.mjs.rolled-back" ]'
rm -rf "$fx/home"; mkdir -p "$fx/home"; run
check "with no Flint on the Mac it says so and makes nothing" '[ "$st" = 1 ] && [[ "$out" == "There is no Flint on this Mac to roll back." ]] && [ ! -e "$fx/home/.flint" ]'
fresh; run --force
check "it takes no options" '[ "$st" = 1 ] && [[ "$out" == *"This takes no options."* ]] && [ ! -e "$data/deploy-hold" ]'

(( fail )) && exit 1
print "ok: rollback pauses updates first, goes back one version, keeps what it replaced, and never undoes a database update"
