#!/bin/zsh
# free_space.sh, in a stand-in home folder and a stand-in temp folder: nothing here reads or
# changes the real ~/.flint, the real backups or the real temp folder.
#  - with no option it lists what Flint keeps, by size, and what could go, and removes nothing;
#  - --remove takes only rotated logs and the runtime versions beyond the ones the installer
#    keeps: never the log being written, the running version, the one before it, a pinned one,
#    a link, or anything that only looks like one of them;
#  - --remove-test-leftovers takes only folders whose whole name is one of the tests' own and the
#    six characters the system adds (a digit or a capital among them), that are this user's and a
#    day old: never a young one, a file, a link, a longer or shorter name, a name that reads like
#    a word, a folder with Flint's name the tests did not make, or another program's folder under
#    a short plain name the tests once used too (ws-, tok-, export-, install-);
#  - it leaves one that holds a socket, one with anything in it changed in the last day, and one
#    it cannot look into;
#  - the listing names the first twenty of them and says how many more there are;
#  - every line it prints is a sentence, a command on a line of its own, or a folder's name.
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
set -u
here=${0:A:h}
studio=${here:h}
repo=${studio:h:h}
script="$studio/free_space.sh"
fx="$(mktemp -d "${${TMPDIR:-/tmp}%/}/flint-free.XXXXXX")" || exit 1; fx=${fx:A}
trap 'chmod -R u+rwx "$fx" 2>/dev/null; rm -rf "${fx:?}"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

home="$fx/home" tmp="$fx/tmp" data="$fx/home/.flint" rel="$fx/home/.flint/runtime/releases"
sha() { printf '%040x' "$1"; }
# old <path> <days>: set its time to that many days ago.
old() { touch -t "$(date -v-"$2"d +%Y%m%d%H%M)" "$1"; }
# old_all <folder> <days>: the folder and everything in it, as a test that ended that long ago left them.
old_all() { find "$1" -depth -exec touch -t "$(date -v-"$2"d +%Y%m%d%H%M)" {} +; }
# leftover <name> <days>: a scratch folder a test left in the temp folder, with something in it.
leftover() { mkdir -p "$tmp/$1/inner"; head -c 50000 /dev/urandom > "$tmp/$1/inner/file"; old_all "$tmp/$1" "$2"; }
run() { out="$(env -i HOME="$home" TMPDIR="$tmp" PATH="/usr/bin:/bin" /bin/zsh "$script" "$@" 2>&1)"; st=$?; }

