#!/bin/zsh
# restore_file.sh: put one of Flint's own files back from last night's backup.
#
# For when Flint's memory, chat history or notes file is damaged (docs/RECOVERY.md).
# Run it on the Studio, in Terminal:
#
#     ~/flint/apps/studio/restore_file.sh memory          what Flint has learned about you
#     ~/flint/apps/studio/restore_file.sh history         your conversations
#     ~/flint/apps/studio/restore_file.sh notifications   your notes
#
# It takes the file from the newest local backup (~/FlintBackups) that holds a
# readable copy, shows how old that copy is, and asks you to type RESTORE. The
# file as it is now is never deleted: it is kept beside the restored one, under
# a name ending in .before-restore-<time>. The server is stopped while the file
# is swapped (it keeps these files in memory and would write over the copy), and
# started again afterwards.
#
# It restores only the three files named above, by name: nothing you type is
# ever used as a path. Every line it prints is a sentence.
set -u
here=${0:A:h}
source "$here/recovery_lib.sh"

DATA="$HOME/.flint"
LOCAL="${FLINT_BACKUP_DIR:-$HOME/FlintBackups}"
AGENTS="$HOME/Library/LaunchAgents"
TMP="${${TMPDIR:-/tmp}%/}"
usage="Say which file to restore: memory, history or notifications. For example: ~/flint/apps/studio/restore_file.sh memory"
(( $# == 1 )) || refuse "$usage"
case $1 in
  memory) member=memory/knowledge.json what="Flint's memory of you" ;;
  history) member=memory/conversations.json what="your conversation history" ;;
  notifications) member=notifications.json what="your notes" ;;
  *) refuse "$usage" ;;
esac
[[ -d $DATA ]] || refuse "There is no Flint on this Mac."
[[ -t 0 && -t 1 ]] || refuse "Run this yourself in Terminal: it asks you to confirm before it changes anything."

work="$(mktemp -d "$TMP/flint-restore-file.XXXXXX")" || refuse "Flint could not make a working folder."
chmod 700 "$work"
trap 'rm -rf "${work:?}"' EXIT
trap 'exit 130' INT TERM

# The newest backup that holds a readable copy. A copy that is not valid JSON is passed over.
archive=
for candidate in "$LOCAL"/flint-*.tar.gz(NOn); do   # newest name first: the names carry the date
  [[ ${candidate:t} =~ '^flint-[0-9]{8}-[0-9]{4}\.tar\.gz$' ]] || continue
  ( umask 077; /usr/bin/tar -xzOf "$candidate" "./$member" > "$work/copy" ) 2>/dev/null || continue
  [[ -s $work/copy ]] && /usr/bin/plutil -convert json -o /dev/null "$work/copy" >/dev/null 2>&1 || continue
  archive=$candidate
  break
done
[[ -n $archive ]] || refuse "None of the backups on this Mac holds a readable copy of that file. Nothing was changed."

[[ ${archive:t} =~ '^flint-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})' ]]
made="$match[1]-$match[2]-$match[3] at $match[4]:$match[5]"
hours=$(( ( $(date +%s) - $(/usr/bin/stat -f %m "$archive") ) / 3600 ))
if (( hours < 1 )); then age="less than an hour old"; elif (( hours < 48 )); then age="$hours hours old"; else age="$(( hours / 24 )) days old"; fi
say "The newest readable copy of $what is from the backup made on $made. It is $age."
say "Restoring it puts that copy in place. Anything Flint saved in that file since the backup is left out of it."
say "The file as it is now is kept beside it, so nothing is lost."
print -n -- "Type RESTORE to continue: "
read -r answer
[[ $answer == RESTORE ]] || refuse "Nothing was changed."

stamp="$(date +%Y%m%d-%H%M%S)"
target="$DATA/$member"
plist="$AGENTS/com.flint.server.plist"
[[ -f $plist ]] && launchctl unload "$plist" >/dev/null 2>&1
mkdir -p "${target:h}"
if [[ -e $target ]]; then
  mv "$target" "$target.before-restore-$stamp" && chmod 600 "$target.before-restore-$stamp" \
    || { [[ -f $plist ]] && launchctl load -w "$plist" >/dev/null 2>&1; refuse "Flint could not set the current file aside. Nothing was changed."; }
fi
if ! { chmod 600 "$work/copy" && mv "$work/copy" "$target"; }; then
  # Put back what was there, and say so.
  [[ -e $target.before-restore-$stamp ]] && mv "$target.before-restore-$stamp" "$target"
  [[ -f $plist ]] && launchctl load -w "$plist" >/dev/null 2>&1
  refuse "Flint could not put the copy in place, so it put the current file back. Nothing was changed."
fi
[[ -f $plist ]] && launchctl load -w "$plist" >/dev/null 2>&1
say "The copy from $made is in place, and Flint is starting again."
[[ -e $target.before-restore-$stamp ]] && say "The file as it was is kept as ${member:t}.before-restore-$stamp, in the same folder."
exit 0
