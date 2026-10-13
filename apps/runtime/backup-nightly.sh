#!/bin/zsh
# The database's nightly backup (Machine plan P1 backups), run by the LaunchAgent
# com.flint.runtime-backup at 02:15, which install-runtime.sh keeps installed:
#   - every night: a pg_dump (`backup --auto`);
#   - when an age recipient is set (~/.flint/backup-age-recipient): the encrypted
#     copy off the box (`offsite --auto`), into iCloud Drive's FlintBackups/pg
#     unless FLINT_OFFSITE_DIR names another folder; the newest 7 are kept there;
#   - on Sundays: the restore drill into a scratch database (`drill --auto`);
#   - when Nexus's own backup is switched on (FLINT_NEXUS_BACKUP_URL is in
#     ~/.flint/backup.env; `nexus-setup` puts it there): the same three steps for
#     the Nexus database (`nexus-backup`, `nexus-offsite`, and on Sundays
#     `nexus-drill`), each under its own action and its own card. Switched off,
#     none of them is started at all;
#   - every night, last: old copies taken before database updates are removed
#     (`prune-backups --auto`; the newest 10 and the last 30 days stay). It asks for
#     a card only on a night there is something to remove. (Never `pnpm prune`: that
#     is pnpm's own command, which removes packages.)
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

# Whether Nexus's backup is switched on: backup.env has an address for it. Only whether the line is there is
# looked at; its value is never read here (the runtime looks for the same line: config.ts, nexusBackupWanted).
nexus_on() { [ -r "$DATA/backup.env" ] && grep -Eq "^(export[[:space:]]+)?FLINT_NEXUS_BACKUP_URL=[[:space:]]*[\"']?[^[:space:]\"']" "$DATA/backup.env"; }

run backup
[ -s "$DATA/backup-age-recipient" ] && run offsite
[ "${FLINT_DOW:-$(date +%u)}" = 7 ] && run drill
if nexus_on; then
  run nexus-backup
  [ -s "$DATA/backup-age-recipient" ] && run nexus-offsite
  [ "${FLINT_DOW:-$(date +%u)}" = 7 ] && run nexus-drill
fi
run prune-backups
exit 0
