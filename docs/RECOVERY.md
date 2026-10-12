# When something breaks: the recovery runbook

For Will. Each entry is the fewest steps that fix one thing. A command goes into
Terminal exactly as written. Whatever gets replaced is kept under another name,
and each command says where.

| What happened | Go to |
|---|---|
| An update broke Flint | [1](#1-an-update-broke-flint) |
| The database is damaged | [2](#2-the-database-is-damaged) |
| Flint's memory, history or notes file is damaged or emptied | [3](#3-a-memory-history-or-notes-file-is-damaged-or-emptied) |
| The Mac Studio is lost, stolen or dead | [4](#4-the-mac-studio-is-lost-stolen-or-dead) |
| The database server will not start | [5](#5-the-database-server-will-not-start) |

Flint never edits this page.

## Do this once, now

Entry 4 starts from the MacBook, because the key that opens the offsite backups
lives there and never leaves it. Do these today, not on the day the Studio is
gone.

**On the MacBook:**

1. Get Flint's code:

   ```
   git clone https://github.com/wpf002/flint.git ~/flint
   ```

2. Get the program that opens the backups:

   ```
   brew install age
   ```

3. Copy the backup key to where the rebuild looks for it. Replace `KEYFILE`
   with where your key file is now. This copies it: the file you have stays
   where it is.

   ```
   mkdir -p ~/.flint-standby && cp KEYFILE ~/.flint-standby/backup-key.txt && chmod 600 ~/.flint-standby/backup-key.txt
   ```

4. Prove that the key opens last night's backups:

   ```
   ~/flint/apps/studio/rebuild.sh --unseal ~/flint-proof
   ```

   It says which backups it opened. That proves the key, the program, and that
   Terminal can read iCloud Drive. If a backup has not come down from iCloud
   yet, it says it is waiting, for up to 10 minutes a file.
5. Remove the opened copy. It is not encrypted:

   ```
   rm -rf ~/flint-proof
   ```

**On the Studio:**

6. Prove that last night's database backup restores:

   ```
   ~/flint/apps/studio/restore_database.sh --check
   ```

   It changes nothing in use. It says how long a real restore would take, and
   which keys could approve afterwards. If it says a permission is missing, it
   prints the one command that grants it. Run that, then run this again.

Keep one more copy of the key file offline: printed, or on a USB stick in a safe
place. If the MacBook is lost and there is no other copy, every offsite backup
is unreadable.

If you ever have a spare Mac, do entry 4 against it once. It is the only proof
of the steps a rehearsal cannot reach: the connection, installing Homebrew,
loading Flint's services, and the Tailscale sign-in.

## 1. An update broke Flint

1. On GitHub, open the pull request that was just merged, choose **Revert**, and
   merge the revert. Flint goes back by itself within about 3 minutes.
2. If nothing has changed after 10 minutes, on the Studio:

   ```
   ~/flint/apps/studio/rollback.sh
   ```

   It names the version that is running and the one it kept from before, with
   how long ago each was installed. It asks you to type `ROLLBACK`, once for the
   server and once for the runtime. Then it puts that version back and pauses
   updates.
3. When the fix is merged, let updates run again:

   ```
   rm ~/.flint/deploy-hold
   ```

   Flint then installs the newest version within a few minutes, even if nothing
   new was merged.

- If the revert from step 1 was already installed, the version before it is the
  broken one. The script says so and asks for that version's name instead of
  `ROLLBACK`. Do not type it. Leave Flint as it is and get the fix merged.
- A database update is never undone. If step 2 says the last update changed the
  database, do not go further back. Leave Flint as it is and get the fix merged.
- Updates are paused only when something was rolled back. While they are paused,
  Settings › Health shows Automatic Updates as an issue with how long it has
  been, and Flint posts one note after a day.
- Nothing is deleted. The version it rolled back from is kept.

## 2. The database is damaged

Signs: Flint says its backup or its database failed, or approvals and activity
stop working and stay that way.

1. On the Studio:

   ```
   ~/flint/apps/studio/restore_database.sh
   ```

2. It restores the newest good backup beside the database in use and checks it.
   Nothing in use has changed yet.
3. It says how old the backup is, which keys will be able to approve, and what
   Flint will be allowed to do on its own. Read that, then type `RESTORE`.
4. Wait for "Restored and verified". It says how long it took.
5. Open Flint. Approve again anything you had approved that had not run.

What a restore does to what you did after the backup:

- A key you revoked stays revoked. A permission you switched off stays off.
- A card you already dealt with is waiting again. Reject what you do not want
  done twice. The command says how many, and how many had already run.
- Something you told Flint to forget is back. Forget it again in the console.
  The command says how many.
- A key you enrolled after the backup is not in it. Enrol it again.

Other things to know:

- The database that was in use is not deleted. It is kept, closed, under the
  name the command prints. A copy of it also goes into the `pre-restore` folder
  of your Flint backups. A later restore removes kept ones that are more than 14
  days old, and names them before you confirm.
- If any check fails, it stops and nothing in use has changed.
- If it is interrupted, run this. It opens the database again and starts Flint:

  ```
  ~/flint/apps/studio/restore_database.sh --repair
  ```

- If it was killed outright (the Mac lost power, or the window was closed and
  it would not stop), Flint's runtime can be left stopped with the database
  already restored. Nothing shows that on its own. The same command starts it,
  and the next restore or `--check` says so if it is still stopped.

- To restore an older backup, list them and name the one you want:

  ```
  ~/flint/apps/studio/restore_database.sh --list
  ```

  ```
  ~/flint/apps/studio/restore_database.sh --dump NAME
  ```

- If it stops because it could not copy the current database first, and you
  want to go on anyway:

  ```
  ~/flint/apps/studio/restore_database.sh --without-copy
  ```

- Only you can run this. Flint never restores its own database.

## 3. A memory, history or notes file is damaged or emptied

Signs: Flint has forgotten what it knew about you, or your conversations or
notes are gone.

1. On the Studio, for Flint's memory of you:

   ```
   ~/flint/apps/studio/restore_file.sh memory
   ```

   For your conversations, end the command with `history`. For your notes, end
   it with `notifications`.
2. It lists every nightly backup on the Studio with what its copy holds. Then it
   names the backup it chose and how old it is.
3. Type `RESTORE`.

- It never offers an emptied copy on its own. When Flint forgets, the file it
  saves afterwards is valid but nearly empty, and that night's backup takes it.
  A copy that holds less than half of what an older copy holds is passed over,
  and the command says which backups it passed over and why.
- To choose the backup yourself, add its day to the end of the command:

  ```
  ~/flint/apps/studio/restore_file.sh memory 2026-10-10
  ```

- The Studio keeps 14 nightly backups. Restore within two weeks of the day Flint
  forgot.
- The file as it was is kept beside the restored one, so nothing is lost.
- The server is stopped while the file is swapped and started again afterwards.
  If the command says the server did not start again, it prints the one command
  that starts it.

## 4. The Mac Studio is lost, stolen or dead

**Lock it down first**, only if the Studio is out of your hands:

1. iCloud › Find Devices › the Mac Studio › Mark As Lost.
2. Tailscale admin page › Machines › the Mac Studio › Remove.
3. GitHub › Settings › Applications › Authorized OAuth Apps › GitHub CLI › Revoke.

Then revoke every key the Studio held. You do not need the new Mac for this:

- Anthropic: console.anthropic.com › API Keys.
- OpenAI: platform.openai.com › API keys.
- Google AI: aistudio.google.com › API keys.
- Perplexity: its settings › API.
- Tavily: app.tavily.com › API Keys.
- GitHub: Developer settings › the flint-observer app › remove its private key.
- Google Calendar: myaccount.google.com › Third-party access › remove the Studio.
- Nexus: revoke the Studio's tokens there.

Skip the ones you never set up. The rebuild ends by naming the ones that were.

**Rebuild on the new Mac:**

1. Set the new Mac up with the same Apple ID. Turn on FileVault and iCloud
   Drive. In System Settings › General › Sharing, turn on Remote Login. Leave it
   logged in, on the same network as the MacBook.
2. On the MacBook, replace `NAME` with your account name on the new Mac, and
   `NEWMAC` with its name. Both are in System Settings › General › Sharing on
   the new Mac: the account under Remote Login, the name under Local hostname.

   ```
   cd ~/flint && git pull && ./apps/studio/rebuild.sh --to NAME@NEWMAC.local
   ```

   The first time, it shows the new Mac's key fingerprint and asks whether to go
   on. To see the real one, run this on the new Mac. Type `yes` only if they
   match:

   ```
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   Then enter the new Mac's password when it asks.
3. When it prints a Tailscale link, open it and sign in.
4. When it prints an enrolment code, open `http://localhost:8080` on the new
   Mac, go to Settings › Approval Key, and enter the code.
5. On the new Mac, run the `ollama pull` commands it printed. They are large
   downloads. Read the model names first: they are the ones you use. A model
   named by an address is never taken from a backup, and the rebuild says so if
   the backup held one.
6. Go through the short list it printed of keys and sign-ins. Each one needs you
   once, and the list says where.
7. On the phone, open Flint's address. It is the same if the new Mac took the
   old Mac's name in Tailscale.

What comes back, what is new, and what needs you:

| | |
|---|---|
| Comes back from last night's backup | Your memory, conversations, notes, training data, what Flint has spent this month, Flint's database, and your switches: which model, the spend caps, what is turned on. The rebuild lists each switch it put back. |
| Made new, so the old Mac's are dead | Flint's access token, every database password, and the tokens Flint's parts use with each other. |
| Never taken from a backup, so they need you | The Tailscale sign-in, your approval key, the models, any AI vendor's key, the Google sign-in, and the list of connectors. The rebuild ends by naming each one that was set up. |

- The new Mac is asked first whether it is fit: FileVault on, someone logged in,
  and no Flint on it. If it is not, nothing is sent and the command says why.
- If the rebuild stops part-way, run the same command again straight away. It
  starts over. If more than a day has passed, or Flint has been running on the
  new Mac since, it asks you to type `START OVER` first, because starting over
  replaces the files and the database that are there.
- The MacBook stays awake while it runs. Leave it open and plugged in.
- The backup key never leaves the MacBook. The new Mac gets the opened backups
  over SSH, and they are removed from it when the rebuild is done or has failed.
- A rebuild takes only your data from a backup. It never unpacks a settings
  file, a connector list, a token or a program, and it says what it left out.
- It lists each switch it put back. The spend caps and the history limit are
  listed apart, under "These limits came from the backup". Check that they are
  the ones you set.
- The rebuilt Flint is the version the old Mac was running, not a newer one,
  and the rebuild says which day that version is from. The one exception: if
  the way Flint rebuilds has changed since then, it installs the newest version
  instead, tests it first, and says so.
- Anything you revoked, switched off or told Flint to forget after the backup is
  back. The rebuild says so, and says what Flint may do on its own.
- A rebuild never replaces a Flint that is already there. On a Mac that has a
  Flint database it stops and changes nothing. That is entry 2's job.
- Nexus is a separate system and is not rebuilt by this command.

## 5. The database server will not start

Signs: Settings › Health shows the database as down, or a restore says it could
not reach the database server.

1. On the Studio, restart it:

   ```
   brew services restart postgresql@17
   ```

2. Wait a minute, then check. This is a full trial restore, so it takes about
   a minute, and it changes nothing in use:

   ```
   ~/flint/apps/studio/restore_database.sh --check
   ```

3. If it still cannot be reached, look at what the database server said last:

   ```
   tail -n 20 /opt/homebrew/var/log/postgresql@17.log
   ```

- "No space left on device" means the disk is full. Free some space, then do
  step 1 again.
- If it says its own files are damaged, no command here repairs that, and none
  should be guessed at. Your backups are safe: every night's is in
  `~/FlintBackups/pg` on the Studio and in iCloud. Do not delete the folder
  `/opt/homebrew/var/postgresql@17`. The way back is entry 4, onto this Mac once
  it is erased.

## What each backup is

| Backup | Made | Where | Opened with |
|---|---|---|---|
| Flint's files (memory, conversations, notes, training data) | Nightly, 02:30 | `~/FlintBackups` on the Studio, 14 kept. An encrypted copy in iCloud Drive, 7 kept. | The Studio's copy is plain. The iCloud copy needs the key on the MacBook. |
| Flint's database | Nightly, 02:15 | `~/FlintBackups/pg` on the Studio, 14 kept. An encrypted copy in iCloud Drive, 7 kept. | The same. |

No key, token or password is ever in the iCloud copies.

## Limits to know about

- The offsite backups are encrypted, not signed. Someone who could write to your
  iCloud Drive could put a false backup there. A rebuild is built not to trust
  one: it takes only your data from it, checks the database against Flint's own
  code, switches off any permission your signature does not cover, and shows you
  which keys can approve. Signing the backups is not done yet.
- The first connection to a new Mac trusts the fingerprint you compare in entry
  4, step 2, and that Mac's password.

## For whoever maintains this page

Each entry is proved by a test, so a change that breaks one fails the deploy.

- Entry 1: `apps/studio/test/rollback.test.sh`, and the pause in
  `apps/server/test/auto-update.test.ts`.
- Entry 2: `apps/runtime/test/restore-production-db.test.ts` and
  `apps/studio/test/restore_database.test.sh`.
- Entry 3: `apps/studio/test/restore_file.test.sh`.
- Entry 4: `apps/studio/test/rebuild_rehearse.test.sh`. A made-up Flint is backed
  up with a throwaway key and rebuilt into a scratch folder and a scratch
  database, and both of its services must answer. It runs every Sunday and in
  every deploy that changes what a rebuild is made of. Settings › Health shows
  how the last one went (Rebuild Rehearsal). To run it by hand:
  `~/flint/apps/studio/run_rehearsal.sh`. What it cannot reach needs a real new
  Mac: the SSH connection, installing Homebrew, loading the LaunchAgents, and
  the Tailscale sign-in.
- This page itself: `apps/studio/test/runbook.test.sh`. Flint may not edit it
  (`packages/policy/src/selfmod-paths.ts`). What a rebuild restores, makes new
  and leaves to you is listed by name in `apps/studio/settings.manifest`.
