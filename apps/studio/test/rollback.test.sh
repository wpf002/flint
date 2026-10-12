#!/bin/zsh
# rollback.sh, on a fixture ~/.flint and a scratch checkout, with stand-ins for
# launchctl, curl and pgrep and a pseudo-terminal for the confirmation: nothing
# here reaches launchd, the network or the real Flint.
# Run: zsh apps/studio/test/rollback.test.sh
#
# What must hold:
#  - it says which version is running and which it would go back to, with how
#    long ago each was installed, and goes back only when asked to at a terminal;
#  - the server and the runtime go back one version, and what they were is kept;
#  - after a revert has been installed, the version before it is the broken one:
#    ROLLBACK is refused, and only that version's own name takes Flint back to it;
#  - the runtime goes back to the release that ran before this one, never to one
#    that only happens to be the next folder by date;
#  - an earlier version that does not answer is replaced by the current one again;
#  - a runtime update that changed the database is never undone;
#  - updates are paused only when something was rolled back, and a pause that was
#    already there is left as it was;
#  - it never acts while an update is installing.
set -u
here=${0:A:h}
script="$here/../rollback.sh"
fx="$(mktemp -d "${${TMPDIR:-/tmp}%/}/flint-rollback.XXXXXX")" || exit 1; trap 'rm -rf "${fx:?}"' EXIT
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
[[ -e $FX/deploy-running ]] && exit 0
exit 1' > "$bin/pgrep"
print -r -- '#!/bin/sh
exit 0' > "$bin/sleep"
chmod +x "$bin"/*

# Three checkouts to stand in for ~/flint, each three commits long: the third is an ordinary
# change, the revert of the second, or a change to the database. Real git, with no settings of
# the person running the test.
gitq() { HOME="$fx/githome" GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }
mkrepo() { # <name> <the third commit's title>
  local r="$fx/repos/$1"
  mkdir -p "$r" "$fx/githome"
  gitq -C "$r" init -q
  print -r -- one > "$r/a"; gitq -C "$r" add -A; gitq -C "$r" commit -q -m "The first change (#69)"
  print -r -- two > "$r/a"; gitq -C "$r" add -A; gitq -C "$r" commit -q -m "A change that broke Flint (#70)"
  case $1 in
    revert|revert-unnamed) print -r -- one > "$r/a" ;;
    revert-said) print -r -- "one, and a fix that came with it" > "$r/a" ;;
    migration) mkdir -p "$r/apps/runtime/prisma/migrations/20261012000000_x"; print -r -- "ALTER TABLE x ADD y int;" > "$r/apps/runtime/prisma/migrations/20261012000000_x/migration.sql" ;;
    *) print -r -- three > "$r/a" ;;
  esac
  # A third argument is the message under the title, with %s for the second commit's id.
  if [[ -n ${3:-} ]]; then gitq -C "$r" add -A; gitq -C "$r" commit -q -m "$2" -m "${3//\%s/$(gitq -C "$r" rev-parse HEAD)}"
  else gitq -C "$r" add -A; gitq -C "$r" commit -q -m "$2"; fi
}
mkrepo plain "A later change (#71)"
mkrepo revert 'Revert "A change that broke Flint (#70)" (#71)'
# A revert that is not called one: by what its message says it reverts, and by the files alone.
mkrepo revert-said "Back out the change that broke Flint (#71)" "This reverts commit %s, and fixes a typo."
mkrepo revert-unnamed "Put the earlier behaviour back (#71)"
mkrepo migration "A database change (#71)"

# A Flint three versions in: the server on the third (installed 12 minutes ago) with the second
# kept (3 hours ago); runtime releases 1 < 2 < 3 by date, running the third, the second written
# down as the one before it.
fresh() { # [plain|revert|migration]
  rm -rf "${fx:?}/home" "${fx:?}/calls.log" "${fx:?}/deploy-running" "${fx:?}/hold-while-asking"
  home="$fx/home"; data="$home/.flint"; rt="$data/runtime"
  mkdir -p "$home/Library/LaunchAgents" "$data"; chmod 700 "$data"
  cp -R "$fx/repos/${1:-plain}" "$home/flint"
  C1=$(gitq -C "$home/flint" rev-parse HEAD~2); C2=$(gitq -C "$home/flint" rev-parse HEAD~1); C3=$(gitq -C "$home/flint" rev-parse HEAD)
  s1=${C1[1,7]} s2=${C2[1,7]} s3=${C3[1,7]}
  now=$(date +%s)
  mkdir -p "$rt/releases"/{$C1,$C2,$C3}
  touch -t "$(date -v-3d +%Y%m%d%H%M)" "$rt/releases/$C1"; touch -t "$(date -v-2d +%Y%m%d%H%M)" "$rt/releases/$C2"; touch -t "$(date -v-1d +%Y%m%d%H%M)" "$rt/releases/$C3"
  ln -sfn "$rt/releases/$C3" "$rt/current"
  print -r -- "$C3 $(( now - 720 ))" > "$rt/version"; print -r -- "$C2 $(( now - 10860 ))" > "$rt/version.prev"
  print -r -- "server v3" > "$data/server.mjs"; print -r -- "server v2" > "$data/server.mjs.prev"
  print -r -- "$C3 $(( now - 720 ))" > "$data/server.version"; print -r -- "$C2 $(( now - 10860 ))" > "$data/server.version.prev"
  print -r -- "console v3" > "$data/console.html"; print -r -- "console v2" > "$data/console.html.prev"
  print -r -- "RUNTIME_PORT=8090" > "$data/runtime.env"
  : > "$home/Library/LaunchAgents/com.flint.server.plist"; : > "$home/Library/LaunchAgents/com.flint.runtime.plist"
}
# Run it at a pseudo-terminal, and type <for the server> and <for the runtime> when it asks about each.
# (When it asks about the server, the stand-in for the owner also notes whether updates are paused just then.)
print -r -- 'set timeout 60
spawn -noecho /usr/bin/env -i HOME=$env(T_HOME) FX=$env(T_FX) PATH=$env(T_PATH) /bin/zsh $env(T_SCRIPT) {*}$argv
expect {
  -re {leave the server as it is: $} {
    set seen [open "$env(T_FX)/hold-while-asking" w]; puts $seen [file exists "$env(T_HOME)/.flint/deploy-hold"]; close $seen
    send -- "$env(T_SERVER)\r"; exp_continue
  }
  -re {leave the runtime as it is: $} { send -- "$env(T_RUNTIME)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]' > "$fx/terminal.exp"
run() { local server=$1 runtime=$2; shift 2
  out="$( { T_HOME="$fx/home" T_FX="$fx" T_PATH="$bin:/usr/bin:/bin" T_SCRIPT="$script" T_SERVER="$server" T_RUNTIME="$runtime" /usr/bin/expect "$fx/terminal.exp" "$@"; print -r -- $? > "$fx/status"; } 2>&1 | tr -d '\r')"
  st="$(<"$fx/status")"
}
piped() { out="$(print -r -- "ROLLBACK\nROLLBACK" | env -i HOME="$fx/home" FX="$fx" PATH="$bin:/usr/bin:/bin" /bin/zsh "$script" "$@" 2>&1)"; st=$?; }
live() { print -r -- "${$(readlink "$fx/home/.flint/runtime/current"):t}"; }
untouched() { [ "$(<"$data/server.mjs")" = "server v3" ] && [ "$(live)" = "$C3" ] && [ ! -e "$data/server.mjs.rolled-back" ] && [ ! -e "$fx/calls.log" ]; }

# 1. Both go back one version when asked to; what they were is kept; updates are paused.
fresh; run ROLLBACK ROLLBACK
check "it succeeds" '[ "$st" = 0 ]'
check "it says which server version is running and which it kept, with how long ago each was installed" '[[ "$out" == *"The server is on version $s3, installed 12 minutes ago."*"The one before it is version $s2, installed 3 hours ago."*"Type ROLLBACK to go back to it, or press Return to leave the server as it is: "* ]]'
check "and the same for the runtime, before it changes anything" '[[ "$out" == *"The runtime is on version $s3, installed 12 minutes ago."*"The one before it is version $s2, installed 3 hours ago."*"leave the runtime as it is: "*"The server is back on version $s2, and it answers."* ]]'
check "the server is the earlier one, and the one it replaced is kept" '[ "$(<"$data/server.mjs")" = "server v2" ] && [ "$(<"$data/server.mjs.rolled-back")" = "server v3" ]'
check "the console page goes back with it" '[ "$(<"$data/console.html")" = "console v2" ] && [ "$(<"$data/console.html.rolled-back")" = "console v3" ]'
check "the server's version line goes back with it, and the one it replaced is kept" '[[ "$(<"$data/server.version")" == "$C2 "* && "$(<"$data/server.version.rolled-back")" == "$C3 "* ]]'
check "the runtime is the release before, and nothing was removed" '[ "$(live)" = "$C2" ] && [ -d "$rt/releases/$C3" ] && [ -d "$rt/releases/$C1" ]'
check "the runtime's version line follows it, with nothing known before it" '[[ "$(<"$rt/version")" == "$C2 "* && "$(<"$rt/version.rolled-back")" == "$C3 "* ]] && [ ! -e "$rt/version.prev" ]'
check "updates are paused, by a file only its owner can read" '[ -s "$data/deploy-hold" ] && [ "$(stat -f %Lp "$data/deploy-hold")" = 600 ]'
check "the server was restarted the way its installer does it" 'grep -q "^launchctl unload $home/Library/LaunchAgents/com.flint.server.plist" "$fx/calls.log" && grep -q "^launchctl load -w $home/Library/LaunchAgents/com.flint.server.plist" "$fx/calls.log"'
check "the runtime was restarted the way its installer does it" 'grep -q "^launchctl bootout gui/[0-9]*/com.flint.runtime" "$fx/calls.log" && grep -q "^launchctl bootstrap gui/[0-9]* $home/Library/LaunchAgents/com.flint.runtime.plist" "$fx/calls.log"'
check "each was checked on its own address" 'grep -q "^curl http://localhost:8080/health" "$fx/calls.log" && grep -q "^curl http://\[::1\]:8090/health" "$fx/calls.log"'
check "it says what it did and how to resume, with the command on its own line" '[[ "$out" == *"The server is back on version $s2, and it answers."*"The runtime is back on version $s2, and it answers."*"Updates are paused, so nothing replaces what you went back to."* && "$out" == *$'"'"'\n'"'"'"  rm ~/.flint/deploy-hold" ]]'
bad="$(print -r -- "$out" | grep -vE "^[A-Z].*[.:]$|^  rm ~/\.flint/deploy-hold$|^Type [A-Za-z0-9]+ to go back to it( anyway)?, or press Return to leave the (server|runtime) as it is: [A-Za-z0-9]*$" || true)"
check "every line is a sentence, a question, or a command on its own line" '[[ -z $bad ]]'