build() {
  chmod -R u+rwx "$fx" 2>/dev/null; rm -rf "$home" "$tmp" "$fx/outside"
  mkdir -p "$data/sub" "$rel" "$home/FlintBackups/pg" "$tmp" "$fx/outside"
  # Logs: two being written, and what the nightly backup rotated.
  print -r -- "live" > "$data/server.out.log"; print -r -- "live" > "$data/ollama.err.log"
  for n in 1 2 3; do head -c 300000 /dev/urandom > "$data/ollama.err.log.$n.gz"; done
  head -c 2000 /dev/urandom > "$data/server.out.log.1"          # a rotation that was cut short
  # Not rotated logs, whatever they look like.
  print -r -- "keep" > "$data/notes.log.1.gz.txt"
  print -r -- "keep" > "$data/server.out.log.old"
  print -r -- "keep" > "$data/sub/deep.log.1.gz"
  mkdir "$data/folder.log.1.gz"
  print -r -- "outside" > "$fx/outside/target.gz"; ln -s "$fx/outside/target.gz" "$data/linked.log.1.gz"
  # Runtime versions: 1 is the oldest, 7 the newest. 7 runs, 6 ran before it, 2 is pinned.
  for n in 1 2 3 4 5 6 7; do mkdir "$rel/$(sha $n)"; head -c 100000 /dev/urandom > "$rel/$(sha $n)/bundle.mjs"; old "$rel/$(sha $n)" $(( 20 - n )); done
  ln -s "$rel/$(sha 7)" "$data/runtime/current"
  print -r -- "$(sha 7) 1791000000" > "$data/runtime/version"
  print -r -- "$(sha 6) 1790000000" > "$data/runtime/version.prev"
  print -r -- "$(sha 2)" > "$data/runtime/pinned"
  mkdir "$rel/not-a-commit"; old "$rel/not-a-commit" 30
  mkdir "$fx/outside/release"; ln -s "$fx/outside/release" "$rel/$(sha 99)"
  print -r -- "a backup" > "$home/FlintBackups/pg/flint-x.dump"
  # The temp folder. Names the tests use: flint-r41-, flint-pg-, flint-t- and flint-t. (the run folders).
  for name in flint-r41-AbC123 flint-pg-9zzzzz flint-r41-zzzzzZ flint-t-Run001 flint-t.Run002; do leftover "$name" 3; done
  mkdir "$tmp/flint-r41-Young1"                                   # made a minute ago: a test may be using it
  # A test's name and six small letters: it reads like a word another program chose, and is left.
  for name in flint-r41-server flint-pg-backup; do leftover "$name" 3; done
  # Short plain names the tests once used too, and so may another program: never on the list, whatever follows.
  for name in deploy-events-000000 tok-zzzzzz ws-Ab12Cd ws-server export-photos install-helper tok-cached; do leftover "$name" 3; done
  # In use, or not known not to be: a socket in it, something in it written a moment ago, a part that cannot be read.
  leftover flint-pg-Sock01 3; ( cd "$tmp/flint-pg-Sock01" && zmodload zsh/net/socket && zsocket -l s ) 2>/dev/null; old_all "$tmp/flint-pg-Sock01" 3
  leftover flint-r41-Fresh1 3; print -r -- "written now" > "$tmp/flint-r41-Fresh1/inner/now"; old "$tmp/flint-r41-Fresh1/inner" 3; old "$tmp/flint-r41-Fresh1" 3
  leftover flint-r41-Lock01 3; chmod 000 "$tmp/flint-r41-Lock01/inner"
  mkdir "$tmp/flint-r41-AbC12" "$tmp/flint-r41-AbC1234" "$tmp/flint-r41-AbC_12" "$tmp/xflint-r41-AbC123"   # not the six characters, or not the name
  mkdir "$tmp/flint-reference-AbC123" "$tmp/flint-restore-file.AbC123" "$tmp/flint-mystery-AbC123"   # Flint's own programs', and one nobody knows
  mkdir "$tmp/com.apple.something" "$tmp/TemporaryItems" "$tmp/tok" "$tmp/install-"
  print -r -- "a file" > "$tmp/flint-r41-File01"
  ln -s "$fx/outside/release" "$tmp/flint-r41-Link01"; touch -h -t "$(date -v-5d +%Y%m%d%H%M)" "$tmp/flint-r41-Link01"; old "$fx/outside/release" 5   # a link as old as a leftover, to a folder as old
  for d in "$tmp"/flint-r41-AbC12 "$tmp"/flint-r41-AbC1234 "$tmp"/flint-r41-AbC_12 "$tmp"/xflint-r41-AbC123 "$tmp"/flint-reference-AbC123 "$tmp"/flint-restore-file.AbC123 \
           "$tmp"/flint-mystery-AbC123 "$tmp"/com.apple.something "$tmp"/TemporaryItems "$tmp"/tok "$tmp"/install- "$tmp"/flint-r41-File01; do old "$d" 5; done
}
listing() { ( cd "$fx" && find home tmp outside | LC_ALL=C sort ); }
sentences() { # every line is a sentence, or a command on a line of its own
  local bad
  bad="$(print -r -- "$out" | grep -vE "^[A-Z].*\.$|^[A-Z].*:$|^  ~/flint/apps/studio/free_space\.sh --remove(-test-leftovers)?$|^  flint-[A-Za-z0-9._-]+$")"
  [[ -n $bad ]] && print -r -- "  not a sentence: ${bad//$'\n'/ | }"
  [[ -z $bad ]] && [[ $out != *"(s)"* && $out != *"("* && $out != *"$fx"* && $out != *"/var/"* ]]
}

