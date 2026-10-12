#!/bin/zsh
# restore_database.sh: put Flint's database back from one of its nightly backups.
# Run it on the Studio, in Terminal.
#
#   restore_database.sh --check          A trial run. It restores the newest backup beside the
#                                        database in use, checks it, removes the copy, and says
#                                        how long a real restore would take. Nothing in use changes.
#   restore_database.sh                  Restore the newest backup that is whole. It shows what
#                                        will be in force afterwards and asks you to type RESTORE.
#   restore_database.sh --list           The backups there are, newest first.
#   restore_database.sh --dump <name>    Restore the backup with that file name instead.
#   restore_database.sh --repair         Put right what a restore that was stopped part-way left.
#
#   Also, passed on as they are: --without-copy (restore although the database in use could not be
#   copied first) and --without-fingerprint (restore a backup no fingerprint was recorded for).
#
# This is the runtime's own command (apps/runtime, `restore-production`; its README says how it
# works), run directly rather than through pnpm, so every line printed is that command's own
# sentence and how it ends is passed on unchanged. This script changes nothing itself.
set -u
here=${0:A:h}
repo=${here:h:h}
source "$here/recovery_lib.sh"

need_tool node "The program node is not installed, so Flint could not run the restore."
node_dir=${REPLY:h}
tsx="$repo/apps/runtime/node_modules/.bin/tsx"
[[ -x $tsx ]] || refuse "Flint's packages are not installed in this copy of its code. Install them with this command:" "  cd ~/flint && pnpm install"

if [[ ${1:-} == --list ]]; then
  (( $# == 1 )) || refuse "--list takes nothing after it."
  dumps=("$HOME"/FlintBackups/pg/flint-*.dump(NOn))
  (( ${#dumps} )) || refuse "There are no database backups on this Mac."
  for dump in $dumps; do
    name=${dump:t}
    [[ $name =~ '^flint-([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})-([0-9]{2})-[0-9]{2}-[0-9]{3}Z\.dump$' ]] || continue
    size=$(/usr/bin/stat -f %z "$dump" 2>/dev/null) || continue
    say "The backup from $match[1] at $match[2]:$match[3] UTC is $name, $(( (size + 1048575) / 1048576 )) MB."
  done
  say "To restore one of them, run this with its name at the end:"
  say "  ~/flint/apps/studio/restore_database.sh --dump"
  exit 0
fi

cd "$repo/apps/runtime" || refuse "Flint's code is not where this script expects it."
# node first on the PATH: tsx starts it by name, and a LaunchAgent's or a bare shell's PATH may not have it.
PATH="$node_dir:$PATH" exec "$tsx" src/cli.ts restore-production "$@"