# 2. Run again: nothing earlier is left for the server. For the runtime nothing is written down
#    as the one before, so the next folder down is offered by name, and only its name is accepted.
hold_before="$(<"$data/deploy-hold") $(stat -f %m "$data/deploy-hold")"
run ROLLBACK ROLLBACK
check "a second run finds no earlier server" '[[ "$out" == *"There is no earlier server version to go back to"* ]] && [ "$(<"$data/server.mjs")" = "server v2" ]'
check "with no record of the one before, ROLLBACK is not enough, and the runtime stays" '[ "$(live)" = "$C2" ] && [[ "$out" == *"Flint has no record of the one before it. The next oldest it kept is version $s1, installed 3 days ago."*"Type $s1 to go back to it anyway"*"The runtime was left as it is."* ]]'
check "the pause from the first run is left exactly as it was" '[ "$hold_before" = "$(<"$data/deploy-hold") $(stat -f %m "$data/deploy-hold")" ] && [[ "$out" == *"Nothing was rolled back. Updates were already paused, and they still are."* ]]'
run ROLLBACK "$s1"
check "its own name takes the runtime further back, never forward" '[ "$(live)" = "$C1" ] && [[ "$out" == *"The runtime is back on version $s1, and it answers."* ]]'
run ROLLBACK ROLLBACK
check "with nothing earlier left, the runtime is left alone and it says so" '[ "$(live)" = "$C1" ] && [[ "$out" == *"There is no earlier runtime version to go back to"* ]]'