# ---- 1. With no option it lists, and removes nothing ---------------------------------
build
before="$(listing)"
run
check "it lists and exits well" '[ "$st" = 0 ]'
check "nothing at all was removed or changed" '[ "$before" = "$(listing)" ]'
check "it says how much room is free and what Flint keeps, by size" '[[ "$out" == "This Mac has "*" free."*"Flint'"'"'s own files and its runtime take "*"Its backups on this Mac take less than 1 MB."* ]]'
check "it counts the rotated logs: the three the backup rotated and the one cut short, never a live log or a lookalike" '[[ "$out" == *"There are 4 rotated logs, less than 1 MB in all."* ]]'
check "it counts the runtime versions beyond the ones Flint keeps: three of seven" '[[ "$out" == *"There are 3 runtime versions beyond the ones Flint keeps, less than 1 MB in all."* ]]'
check "the fixture has a socket in it" '[ -S "$tmp/flint-pg-Sock01/s" ]'
check "it counts what the tests left: five folders, a day old or more" '[[ "$out" == *"Flint'"'"'s own tests left 5 temp folders more than a day ago, less than 1 MB in all."* ]]'
want=$'They are these:\n  flint-pg-9zzzzz\n  flint-r41-AbC123\n  flint-r41-zzzzzZ\n  flint-t-Run001\n  flint-t.Run002'
check "it names them, each on a line of its own" '[[ "$out" == *"$want"* ]] && [ "$(print -r -- "$out" | grep -c "^  flint-")" = 5 ]'
check "it says how many it leaves because they are in use, changed in the last day, or cannot be looked into" '[[ "$out" == *"Flint leaves 3 temp folders of its tests that are in use or changed in the last day."* ]]'
check "a folder with Flint's name that no test made, or whose six characters read like a word, is counted apart, and left" '[[ "$out" == *"Flint leaves 8 other old temp folders that have its name and are not from a test it knows."* ]]'
check "a short plain name the tests once used is not named or counted at all" '[[ "$out" != *"ws-"* && "$out" != *"tok-"* && "$out" != *"export-"* && "$out" != *"install-helper"* && "$out" != *"deploy-events"* ]]'
want=$'To remove the rotated logs and the old runtime versions, run this:\n  ~/flint/apps/studio/free_space.sh --remove\nTo remove what the tests left, run this:\n  ~/flint/apps/studio/free_space.sh --remove-test-leftovers\nNothing was removed.'
check "it ends with the two commands, each on a line of its own, and says nothing was removed" '[ "$(print -r -- "$out" | tail -5)" = "$want" ]'
check "every line is a sentence or a command, with no path and no bracketed plural" 'sentences'

# ---- 2. --remove: rotated logs and old runtime versions, and nothing else ---------------
run --remove
check "--remove exits well and says what it did" '[ "$st" = 0 ] && [[ "$out" == *"Flint is removing 4 rotated logs and 3 old runtime versions."*"Flint removed 7 things and freed "*"."* ]]'
check "the rotated logs are gone" '[ -z "$(print -r -- "$data"/*.log.[0-9](N) "$data"/ollama.err.log.[0-9].gz(N))" ]'
check "the logs being written are as they were" '[ "$(<"$data/server.out.log")" = live ] && [ "$(<"$data/ollama.err.log")" = live ]'
check "what only looked like a rotated log is still there: another name, a folder, one in a folder below, a link and what it points at" \
  '[ -f "$data/notes.log.1.gz.txt" ] && [ -f "$data/server.out.log.old" ] && [ -f "$data/sub/deep.log.1.gz" ] && [ -d "$data/folder.log.1.gz" ] && [ -L "$data/linked.log.1.gz" ] && [ "$(<"$fx/outside/target.gz")" = outside ]'
check "the three versions past the newest three went: not the running one, the one before it, or the pinned one" \
  '[ "$(print -r -- "$rel"/*(N/:t) | tr " " "\n" | LC_ALL=C sort | tr "\n" " ")" = "$(sha 2) $(sha 5) $(sha 6) $(sha 7) not-a-commit " ]'
check "a link among the versions, and what it points at, are untouched" '[ -L "$rel/$(sha 99)" ] && [ -d "$fx/outside/release" ]'
check "the backups and the temp folder were not touched" '[ -f "$home/FlintBackups/pg/flint-x.dump" ] && [ -d "$tmp/flint-r41-AbC123" ]'
check "every line is a sentence" 'sentences'
run --remove
check "run again, there is nothing more to remove, and it says so" '[ "$st" = 0 ] && [[ "$out" == *"There are no rotated logs and no old runtime versions to remove."* ]]'

