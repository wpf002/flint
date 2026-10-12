#!/bin/zsh
# run_rehearsal.sh: run the rebuild rehearsal, and write down how it went.
#
# The rehearsal (test/rebuild_rehearse.test.sh) backs up a made-up Flint with a
# throwaway key and rebuilds it into a scratch home folder and a scratch
# database. It keeps to scratch folders of its own: it never touches the real
# ~/.flint, ~/flint, the LaunchAgents, the real databases or the screen.
#
# Three things run it:
#   - a LaunchAgent, every Sunday at 05:10 (com.flint.rebuild-rehearsal, which
#     apps/server/install-server.sh writes and loads);
#   - the deploy gate, when a deploy changes something a rebuild is made of, or
#     when it is asked to:   FLINT_REHEARSE=1 ~/flint/apps/server/install-server.sh
#   - you, by hand:          ~/flint/apps/studio/run_rehearsal.sh
#
# The one thing it writes outside those scratch folders is one line in
# ~/.flint/rehearsal-result: "<passed|failed> <when, in seconds> <commit>".
# Settings > Health reads it (Rebuild Rehearsal). It shows nothing on screen and
# sends no note: Health is where a failure is seen. On a Mac with no Flint it
# writes nothing at all.
#
# The rehearsal is always run for real (FLINT_REQUIRE_REHEARSAL=1): a missing
# tool is a failure, never a skip that reads as a pass. It takes no options.
# Every line it prints is a sentence. What the rehearsal itself printed goes to
# the error stream when that is a log (the deploy's, or the LaunchAgent's), so a
# failure can be looked into.
set -u
here=${0:A:h}
repo=${here:h:h}
(( $# == 0 )) || { print -r -- "This takes no options. Run it as: ~/flint/apps/studio/run_rehearsal.sh" >&2; exit 1; }
rehearsal="$here/test/rebuild_rehearse.test.sh"
[[ -r $rehearsal ]] || { print -r -- "The rebuild rehearsal is missing from this checkout, so it did not run." >&2; exit 1; }

# Nothing it starts can reach the screen: the no-op stand-ins for osascript, open and the like come first.
quiet="$repo/test-support/quiet-bin"
[[ -d $quiet ]] && path=("$quiet" $path)

typeset -F SECONDS
began=$SECONDS
out="$(FLINT_REQUIRE_REHEARSAL=1 /bin/zsh "$rehearsal" 2>&1 </dev/null)"; st=$?
took=$(( SECONDS - began ))
# A rehearsal that says it was skipped did not prove anything, whatever it exited with.
if (( st == 0 )) && [[ $'\n'$out == *$'\n'skipped:* ]]; then st=1; fi
word=failed; (( st == 0 )) && word=passed

commit="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || commit=
[[ $commit =~ '^[0-9a-f]{40}$' ]] || commit=-
result="$HOME/.flint/rehearsal-result"
if [[ -d $HOME/.flint ]]; then
  ( umask 077; print -r -- "$word $(date +%s) $commit" > "$result.new" && chmod 600 "$result.new" && mv -f "$result.new" "$result" ) 2>/dev/null \
    || { rm -f "$result.new" 2>/dev/null; print -r -- "Flint could not write down how the rehearsal went." >&2; }
fi

[[ -t 2 ]] || print -r -- "$out" >&2
if (( st == 0 )); then
  print -r -- "The rebuild rehearsal passed in ${took%.*} seconds."
  exit 0
fi
print -r -- "The rebuild rehearsal failed."
said=0
for line in "${(@f)out}"; do
  case $line in
    "FAIL "?*) print -r -- "This check did not pass: ${${line#FAIL }%.}."; said=1 ;;
    "skipped: "?*) print -r -- "It did not run: ${${line#skipped: }%.}."; said=1 ;;
  esac
done
if (( ! said )); then
  print -r -- "It did not say which check stopped it. This shows everything it prints:"
  print -r -- "  zsh ~/flint/apps/studio/test/rebuild_rehearse.test.sh"
fi
exit 1