# 3. THE REVERT IS ALREADY INSTALLED: the version before it is the broken one. ROLLBACK is refused.
fresh revert; run ROLLBACK ROLLBACK
check "it says the running version reverts what the earlier one still has" '[[ "$out" == *"The server is on version $s3, installed 12 minutes ago."*"The one before it is version $s2, installed 3 hours ago."*"The version it is on now reverts a change that the earlier one still has, so going back would undo that revert."* ]]'
check "it asks for that version by name, not for ROLLBACK" '[[ "$out" == *"Type $s2 to go back to it anyway, or press Return to leave the server as it is: "* && "$out" != *"Type ROLLBACK"* ]]'
check "ROLLBACK does not put the broken version back: nothing is touched" 'untouched && [[ "$out" == *"The server was left as it is."*"The runtime was left as it is."* ]]'
check "it never says it went back, and updates are not paused" '[[ "$out" != *"is back on"* && "$out" == *"Nothing was rolled back, so updates are not paused."* ]] && [ ! -e "$data/deploy-hold" ] && [ "$st" = 0 ]'
run ROLLBACK ROLLBACK
check "a second try is refused the same way" 'untouched && [[ "$out" == *"going back would undo that revert."* ]] && [ ! -e "$data/deploy-hold" ]'
# A revert is known by what it is in git, whatever its title: its message naming the commit it reverts, or
# its files being exactly those of two changes earlier.
for kind in revert-said revert-unnamed; do
  fresh $kind; run ROLLBACK ROLLBACK
  check "a revert that is not called one is still known for one ($kind)" 'untouched && [[ "$out" == *"The version it is on now reverts a change that the earlier one still has, so going back would undo that revert."*"Type $s2 to go back to it anyway"* && "$out" != *"Type ROLLBACK"* ]] && [ ! -e "$data/deploy-hold" ]'