# The running version, the one that ran before it, the one the installer last wrote down and a pinned one are each
# kept by their own rule: here none of them is among the three newest, so nothing else keeps it.
build
for n in 8 9; do mkdir "$rel/$(sha $n)"; old "$rel/$(sha $n)" $(( 20 - n )); done
rm "$data/runtime/current"; ln -s "$rel/$(sha 1)" "$data/runtime/current"
print -r -- "$(sha 4) 1791000000" > "$data/runtime/version"
print -r -- "$(sha 3) 1790000000" > "$data/runtime/version.prev"
print -r -- "$(sha 2)" > "$data/runtime/pinned"
run --remove
check "of nine versions, the two that nothing keeps go" '[[ "$out" == *"Flint is removing 4 rotated logs and 2 old runtime versions."* ]]'
check "the oldest stays because it is running, and the others by the record of what ran before, what was installed last and what is pinned" \
  '[ "$(print -r -- "$rel"/*(N/:t) | tr " " "\n" | LC_ALL=C sort | tr "\n" " ")" = "$(sha 1) $(sha 2) $(sha 3) $(sha 4) $(sha 7) $(sha 8) $(sha 9) not-a-commit " ]'
# With no way to tell which version is running, no version is removed.
build; rm "$data/runtime/current"
run --remove
check "when the running version cannot be told, every version is kept, and it says so" \
  '[[ "$out" == *"Flint could not tell which runtime version is running, so it leaves every one of them."* ]] && [ "$(print -r -- "$rel"/*(N/) | wc -w | tr -d " ")" = 8 ]'
check "the rotated logs still go" '[[ "$out" == *"Flint is removing 4 rotated logs and 0 old runtime versions."* ]] && [ ! -e "$data/ollama.err.log.1.gz" ]'
# Three or fewer: the installer's own rule keeps them all.
build; rm -rf "$rel/$(sha 1)" "$rel/$(sha 2)" "$rel/$(sha 3)" "$rel/$(sha 4)"
run
check "three versions or fewer are all kept" '[[ "$out" != *"beyond the ones Flint keeps"* ]] && [ "$(print -r -- "$rel"/*(N/) | wc -w | tr -d " ")" = 4 ]'

# ---- 3. --remove-test-leftovers: only what the tests left, a day old, by its whole name ----
build
kept_before="$(cd "$fx" && find home outside | LC_ALL=C sort)"
run --remove-test-leftovers
check "--remove-test-leftovers exits well and says what it did" '[ "$st" = 0 ] && [[ "$out" == *"Flint is removing 5 temp folders its own tests left."*"Flint removed 5 temp folders and freed "*"."* ]]'
check "the five are gone, with what was in them" '[ ! -e "$tmp/flint-r41-AbC123" ] && [ ! -e "$tmp/flint-pg-9zzzzz" ] && [ ! -e "$tmp/flint-r41-zzzzzZ" ] && [ ! -e "$tmp/flint-t-Run001" ] && [ ! -e "$tmp/flint-t.Run002" ]'
check "one made a minute ago is left: a test may be using it" '[ -d "$tmp/flint-r41-Young1" ]'
check "a test's name followed by six small letters reads like a word, and is left with what is in it" '[ -f "$tmp/flint-r41-server/inner/file" ] && [ -f "$tmp/flint-pg-backup/inner/file" ]'
check "another program's folder under a short plain name is left with what is in it, whatever follows the name" \
  '[ -f "$tmp/deploy-events-000000/inner/file" ] && [ -f "$tmp/tok-zzzzzz/inner/file" ] && [ -f "$tmp/ws-Ab12Cd/inner/file" ] && [ -f "$tmp/ws-server/inner/file" ] && [ -f "$tmp/export-photos/inner/file" ] && [ -f "$tmp/install-helper/inner/file" ] && [ -f "$tmp/tok-cached/inner/file" ]'
