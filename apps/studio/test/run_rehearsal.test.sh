#!/bin/zsh
# run_rehearsal.sh, in a scratch checkout with a stand-in for the rehearsal
# itself and a scratch home folder: the real rehearsal is not run here (that is
# rebuild_rehearse.test.sh), and nothing reaches the real ~/.flint or the screen.
# Run: zsh apps/studio/test/run_rehearsal.test.sh
#
# What must hold:
#  - it runs the rehearsal for real (never a skip that reads as a pass), with
#    the screen's stand-ins first on its PATH;
#  - it writes one line saying how it went, and nothing else, into ~/.flint;
#  - a failure is said in sentences, and the rehearsal's own output is kept for
#    the log;
#  - on a Mac with no Flint it writes nothing.
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
set -u
here=${0:A:h}
fx="$(mktemp -d "${${TMPDIR:-/tmp}%/}/flint-run-rehearsal.XXXXXX")" || exit 1; fx=${fx:A}; trap 'rm -rf "${fx:?}"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

# A scratch checkout: the real script, beside a rehearsal that does what the fixture tells it to.
repo="$fx/repo"; home="$fx/home"
mkdir -p "$repo/apps/studio/test" "$repo/test-support/quiet-bin" "$fx/githome"
cp "$here/../run_rehearsal.sh" "$repo/apps/studio/run_rehearsal.sh"
print -r -- '#!/bin/sh
exit 0' > "$repo/test-support/quiet-bin/osascript"; chmod +x "$repo/test-support/quiet-bin/osascript"
print -r -- '#!/bin/zsh
print -r -- "require=${FLINT_REQUIRE_REHEARSAL:-} osascript=$(whence -p osascript) home=$HOME" > "$FX/saw"
case "$(<"$FX/mode")" in
  pass) print -r -- "ok: the rebuild rehearsal passed"; exit 0 ;;
  fail) print -r -- "FAIL the rebuilt Flint answers"; print -r -- "FAIL its database came back."; print -u2 -- "a line on the error stream"; exit 1 ;;
  skip) print -r -- "skipped: this Mac has no age"; exit 0 ;;
  crash) exit 3 ;;
esac' > "$repo/apps/studio/test/rebuild_rehearse.test.sh"
gitq() { HOME="$fx/githome" GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }
gitq -C "$repo" init -q; gitq -C "$repo" add -A; gitq -C "$repo" commit -q -m "a checkout"
sha="$(gitq -C "$repo" rev-parse HEAD)"
fresh() { rm -rf "${home:?}" "${fx:?}/saw"; mkdir -p "$home/.flint"; chmod 700 "$home/.flint"; print -r -- "$1" > "$fx/mode"; }
run() { out="$(env -i HOME="$home" FX="$fx" PATH=/usr/bin:/bin /bin/zsh "$repo/apps/studio/run_rehearsal.sh" "$@" 2>"$fx/err")"; st=$?; err="$(<"$fx/err")"; }
result() { print -r -- "$(<"$home/.flint/rehearsal-result")"; }

check "the script parses" 'zsh -n "$here/../run_rehearsal.sh"'

# 1. A pass: one line, private, and nothing else in the data folder.
fresh pass; before=$(date +%s); run
check "it succeeds, in one sentence" '[ "$st" = 0 ] && [[ "$out" =~ "^The rebuild rehearsal passed in [0-9]+ seconds\.$" ]]'
check "it writes down that it passed, when, and at which commit" '[[ "$(result)" =~ "^passed ([0-9]{10}) $sha$" ]] && (( match[1] >= before && match[1] <= before + 60 ))'
check "the line is its owner's alone, and it is the only thing written there" '[ "$(stat -f %Lp "$home/.flint/rehearsal-result")" = 600 ] && [ "$(ls -A "$home/.flint")" = rehearsal-result ]'
check "the rehearsal was told it must really run" '[[ "$(<"$fx/saw")" == "require=1 "* ]]'
check "nothing it starts can reach the screen: the stand-ins come first" '[[ "$(<"$fx/saw")" == *" osascript=$repo/test-support/quiet-bin/osascript "* ]]'
check "the rehearsal's own output is kept for the log" '[[ "$err" == "ok: the rebuild rehearsal passed" ]]'

