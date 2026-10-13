#!/bin/zsh
# restore_database.sh, the one command the runbook gives for the database: it lists the backups
# there are, and otherwise runs the runtime's own restore command as it is, passing on what that
# command prints and how it ends. Run: zsh apps/studio/test/restore_database.test.sh
#
# Nothing here reaches a database or the real ~/.flint: the home folder is a scratch one whose
# settings name a database address nothing listens on, and every case below ends before a
# connection would matter. (The restore itself is tested against a throwaway Postgres in
# apps/runtime/test/restore-production-db.test.ts.)
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
set -u
here=${0:A:h}
studio=${here:h}
repo=${studio:h:h}
script="$studio/restore_database.sh"
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }
[[ -x $repo/apps/runtime/node_modules/.bin/tsx ]] || { print -r -- "skipped: the repo's packages are not installed (pnpm install)"; exit 0; }
[[ -x /opt/homebrew/opt/postgresql@17/bin/pg_restore || -x /opt/homebrew/bin/pg_restore || -x /usr/local/bin/pg_restore ]] || { print -r -- "skipped: this Mac has no Postgres 17 tools"; exit 0; }
fx="$(mktemp -d "${${TMPDIR:-/tmp}%/}/flint-rd.XXXXXX")" || exit 1
trap 'rm -rf "${fx:?}"' EXIT
home="$fx/home"; mkdir -p "$home/.flint" "$home/FlintBackups/pg"; chmod 700 "$home/.flint"
# Settings with the right names and a database address on this Mac that nothing listens on.
print -r -- "FLINT_DB_OWNER_URL=postgresql://flint_owner:x@[::1]:1/flint
FLINT_DB_URL=postgresql://flint_app:x@[::1]:1/flint" > "$home/.flint/secrets.env"
print -r -- "FLINT_DB_RESTORE_URL=postgresql://flint_restore:x@[::1]:1/postgres" > "$home/.flint/backup.env"
chmod 600 "$home/.flint"/*.env
nodebin=${$(whence -p node):h}
run() { out="$(env -i HOME="$home" NODE_ENV=test PATH="$nodebin:/usr/bin:/bin" /bin/zsh "$script" "$@" 2>"$fx/err" </dev/null)"; st=$?; err="$(<"$fx/err")"; }

# --list: every backup there is, newest first, each in a sentence, and how to choose one.
run --list
check "with no backups it says so" '[ "$st" = 1 ] && [[ "$err" == "There are no database backups on this Mac." ]]'
head -c 3145728 /dev/zero > "$home/FlintBackups/pg/flint-2026-10-10T07-15-00-000Z.dump"
head -c 1048577 /dev/zero > "$home/FlintBackups/pg/flint-2026-10-12T07-15-00-123Z.dump"
: > "$home/FlintBackups/pg/flint-2026-10-12T07-15-00-123Z.dump.counts.json"; : > "$home/FlintBackups/pg/notes.txt"
run --list
check "--list names each backup, newest first, with when it was made and its size" '[ "$st" = 0 ] && [[ "$out" == "The backup from 2026-10-12 at 07:15 UTC is flint-2026-10-12T07-15-00-123Z.dump, 2 MB."$'"'"'\n'"'"'"The backup from 2026-10-10 at 07:15 UTC is flint-2026-10-10T07-15-00-000Z.dump, 3 MB."$'"'"'\n'"'"'"To restore one of them, run this with its name at the end:"$'"'"'\n'"'"'"  ~/flint/apps/studio/restore_database.sh --dump" ]]'
check "and prints nothing else" '[ -z "$err" ]'
run --list extra
check "--list takes nothing after it" '[ "$st" = 1 ] && [[ "$err" == "--list takes nothing after it." ]]'

# Everything else is the runtime's own command: its sentences, and how it ends, come through as they are.
run --auto
check "the runtime's own refusal comes through, as one sentence, and so does how it ended" '[ "$st" = 1 ] && [[ "$out" == "Flint never restores its database on its own. Run this yourself in Terminal." ]] && [ -z "$err" ]'
run --everything
check "its options are the runtime's" '[ "$st" = 1 ] && [[ "$out" == "The only options are --dump followed by a backup file, --without-copy, --without-fingerprint, --check, --compare, and --repair." ]]'
run
check "with no one at a keyboard it is refused before anything is touched" '[ "$st" = 1 ] && [[ "$out" == "Run this yourself in Terminal: it asks you to confirm before it changes anything." ]]'
run --dump ../../../etc/passwd --check
check "a backup outside Flint's own backup folder is refused" '[ "$st" = 1 ] && [[ "$out" == "Flint restores only the nightly backups in its own backup folder." ]]'
check "no pnpm banner, no stack, no address or password is ever printed" '[[ "$out$err" != *">"* && "$out$err" != *"postgresql://"* && "$out$err" != *"    at "* ]]'
# Settings that are missing are named, never shown.
rm "$home/.flint/backup.env"
run --check
check "missing settings are named, not shown" '[ "$st" = 1 ] && [[ "$err" == *"restore config is invalid: FLINT_DB_RESTORE_URL: is not set"* ]] && [[ "$err" != *"flint_owner:x"* ]]'
# Without node it says so.
out="$(env -i HOME="$home" PATH="/usr/bin:/bin" FLINT_TOOL_PATHS="" /bin/zsh "$script" --check 2>&1)"; st=$?
check "without node it says so" '[ "$st" = 1 ] && [[ "$out" == "The program node is not installed, so Flint could not run the restore." ]]'

(( fail )) && exit 1
print "ok: restore_database.sh lists the backups there are, and otherwise passes the runtime's own restore command through as it is"