check "one that holds a socket is left: something may be listening there" '[ -S "$tmp/flint-pg-Sock01/s" ] && [ -f "$tmp/flint-pg-Sock01/inner/file" ]'
check "one with something in it written a moment ago is left, though the folder itself is days old" '[ -f "$tmp/flint-r41-Fresh1/inner/now" ] && [ -f "$tmp/flint-r41-Fresh1/inner/file" ]'
check "one with a part that cannot be looked into is left" '[ -d "$tmp/flint-r41-Lock01/inner" ]'
check "a name one character short, one long, or with another character in it is left" '[ -d "$tmp/flint-r41-AbC12" ] && [ -d "$tmp/flint-r41-AbC1234" ] && [ -d "$tmp/flint-r41-AbC_12" ] && [ -d "$tmp/xflint-r41-AbC123" ]'
check "a working folder of Flint's own programs is left, and so is one nobody knows" '[ -d "$tmp/flint-reference-AbC123" ] && [ -d "$tmp/flint-restore-file.AbC123" ] && [ -d "$tmp/flint-mystery-AbC123" ]'
check "everything else in the temp folder is left: other programs' folders, a bare prefix, a file, a link and what it points at" \
  '[ -d "$tmp/com.apple.something" ] && [ -d "$tmp/TemporaryItems" ] && [ -d "$tmp/tok" ] && [ -d "$tmp/install-" ] && [ -f "$tmp/flint-r41-File01" ] && [ -L "$tmp/flint-r41-Link01" ] && [ -d "$fx/outside/release" ]'
check "the home folder was not touched: no log, no version, no backup" '[ "$kept_before" = "$(cd "$fx" && find home outside | LC_ALL=C sort)" ]'
check "every line is a sentence" 'sentences'
run --remove-test-leftovers
check "run again, there is nothing more to remove" '[[ "$out" == *"There are no test leftovers to remove."* ]]'
# Both at once.
build
run --remove --remove-test-leftovers
check "both options together do both" '[ ! -e "$data/ollama.err.log.1.gz" ] && [ ! -e "$rel/$(sha 1)" ] && [ ! -e "$tmp/flint-r41-AbC123" ] && [ -d "$tmp/flint-r41-Young1" ] && [ -d "$rel/$(sha 7)" ]'
# A leftover that will not go is said, never passed over.
build; chmod 500 "$tmp/flint-r41-AbC123/inner"   # what is in it cannot be removed
run --remove-test-leftovers
check "a folder that will not go is counted as left" '[[ "$out" == *"Flint removed 4 temp folders"*"It left 1 temp folder that had changed or would not go."* ]] && [ -d "$tmp/flint-r41-AbC123" ]'
chmod -R u+rwx "$tmp" 2>/dev/null
# More than twenty: the first twenty by name, and how many more.
build; for n in {10..25}; do leftover "flint-agent-Xy00$n" 2; done
run
check "with 21 it names the first twenty and says there is one more" \
  '[[ "$out" == *"Flint'"'"'s own tests left 21 temp folders more than a day ago"*"The first 20 are these:"*"There is 1 more."* ]] && [ "$(print -r -- "$out" | grep -c "^  flint-")" = 20 ]'
check "every line is a sentence, a command or a folder's name" 'sentences'
for n in {26..31}; do leftover "flint-agent-Xy00$n" 2; done
run
check "with 27 it names the first twenty and says there are seven more" '[[ "$out" == *"The first 20 are these:"*"There are 7 more."* ]] && [ "$(print -r -- "$out" | grep -c "^  flint-")" = 20 ]'
run --remove-test-leftovers
check "all 27 go, in batches, and the ones in use still stay" '[[ "$out" == *"Flint removed 27 temp folders and freed "* ]] && [ -z "$(print -r -- "$tmp"/flint-agent-*(N))" ] && [ -S "$tmp/flint-pg-Sock01/s" ] && [ -f "$tmp/flint-r41-Fresh1/inner/now" ]'
# More than one batch of them (they are looked at, and go, two hundred at a time).
build; many=(); for n in {1000..1204}; do many+=("$tmp/flint-bk-Zz$n"); done; mkdir $many; touch -t "$(date -v-2d +%Y%m%d%H%M)" $many
run --remove-test-leftovers
check "more than two hundred go, batch after batch, and the ones in use still stay" \
  '[[ "$out" == *"Flint is removing 210 temp folders its own tests left."*"Flint removed 210 temp folders and freed "* ]] && [ -z "$(print -r -- "$tmp"/flint-bk-*(N))" ] && [ -S "$tmp/flint-pg-Sock01/s" ] && [ -d "$tmp/flint-r41-server" ]'