# 2. A failure: said in sentences, written down, and the pass before it is replaced.
fresh fail; print -r -- "passed 1700000000 -" > "$home/.flint/rehearsal-result"; run
check "a failed rehearsal fails" '[ "$st" = 1 ]'
check "it says so, and which checks, each in a sentence" '[[ "$out" == "The rebuild rehearsal failed."$'"'"'\n'"'"'"This check did not pass: the rebuilt Flint answers."$'"'"'\n'"'"'"This check did not pass: its database came back." ]]'
check "it writes down that it failed" '[[ "$(result)" =~ "^failed [0-9]{10} $sha$" ]]'
check "everything the rehearsal printed is kept for the log" '[[ "$err" == *"FAIL the rebuilt Flint answers"* && "$err" == *"a line on the error stream"* ]]'

# 3. A skip proves nothing, so it is never written down as a pass.
fresh skip; run
check "a skipped rehearsal is a failed one" '[ "$st" = 1 ] && [[ "$(result)" == "failed "* ]] && [[ "$out" == *"It did not run: this Mac has no age."* ]]'
fresh crash; run
check "one that stops without a word says how to see why, with the command on its own line" '[ "$st" = 1 ] && [[ "$(result)" == "failed "* ]] && [[ "$out" == *"It did not say which check stopped it. This shows everything it prints:"$'"'"'\n'"'"'"  zsh ~/flint/apps/studio/test/rebuild_rehearse.test.sh" ]]'
bad="$(for mode in pass fail skip crash; do fresh $mode; run; print -r -- "$out"; done | grep -vE "^[A-Z].*[.:]$|^  zsh ~/flint/apps/studio/test/rebuild_rehearse\.test\.sh$" || true)"
check "every line it prints is a sentence, or a command on its own line" '[[ -z $bad ]]'

# 4. No Flint on this Mac: nothing is written, and the data folder is not made.
fresh pass; rm -rf "${home:?}/.flint"; run
check "with no Flint it still runs, and writes nothing" '[ "$st" = 0 ] && [ ! -e "$home/.flint" ]'
# A checkout that is not a git one (or a git that fails): the commit is left out, not guessed.
fresh pass; mv "$repo/.git" "$fx/git.away"; run; mv "$fx/git.away" "$repo/.git"
check "with no commit to name it writes a dash" '[[ "$(result)" =~ "^passed [0-9]{10} -$" ]]'

# 5. It takes no options, and never runs anything but the rehearsal beside it.
fresh pass; run --quick
check "it takes no options" '[ "$st" = 1 ] && [[ "$err" == "This takes no options. Run it as: ~/flint/apps/studio/run_rehearsal.sh" ]] && [ ! -e "$fx/saw" ] && [ ! -e "$home/.flint/rehearsal-result" ]'
fresh pass; mv "$repo/apps/studio/test/rebuild_rehearse.test.sh" "$fx/rehearsal.away"; run; mv "$fx/rehearsal.away" "$repo/apps/studio/test/rebuild_rehearse.test.sh"
check "with no rehearsal in the checkout it says so and writes nothing" '[ "$st" = 1 ] && [[ "$err" == "The rebuild rehearsal is missing from this checkout, so it did not run." ]] && [ ! -e "$home/.flint/rehearsal-result" ]'
check "the script names no other program to run, and reads nothing from the environment to choose one" '! grep -nE "\\$\{?FLINT_[A-Z_]*(TEST|SCRIPT|CMD)" "$here/../run_rehearsal.sh"'

(( fail )) && exit 1
print "ok: the rehearsal's runner runs it for real, writes one line saying how it went, and says a failure in sentences"
