# One temp folder for a whole run of a studio test, removed when the test ends.
#
# Sourced first by the tests in this folder:
#   source "${0:A:h}/temp_root.zsh"
#
# The tests here make scratch folders with mktemp and remove them in an EXIT
# trap. A test that was stopped, or a script under test that made a folder of
# its own, left one behind each time. So a test's whole run gets one folder:
# TMPDIR points at it for the test and for every script it starts, and it is
# removed, with whatever is still in it, when the shell exits. That is done in
# a zshexit function, which runs after the test's own EXIT trap and is not
# replaced when the test sets one. A stop (Ctrl-C, a kill, a closed window)
# ends the shell through exit, so the folder goes then too.
#
# A run that is killed outright leaves that one folder. Its name starts with
# flint-t. which test-support/temp-prefixes lists, so apps/studio/free_space.sh
# can find it later. The name is short on purpose: a Unix socket's whole path
# must fit in 103 characters on a Mac.
#
# The rebuild rehearsal is the one test that does not use this: it keeps its
# own folders and sweeps what a killed run of its own left.
if [[ -z ${TEST_TMP_ROOT:-} ]]; then
  TEST_TMP_ROOT="$(mktemp -d "${${TMPDIR:-/tmp}%/}/flint-t.XXXXXX")" || { print -r -- "FAIL could not make a temp folder for this test"; exit 1; }
  export TMPDIR="$TEST_TMP_ROOT"
  flint_test_tmp_remove() {
    emulate -L zsh
    # Only the folder made above, by its own name, and never through a link.
    [[ -n ${TEST_TMP_ROOT:-} && ${TEST_TMP_ROOT:t} == flint-t.?????? && -d $TEST_TMP_ROOT && ! -L $TEST_TMP_ROOT ]] || return 0
    # A test may have left a folder nobody can write to: its owner can still empty it.
    chmod -R u+rwx "$TEST_TMP_ROOT" 2>/dev/null
    rm -rf -- "$TEST_TMP_ROOT"
  }
  zshexit_functions+=(flint_test_tmp_remove)
  trap 'exit 130' INT TERM HUP
fi