build; rm -rf "$tmp"/flint-t-Run001 "$tmp"/flint-t.Run002 "$tmp"/flint-pg-9zzzzz "$tmp"/flint-r41-zzzzzZ "$tmp"/flint-r41-Fresh1 "$tmp"/flint-r41-Lock01(N) 2>/dev/null; chmod -R u+rwx "$tmp" 2>/dev/null; rm -rf "$tmp/flint-r41-Lock01"
run
check "one leftover and one in use: each said in the singular" '[[ "$out" == *"Flint'"'"'s own tests left 1 temp folder more than a day ago"*$'"'"'It is this one:\n  flint-r41-AbC123\n'"'"'*"Flint leaves 1 temp folder of its tests that is in use or changed in the last day."* ]]'

# ---- 4. It takes nothing else -----------------------------------------------------
build; before="$(listing)"
for bad in --yes --all "--remove=1" stray "-r"; do
  run "$bad"
  check "the option $bad is refused, and nothing is removed" '[ "$st" = 1 ] && [[ "$out" == "The only options are --remove and --remove-test-leftovers." ]] && [ "$before" = "$(listing)" ]'
done
# With nothing to remove it says so.
rm -rf "$home" "$tmp"; mkdir -p "$data" "$tmp"
run
check "with nothing to remove it says so" '[ "$st" = 0 ] && [ "$(print -r -- "$out" | tail -2)" = "$(print -r -- "There is nothing here for Flint to remove."; print -r -- "Nothing was removed.")" ]'

# ---- 5. The list of the tests' names ------------------------------------------------
list="$repo/test-support/temp-prefixes"
names=("${(@f)$(grep -v '^#' "$list" | grep -v '^$')}")
check "the list is there, one name on a line, each ending in the character the system's part follows" '(( ${#names} > 50 )) && [ -z "$(print -rl -- $names | grep -vE "^[A-Za-z0-9][A-Za-z0-9._-]*[-.]\$")" ]'
check "every name on it is Flint's own: none is a short plain name another program may use too" '[ -z "$(print -rl -- $names | grep -v "^flint-")" ]'
check "the run folders' own names are on it" '(( ${names[(Ie)flint-t-]} )) && (( ${names[(Ie)flint-t.]} ))'
check "no name is on it twice" '[ "$(print -rl -- $names | sort | uniq -d | wc -l | tr -d " ")" = 0 ]'
# The names the run folders really get are the ones on the list.
check "the vitest run folder's name is the one on the list" 'grep -q "TEMP_ROOT_PREFIX = '"'"'flint-t-'"'"'" "$repo/test-support/temp-root.ts"'
check "the studio tests' run folder's name is the one on the list" 'grep -q "/flint-t.XXXXXX\"" "$here/temp_root.zsh"'
# No name on it is one Flint's own programs give a working folder (a restore's, a rebuild's): those are never a test's to clear.
own=(
  "${(@f)$(grep -rhoE "tmpdir\(\), *['\"\`][A-Za-z0-9._-]+['\"\`]" --include='*.ts' --exclude='*.test.ts' "$repo"/apps/*/src "$repo"/packages/*/src 2>/dev/null | sed -E "s/.*['\"\`]([A-Za-z0-9._-]+)['\"\`]\$/\1/")}"
  "${(@f)$(grep -hoE "mktemp[^|;]*/[A-Za-z0-9._-]+X{4,}" "$repo"/apps/*/*.sh 2>/dev/null | sed -E 's/.*\/([A-Za-z0-9._-]+[.-])X+$/\1/')}"
)
own=(${(u)own:#})
check "the scan found the programs' own working folders" '(( ${own[(Ie)flint-reference-]} )) && (( ${own[(Ie)flint-restore-file.]} ))'
clash=()
for o in $own; do (( ${names[(Ie)$o]} )) && clash+=("$o"); done
check "no name on the list is one of the programs' own: ${clash[*]:-none}" '(( ${#clash} == 0 ))'

(( fail )) && exit 1
print "ok: free_space.sh lists what Flint keeps and removes only rotated logs, old runtime versions and its tests' day-old leftovers by their own names, each only when asked"