done
fresh revert
run "$s2" ""
check "typing the version's own name goes back to it: the choice is the owner's, made knowingly" '[ "$(<"$data/server.mjs")" = "server v2" ] && [[ "$out" == *"The server is back on version $s2, and it answers."* ]] && [ "$(live)" = "$C3" ] && [ -s "$data/deploy-hold" ]'

# 4. Anything but what it asks for changes nothing, and nothing can be piped in to answer for the owner.
fresh; run "" ""
check "pressing Return leaves both as they are, and updates are not paused" 'untouched && [[ "$out" == *"The server was left as it is."*"The runtime was left as it is."*"Nothing was rolled back, so updates are not paused."* ]] && [ ! -e "$data/deploy-hold" ] && [ "$st" = 0 ]'
check "updates were paused while it waited for an answer, so what it showed could not change under it" '[ "$(<"$fx/hold-while-asking")" = 1 ]'
fresh; run rollback yes
check "a different answer changes nothing" 'untouched && [ ! -e "$data/deploy-hold" ]'
fresh; run ROLLBACK ""
check "one can go back without the other" '[ "$(<"$data/server.mjs")" = "server v2" ] && [ "$(live)" = "$C3" ] && [[ "$out" == *"The runtime was left as it is."* ]] && [ -s "$data/deploy-hold" ] && ! grep -q "com.flint.runtime" "$fx/calls.log"'
fresh; piped
check "with ROLLBACK piped in it refuses" '[ "$st" = 1 ] && [[ "$out" == "Run this yourself in Terminal: it asks you to confirm before it changes anything." ]] && untouched && [ ! -e "$data/deploy-hold" ]'

