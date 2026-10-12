# When something breaks: the recovery runbook

For Will. Each entry is the fewest steps that fix one thing. A command goes into
Terminal exactly as written. Nothing here deletes anything: whatever gets
replaced is kept under another name, and each command says where.

| What happened | Go to |
|---|---|
| An update broke Flint | [1](#1-an-update-broke-flint) |
| The database is damaged | [2](#2-the-database-is-damaged) |
| Flint's memory, history or notes file is damaged | [3](#3-a-memory-history-or-notes-file-is-damaged) |
| The Mac Studio is lost, stolen or dead | [4](#4-the-mac-studio-is-lost-stolen-or-dead) |

Flint never edits this page (`packages/policy/src/selfmod-paths.ts`).

## Do this once, now, on the MacBook

Entry 4 starts from the MacBook, because the key that opens the offsite backups
lives there and never leaves it. Three commands make the MacBook ready. Do them
today, not on the day the Studio is gone.

1. Get Flint's code:

   ```
   git clone https://github.com/wpf002/flint.git ~/flint
   ```

2. Get the program that opens the backups:

   ```
   brew install age
   ```

3. Put the backup key where the rebuild looks for it (replace `KEYFILE` with
   where your key file is now):

   ```
   mkdir -p ~/.flint-standby && mv KEYFILE ~/.flint-standby/backup-key.txt && chmod 600 ~/.flint-standby/backup-key.txt
   ```

Keep one more copy of that key file offline (printed, or on a USB stick in a
safe place). If the MacBook is lost and there is no other copy, every offsite
backup is unreadable.

## 1. An update broke Flint

1. On GitHub, open the pull request that was just merged, choose **Revert**, and
   merge the revert. Flint goes back by itself within about 3 minutes.
2. If nothing has changed after 10 minutes, on the Studio:

   ```
   ~/flint/apps/studio/rollback.sh
   ```

   It puts the previous version back and pauses updates.
3. When the fix is merged, let updates run again:

   ```
   rm ~/.flint/deploy-hold
   ```

- A database update is never undone automatically. If step 2 says the last
  update changed the database, stop there and ask.
- Nothing is deleted: the version it rolled back from is kept.
- Proved by: `apps/studio/test/rollback.test.sh`, and the hold in
  `apps/server/test/auto-update.test.ts`.

## 2. The database is damaged

Signs: Flint says its backup or its database failed, or approvals and activity
stop working and stay that way.

1. On the Studio:

   ```
   cd ~/flint && pnpm --filter @flint/runtime restore-production
   ```

2. It shows the newest good backup and how old it is. Type `RESTORE`.
3. Wait for "Restored and verified". It says how long it took.
4. Open Flint. Anything you had approved that had not run yet needs approving
   again.

- The database that was in use is not deleted. It is kept under the name the
  command prints, and a copy of it goes into the `pre-restore` folder of your
  Flint backups.
- The backup is restored and checked beside the database in use first. If any
  check fails, it stops and nothing has changed.
- If it stops because it could not copy the current database first, and you
  want to go on anyway (the database is kept under another name all the same):

  ```
  cd ~/flint && pnpm --filter @flint/runtime restore-production --without-copy
  ```

- Only you can run this. Flint never restores its own database, and it asks you
  at the keyboard every time.
- To see that the newest backup would restore, and how long it would take,
  without changing anything:

  ```
  cd ~/flint && pnpm --filter @flint/runtime restore-production --check
  ```

- Proved by: `apps/runtime/test/restore-production-db.test.ts`.

## 3. A memory, history or notes file is damaged

Signs: Flint has forgotten what it knew about you, or your conversations or
notes are gone.

1. On the Studio, for Flint's memory of you:

   ```
   ~/flint/apps/studio/restore_file.sh memory
   ```

   For your conversations, end the command with `history`. For your notes, end
   it with `notifications`.
2. It shows how old the copy is. Type `RESTORE`.

- The file as it was is kept beside the restored one, so nothing is lost.
- Proved by: `apps/studio/test/restore_file.test.sh`.

## 4. The Mac Studio is lost, stolen or dead

**Lock it down first**, only if the Studio is out of your hands:

1. iCloud › Find Devices › the Mac Studio › Mark As Lost.
2. Tailscale admin page › Machines › the Mac Studio › Remove.
3. GitHub › Settings › Applications › Authorized OAuth Apps › GitHub CLI › Revoke.

**Rebuild on the new Mac:**

1. Set the new Mac up with the same Apple ID. Turn on FileVault and iCloud
   Drive. In System Settings › General › Sharing, turn on Remote Login. Leave it
   logged in.
2. On the MacBook (replace `NAME` with your account name on the new Mac, and
   `NEWMAC` with the new Mac's name):

   ```
   cd ~/flint && git pull && ./apps/studio/rebuild.sh --to NAME@NEWMAC.local
   ```

   Enter the new Mac's password when it asks.
3. When it prints a Tailscale link, open it and sign in.
4. When it prints an enrolment code, open Flint on the new Mac, go to Settings ›
   Approval Key, and enter the code.
5. On the new Mac, run the `ollama pull` commands it printed. They are large
   downloads.
6. Go through the short list it printed of keys and sign-ins. Each one needs you
   once, and the list says where.
7. On the phone, open Flint's address. It is the same if the new Mac took the
   old Mac's name in Tailscale.

What comes back, what is new, and what needs you:

| | |
|---|---|
| Comes back from last night's backup | Your memory, conversations, notes, training data, Flint's database, and your switches (which model, the spend caps, what is turned on). |
| Made new, so the old Mac's are dead | Flint's access token, every database password, and the tokens Flint's parts use with each other. |
| Never in a backup, so they need you | The Tailscale sign-in, your approval key, the models, any AI vendor's key, the Google sign-in, and the list of connectors. The rebuild ends by naming each one that was set up. |

- If the rebuild stops part-way, run the same command again. It starts over.
- The backup key never leaves the MacBook. The new Mac gets the opened backups
  over SSH, and removes them when the rebuild is done.
- A rebuild never replaces a Flint that is already there. On a Mac that has a
  Flint database it stops and changes nothing; that is entry 2's job.
- Nexus is a separate system and is not rebuilt by this command.
- Proved on every deploy by `apps/studio/test/rebuild_rehearse.test.sh`: a
  made-up Flint is backed up with a throwaway key and rebuilt into a scratch
  folder and a scratch database, and both of its services must answer. The
  steps that test cannot reach are the ones that need a real new Mac: the SSH
  connection, installing Homebrew, loading the LaunchAgents, and the Tailscale
  sign-in. Those are proven only by doing them once on a spare Mac or a
  virtual one.

## What each backup is

| Backup | Made | Where | Opened with |
|---|---|---|---|
| Flint's files (memory, conversations, notes, training data) | Nightly, 02:30 | `~/FlintBackups` on the Studio, 14 kept. An encrypted copy in iCloud Drive, 7 kept. | The Studio's copy is plain. The iCloud copy needs the key on the MacBook. |
| Flint's database | Nightly, 02:15 | `~/FlintBackups/pg` on the Studio, 14 kept. An encrypted copy in iCloud Drive, 7 kept. | The same. |

No key, token or password is ever in the iCloud copies
(`apps/studio/settings.manifest` lists, by name, what a rebuild restores, what
it makes new, and what it leaves to you).
