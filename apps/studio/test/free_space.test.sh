#!/bin/zsh
# free_space.sh, in a stand-in home folder and a stand-in temp folder: nothing here reads or
# changes the real ~/.flint, the real backups or the real temp folder.
#  - with no option it lists what Flint keeps, by size, and what could go, and removes nothing;
#  - --remove takes only rotated logs and the runtime versions beyond the ones the installer
#    keeps: never the log being written, the running version, the one before it, a pinned one,
#    a link, or anything that only looks like one of them;
#  - --remove-test-leftovers takes only folders whose whole name is one of the tests' own and the
#    six characters the system adds, that are this user's and a day old: never a young one, a
#    file, a link, a longer or shorter name, or a folder with Flint's name the tests did not make;
#  - every line it prints is a sentence, or a command on a line of its own.
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
  # The temp folder. Names the tests use: flint-r41-, deploy-events-, tok-, flint-t- and flint-t. (the run folders).
  for name in flint-r41-AbC123 deploy-events-000000 tok-zzzzzz flint-t-Run001 flint-t.Run002; do
    mkdir -p "$tmp/$name/inner"; head -c 50000 /dev/urandom > "$tmp/$name/inner/file"; old "$tmp/$name" 3
  done
  mkdir "$tmp/flint-r41-Young1"                                   # made a minute ago: a test may be using it
  mkdir "$tmp/flint-r41-AbC12" "$tmp/flint-r41-AbC1234" "$tmp/flint-r41-AbC_12" "$tmp/xflint-r41-AbC123"   # not the six characters, or not the name
  mkdir "$tmp/flint-reference-AbC123" "$tmp/flint-restore-file.AbC123" "$tmp/flint-mystery-AbC123"   # Flint's own programs', and one nobody knows
  mkdir "$tmp/com.apple.something" "$tmp/TemporaryItems" "$tmp/tok" "$tmp/install-"
  print -r -- "a file" > "$tmp/flint-r41-File01"
  ln -s "$fx/outside/release" "$tmp/flint-r41-Link01"
  for d in "$tmp"/flint-r41-AbC12 "$tmp"/flint-r41-AbC1234 "$tmp"/flint-r41-AbC_12 "$tmp"/xflint-r41-AbC123 "$tmp"/flint-reference-AbC123 "$tmp"/flint-restore-file.AbC123 \
           "$tmp"/flint-mystery-AbC123 "$tmp"/com.apple.something "$tmp"/TemporaryItems "$tmp"/tok "$tmp"/install- "$tmp"/flint-r41-File01; do old "$d" 5; done
}
listing() { ( cd "$fx" && find home tmp outside | LC_ALL=C sort ); }
sentences() { # every line is a sentence, or a command on a line of its own
  local bad
  bad="$(print -r -- "$out" | grep -vE "^[A-Z].*\.$|^[A-Z].*:$|^  ~/flint/apps/studio/free_space\.sh --remove(-test-leftovers)?$")"
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
check "it counts what the tests left: five folders, a day old or more" '[[ "$out" == *"Flint'"'"'s own tests left 5 temp folders more than a day ago, less than 1 MB in all."* ]]'
check "a folder with Flint's name that no test made is counted apart, and left" '[[ "$out" == *"Flint leaves 6 other old temp folders that have its name and are not from a test it knows."* ]]'
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
check "the five are gone, with what was in them" '[ ! -e "$tmp/flint-r41-AbC123" ] && [ ! -e "$tmp/deploy-events-000000" ] && [ ! -e "$tmp/tok-zzzzzz" ] && [ ! -e "$tmp/flint-t-Run001" ] && [ ! -e "$tmp/flint-t.Run002" ]'
check "one made a minute ago is left: a test may be using it" '[ -d "$tmp/flint-r41-Young1" ]'
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
build; chmod 500 "$tmp/tok-zzzzzz/inner"   # what is in it cannot be removed
run --remove-test-leftovers
check "a folder that will not go is counted as left" '[[ "$out" == *"Flint removed 4 temp folders"*"It left 1 temp folder that had changed or would not go."* ]] && [ -d "$tmp/tok-zzzzzz" ]'
chmod -R u+rwx "$tmp" 2>/dev/null

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
print "ok: free_space.sh lists what Flint keeps and removes only rotated logs, old runtime versions and its tests' day-old leftovers, each only when asked"
