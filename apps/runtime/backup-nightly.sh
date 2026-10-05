#!/bin/zsh
# The database's nightly backup (Machine plan P1 backups), run by the LaunchAgent
# com.flint.runtime-backup at 02:15, which install-runtime.sh keeps installed:
#   - every night: a pg_dump (`backup --auto`);
#   - when an age recipient is set (~/.flint/backup-age-recipient): the encrypted
#     copy off the box (`offsite --auto`);
#   - on Sundays: the restore drill into a scratch database (`drill --auto`).
# Each goes through the tier engine. While its action is at APPROVAL it runs only
# on a card Will approved (the console's Approvals; one card a night); once he has
# promoted it, it runs on its own under its cap. A failure posts Will a note.
# Log: ~/.flint/runtime-backup.out.log and runtime-backup.err.log.
set -u
REPO="${FLINT_REPO:-$HOME/flint}"
DATA="$HOME/.flint"
ts() { date '+%F %T'; }
cd "$REPO" || { echo "$(ts) no checkout at $REPO" >&2; exit 1; }

run() {
  echo "$(ts) $1"
  pnpm --silent --filter @flint/runtime "$1" --auto || echo "$(ts) $1 did not complete (see above)" >&2
}

run backup
[ -s "$DATA/backup-age-recipient" ] && run offsite
[ "${FLINT_DOW:-$(date +%u)}" = 7 ] && run drill
exit 0