# 5. The runtime goes back to the release that ran before this one, not to the next folder by date.
#    The second release never came up (its folder is still newer than the first's), and the first
#    is the one written down.
fresh; print -r -- "$C1 $(( now - 200000 ))" > "$rt/version.prev"; run "" ROLLBACK
check "a release that never ran is passed over for the one that did" '[ "$(live)" = "$C1" ] && [[ "$out" == *"The one before it is version $s1, installed 2 days ago."*"The runtime is back on version $s1, and it answers."* ]]'
# A line that is not about the running release says nothing: the next folder down, by name only.
fresh; print -r -- "$C1 $(( now - 720 ))" > "$rt/version"; run "" ROLLBACK
check "a version line for another release is not believed" '[ "$(live)" = "$C3" ] && [[ "$out" == *"Flint has no record of the one before it. The next oldest it kept is version $s2, installed 2 days ago."*"Type $s2 to go back to it anyway"* ]]'

# 6. Versions Flint cannot name or check: said plainly, and only a deliberate answer goes back.
fresh; rm "$data/server.version" "$data/server.version.prev"; run ROLLBACK ""
check "a bundle with no version line is offered by its age alone, and ROLLBACK is not enough" 'untouched && [[ "$out" == *"The server is on a version Flint has no name for, installed less than a minute ago."*"Flint kept the one before it, installed less than a minute ago, and has no name for it."*"Flint could not check whether going back would undo a revert."*"Type UNNAMED to go back to it anyway"* ]]'
run UNNAMED ""
check "the word it asks for goes back" '[ "$(<"$data/server.mjs")" = "server v2" ] && [[ "$out" == *"The server is back on the earlier version, and it answers."* ]] && [ ! -e "$data/server.version" ]'
U="$(printf 'e%.0s' {1..40})"
fresh; print -r -- "$U $(( now - 10860 ))" > "$data/server.version.prev"; run ROLLBACK ""
check "a version the checkout does not know cannot be checked, so it is asked for by name" 'untouched && [[ "$out" == *"Flint could not check whether going back would undo a revert."*"Type eeeeeee to go back to it anyway"* ]]'

# 7. An earlier version that does not answer: the current one is put back, and updates are not paused.
fresh; print -r -- "server v2 bad" > "$data/server.mjs.prev"; : > "$rt/releases/$C2/bad"; run ROLLBACK ROLLBACK
check "a previous server that does not answer is replaced by the current one" '[ "$(<"$data/server.mjs")" = "server v3" ] && [[ "$(<"$data/server.version")" == "$C3 "* ]] && [[ "$out" == *"The earlier server did not start, so Flint put the current one back. It answers."* ]]'
check "a previous runtime that does not answer is replaced by the current one" '[ "$(live)" = "$C3" ] && [[ "$(<"$rt/version")" == "$C3 "* && "$(<"$rt/version.prev")" == "$C2 "* ]] && [[ "$out" == *"The earlier runtime did not start, so Flint put the current one back. It answers."* ]]'
check "nothing was rolled back, so updates are not paused" '[ ! -e "$data/deploy-hold" ] && [[ "$out" == *"Nothing was rolled back, so updates are not paused."* ]]'
fresh; : > "$rt/releases/$C2/bad"; run ROLLBACK ROLLBACK
check "when only one of them went back, updates are paused all the same" '[ "$(<"$data/server.mjs")" = "server v2" ] && [ "$(live)" = "$C3" ] && [ -s "$data/deploy-hold" ]'
fresh; print -r -- "server v3 bad" > "$data/server.mjs"; print -r -- "server v2 bad" > "$data/server.mjs.prev"; run ROLLBACK ""
check "when neither server answers, the current one is left in place, it says to ask, and updates are not paused" '[ "$(<"$data/server.mjs")" = "server v3 bad" ] && [[ "$out" == *"Neither version of the server answers. Ask for help before doing more."* ]] && [ ! -e "$data/deploy-hold" ]'

# 8. The last runtime update changed the database: the runtime is never rolled back, nor offered.
fresh migration; run ROLLBACK ROLLBACK
check "a database update is never undone: the runtime stays" '[ "$(live)" = "$C3" ] && [[ "$out" == *"changed the database, and a database update is never undone automatically. The runtime was left as it is."* && "$out" != *"leave the runtime as it is"* ]]'
check "the runtime was not restarted" '! grep -q "com.flint.runtime" "$fx/calls.log"'
check "the server still went back" '[ "$(<"$data/server.mjs")" = "server v2" ]'
fresh; rm -rf "${home:?}/flint"; run "" ROLLBACK
check "when it cannot tell whether the database changed, the runtime stays" '[ "$(live)" = "$C3" ] && [[ "$out" == *"could not tell whether the last runtime update changed the database"* ]]'

# 9. An update is being installed right now: nothing is touched, and no pause is left behind.
fresh; : > "$fx/deploy-running"; run ROLLBACK ROLLBACK
check "while an update is installing it stops" '[ "$st" = 1 ] && [[ "$out" == *"An update is being installed right now. Wait two minutes and run this again. Nothing was changed."* ]]'
check "having changed nothing, and left updates running" 'untouched && [ ! -e "$data/deploy-hold" ]'
print -r -- "paused by hand" > "$data/deploy-hold"; run ROLLBACK ROLLBACK
check "a pause that was already there is not lifted by a run that stops" '[ "$st" = 1 ] && [ "$(<"$data/deploy-hold")" = "paused by hand" ]'

# A pause that was there before: one made by hand is left exactly as it was. One that a database
# restore made is lifted when that restore ends, so a rollback that went back makes it its own.
fresh; print -r -- "paused by hand" > "$data/deploy-hold"; run ROLLBACK ""
check "a pause made by hand is left as it was by a run that goes back" '[ "$(<"$data/server.mjs")" = "server v2" ] && [ "$(<"$data/deploy-hold")" = "paused by hand" ] && [[ "$out" == *"Updates are paused, so nothing replaces what you went back to."* ]]'
fresh; print -r -- "restore 4242 2026-10-12T18:00:00.000Z" > "$data/deploy-hold"; run ROLLBACK ""
check "a pause a database restore made becomes the rollback's own, so it outlasts the restore" '[ "$(<"$data/server.mjs")" = "server v2" ] && [[ "$(<"$data/deploy-hold")" == "Paused by rollback.sh on "* ]]'
fresh; print -r -- "restore 4242 2026-10-12T18:00:00.000Z" > "$data/deploy-hold"; run "" ""
check "and is left to the restore by a run that goes back to nothing" '[[ "$(<"$data/deploy-hold")" == "restore 4242 "* ]] && [[ "$out" == *"Nothing was rolled back. Updates were already paused, and they still are."* ]]'

# 10. Nothing earlier to go back to; no Flint at all; a stray option.
fresh; rm "$data/server.mjs.prev"; rm -rf "${rt:?}/releases/${C1:?}" "${rt:?}/releases/${C2:?}"; run ROLLBACK ROLLBACK
check "with no earlier versions it says so, asks nothing, and does not pause updates" '[ "$st" = 0 ] && [[ "$out" == *"There is no earlier server version to go back to"*"There is no earlier runtime version to go back to"*"Nothing was rolled back, so updates are not paused."* && "$out" != *"Type "* ]] && [ ! -e "$data/deploy-hold" ]'
fresh; cp "$data/server.mjs" "$data/server.mjs.prev"; run ROLLBACK ""
check "a previous server identical to the current one is not a version to go back to" '[[ "$out" == *"There is no earlier server version to go back to"* ]] && [ ! -e "$data/server.mjs.rolled-back" ]'
rm -rf "${fx:?}/home"; mkdir -p "$fx/home"; run ROLLBACK ROLLBACK
check "with no Flint on the Mac it says so and makes nothing" '[ "$st" = 1 ] && [[ "$out" == "There is no Flint on this Mac to roll back." ]] && [ ! -e "$fx/home/.flint" ]'
fresh; run ROLLBACK ROLLBACK --force
check "it takes no options" '[ "$st" = 1 ] && [[ "$out" == *"This takes no options."* ]] && untouched && [ ! -e "$data/deploy-hold" ]'

(( fail )) && exit 1
print "ok: rollback names both versions and asks first, refuses to undo a revert unless told to by name, keeps what it replaced, never undoes a database update, and pauses updates only when it went back"
