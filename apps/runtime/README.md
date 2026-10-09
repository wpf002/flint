# @flint/runtime

Flint's always-on runtime: the world model, the prediction ledger, the job bus,
triage and self-health, on `[::1]:8090` under launchd (`com.flint.runtime`).
`install-runtime.sh` deploys it; your own settings go in
`~/.flint/runtime.override.env`, which deploys never write. That file must be
readable only by you (`chmod 600`): the runtime refuses to start otherwise.

Run the commands below in the deploy checkout, `~/flint`, which is always on
`main` with its packages installed.

## Chat's reads of the world model

With `runtime` in `~/.flint/mcp.json`, chat can look things up in Flint's world
model and prediction ledger. Each lookup asks first: a card in the chat ("Check
What's Happening Now", "Read Open Predictions") that you approve or reject.
After a week of that,
`cd ~/flint && pnpm --filter @flint/runtime promotion-table --phase p1` files
the card that lets those reads run without asking (recording a prediction stays
capped at 10 a day). Sign it in Approvals, or leave it, and they keep asking.

## The shadow week: labeling Activity

When triage turns on, it runs in shadow for a week: it sorts what comes in and
sends nothing. Open **Activity** in the console. **Important** is what Flint
judged worth your attention; **Other** is what it filed away. Click a row and
mark it: **Correct** if Flint got it right, **Not Important** (in Important) or
**Important** (in Other) if it didn't. The marks that count most are on rows
Flint escalated (those with Acknowledge and Dismiss in their details): they
give the precision P2's promotion card reports, and `p2-report` wants at least
20. Marking a row in Other as Important records a miss.

## Your calendar (`google_calendar`)

**Off: your events are in Apple Calendar.** Flint reads them there
([Your Apple Calendar](#your-apple-calendar-apple_calendar), below), so leave
this source off. Its steps stay here in case that changes.

The runtime reads your primary Google Calendar, read-only, every 5 minutes: the
next 14 days become commitments and deadlines in the world model. An event or
deadline within a day gets one heads-up note, once triage is on and its notes
are promoted (P2's promotion table). A few rules hold throughout:

- **Titles stay out of the world model.** An event's title is kept in a
  separate table. It's refreshed while the event is on your calendar, and the
  nightly cleanup deletes it a week after it last was. A note says "On your
  calendar Tue Oct 6 at 14:30" and never the title. Only the console shows it:
  in **Activity**, open the event's row in Important or Other, where it's under
  "Invitation title" and marked Outside Text. A chat read of the event taints
  the turn.
- **People come only from events you accepted or organized.** An attendee of
  such an event becomes a person (name and address) through a card you sign,
  and nothing else ever creates one. At most one card a day; after you reject
  one, a week of quiet.
- **It's read-only.** Flint asks for `calendar.readonly` and refuses any wider
  grant, at sign-in and at every refresh.

### Turning it on

Steps 1 and 2 need your Google account, so they're yours:

1. **A Google Cloud OAuth client.** At console.cloud.google.com:
   1. Create a project and enable the Google Calendar API.
   2. Under "OAuth consent screen", choose External, add the
      `.../auth/calendar.readonly` scope and add yourself as a test user.
   3. **Publish the app** ("In production"). An app left in Testing mode loses
      its refresh token after 7 days. Unverified is fine for your own account:
      Google shows a warning you can click through.
   4. Under "Credentials", create an OAuth client ID of type **Desktop app**
      and download its JSON. It lands in Downloads as
      `client_secret_<id>.apps.googleusercontent.com.json`. Move it into place:
      ```bash
      mkdir -p ~/.flint/google && chmod 700 ~/.flint/google && mv ~/Downloads/client_secret_*.apps.googleusercontent.com.json ~/.flint/google/client.json && chmod 600 ~/.flint/google/client.json
      ```
2. **Sign in once:** `cd ~/flint && pnpm --filter @flint/runtime google-login`. It opens
   Google's consent page and waits on `127.0.0.1` for the redirect. It writes
   `~/.flint/google/token.json` (0600). The offsite backup leaves `~/.flint/google`
   out.
3. **Switch it on.** These keep the override file `0600` whether or not it
   exists yet, add the line only once, and start it on a line of its own (a
   file saved without a final newline would otherwise glue it onto its last
   setting, and both would silently stop working):
   ```bash
   touch ~/.flint/runtime.override.env && chmod 600 ~/.flint/runtime.override.env
   grep -q '^FLINT_SOURCE_GOOGLE_CALENDAR=' ~/.flint/runtime.override.env || printf '\nFLINT_SOURCE_GOOGLE_CALENDAR=on\n' >> ~/.flint/runtime.override.env
   launchctl kickstart -k gui/$(id -u)/com.flint.runtime
   ```
4. **File the card that turns it on:**
   `cd ~/flint && pnpm --filter @flint/runtime enable-source google_calendar`.
   Then sign it in the console's **Approvals**. Signing needs an approval key
   (`pnpm --filter @flint/runtime enroll`, once) and the server in runtime mode
   (`FLINT_RUNTIME_URL`); once Approvals signs cards, both are done.
5. **Turn the old Watcher off later.** Do this only once triage is on
   (`FLINT_RUNTIME_TRIAGE=on`), P2's promotion table is signed (`triage.rule`
   and `notify.inapp`), and `p25-report` shows a heads-up delivered. Before
   that, the runtime records heads-ups but doesn't send them. To do it, put
   `FLINT_WATCHER=off` in `~/.flint/secrets.env` and run
   `launchctl kickstart -k gui/$(id -u)/com.flint.server`.

`cd ~/flint && pnpm --filter @flint/runtime p25-report` measures how it's doing:
- what's ahead;
- p95 freshness (target: under 15 minutes);
- the token's age (it should survive 30 days);
- people only from the calendar.

After a week of calendar syncs,
`cd ~/flint && pnpm --filter @flint/runtime promotion-table --phase p25` files
the card that would let the sync and person creation run on their own. It
lets Flint add people by itself, so Approve All leaves it for its own approval.

### Turning it off

1. Remove the `FLINT_SOURCE_GOOGLE_CALENDAR` line from
   `~/.flint/runtime.override.env` and run
   `launchctl kickstart -k gui/$(id -u)/com.flint.runtime`. The source stops.
2. To revoke Flint's access at Google too, remove it at
   myaccount.google.com/permissions and delete `~/.flint/google/token.json`.
3. Leave the titles: the nightly cleanup deletes each a week after it was last
   seen. Until P2's promotion table is signed, that cleanup runs only on nights
   you approve its card ("Run Tonight's Cleanup" in Approvals). There's no
   button yet to delete one title at once.

### Rolling P2.5 back

The migration's `down.sql` (`20261001000400_p25_google`) belongs to a rollback,
not to turning the calendar off:

1. First deploy a runtime from before P2.5. The P2.5 code reads the table
   `down.sql` drops, and its job bus expects the calendar's queue.
2. Then take a dump and run `down.sql` by hand.

Any later deploy of P2.5 code applies the migration again.

## Your Apple Calendar (`apple_calendar`)

Flint reads your Apple Calendar through a small helper on this Mac, Flint
Calendar (`apps/desktop-calendar`). The helper reads the next 14 days of the
calendars you choose, every 5 minutes and as soon as one changes. It pushes
what it read to the runtime, which maps it the way it maps Google's: events
become commitments and deadlines, and an event or deadline within a day gets
one heads-up note. The runtime itself reaches nothing for this source. A few
rules hold throughout:

- **Little leaves the Mac.** The helper sends times, titles and your answer.
  It sends who is invited only for events you organized or accepted. It never
  sends notes, locations, links or a calendar's name.
- **Titles stay out of the world model**, and **people come only from events
  you accepted or organized**, through a card you sign, exactly as for Google.
  The card says which calendar its people came from.
- **Its token can only push.** Every runtime deploy keeps
  `~/.flint/tokens/apple-calendar.token` (0600). That token can file a calendar
  snapshot and nothing else, and the runtime keeps only its digest.
- **A gap never reads as "gone".** If the helper stops reporting, or macOS
  calendar access is off, the source fails and says why. Nothing is archived,
  and Flint keeps what it last knew. If many events vanish at once (a re-sync
  can empty the Mac's calendar for a while), they're archived only if they're
  still missing an hour later.
- **It's read-only.** macOS only grants full calendar access, so read-only is
  Flint's own rule: the helper is built without any call that changes a
  calendar, and Flint's policy forbids every `apple.*` write.

### Turning it on

Flint Calendar, the helper, is installed by auto-deploy
([`apps/desktop-calendar`](../desktop-calendar/README.md)). Until you connect
it, this source stays off: the runtime answers the helper's route with 404 and
reads nothing.

1. **Check that this Mac has your events.** Press Cmd-Space, type Calendar and
   press Return. If your events are there, go on. If they aren't, open
   System Settings, click your name at the top of the sidebar, click iCloud,
   click See All next to "Saved to iCloud", turn on Calendars, and wait a few
   minutes.
2. **Connect Flint Calendar:** `~/flint/apps/desktop-calendar/connect.sh`.
   It opens Flint Calendar: macOS asks once (click Allow Full Access), then you
   tick the calendars that count and click Connect. It then puts
   `FLINT_SOURCE_APPLE_CALENDAR=on` in `~/.flint/runtime.override.env` (on a
   line of its own, once, keeping the file `0600`), restarts the runtime,
   starts Flint Calendar in the background and files the card that turns the
   source on (`enable-source apple_calendar`), unless the source is on
   already. Flint Calendar's README has each step.
3. **Approve the card.** Open Approvals in the console. The card is "Turn On
   the Apple Calendar Source", and under it: "Your Apple Calendar is read every
   5 minutes and when it changes." Click Approve and confirm with your key.
4. **Check it about 5 minutes later:**
   `cd ~/flint && pnpm --filter @flint/runtime apple-calendar`. It prints one
   line, for example "Connected · Last Read 2 Min Ago · 23 Events". It shows
   states and counts, never a title.

`cd ~/flint && pnpm --filter @flint/runtime p25-report --source apple_calendar`
measures it the way `p25-report` measures Google: what's ahead, p95 freshness
(target: under 15 minutes), a good read with full access in the last 15
minutes, and people only from your calendars.

After a week of good reads,
`cd ~/flint && pnpm --filter @flint/runtime promotion-table --phase p26` files
the card that lets reading Apple Calendar run without asking. Adding people
keeps its own approval.

### Your controls

- **Pause reading:** System Settings > Privacy & Security > Calendars, then
  turn Flint Calendar off. The `apple-calendar` line says "Calendar Access Is
  Off", and Flint keeps what it already knows.
- **Disconnect:** `~/flint/apps/desktop-calendar/disconnect.sh`. It stops
  Flint Calendar, tells the runtime (which archives every Apple event, and the
  `apple-calendar` line says "Disconnected"), then removes the
  `FLINT_SOURCE_APPLE_CALENDAR` line and restarts the runtime, so the line
  says "Off". If the runtime can't be told within a minute (it is down or
  restarting), or hasn't archived within 2 minutes, the source stays on and it
  asks you to run it again. Add `--uninstall` to remove the app too.
- **Turn the source off by hand:** remove the `FLINT_SOURCE_APPLE_CALENDAR`
  lines (with or without `export`) from `~/.flint/runtime.override.env` and run
  `launchctl kickstart -k gui/$(id -u)/com.flint.runtime`. Its events stay as
  they were last known, and the `apple-calendar` line says "Off".
- **Titles:** as for Google, the nightly cleanup deletes each a week after it
  was last seen.

### If it stops reading

- **After you disconnect,** the source is off, nothing is read, and the
  `apple-calendar` line says "Off". If `disconnect.sh` asked you to run it
  again, the source stays on until you do. In that time, once Flint has
  archived your Apple events, the line says "Disconnected", Settings > Health
  shows Apple Calendar as Normal because it's disconnected on purpose, and the
  morning digest leaves it out. To start again, run
  `~/flint/apps/desktop-calendar/connect.sh` (step 2 above). It files no new
  card, because you approved one already. Within 5 minutes the line should say
  "Connected".
- **If it still says "Disconnected" 10 minutes after you connect,** and "Last
  Read" keeps growing, Flint Calendar's pushes aren't landing. Run these two:
  ```bash
  cd ~/flint && pnpm --filter @flint/runtime apple-calendar
  tail -n 5 ~/.flint/calendar.log
  ```
  The log gets one line each time the runtime's answer or your calendar access
  changes (and at least one an hour), with counts and the runtime's answer,
  never a title. The number in parentheses says what to do:
  - **401** ("refused the push token"): the token file changed after the
    runtime last started, so the runtime doesn't know it. Reinstall the
    runtime, which reads the file again:
    `zsh ~/flint/apps/runtime/install-runtime.sh`. It checks and tests the
    code first, so it takes a few minutes. After a 401, Flint Calendar waits
    30 minutes before it pushes again, so the next push lands within 30
    minutes on its own. To make it push now, run
    `launchctl kickstart -k gui/$(id -u)/com.flint.calendar`.
  - **400** ("refused the snapshot"): Flint Calendar and the runtime disagree
    on the snapshot's format, usually because one was updated and the other
    not yet. Both update from `main` on their own, so wait for the next deploy
    (`~/.flint/calendar-install.log` says when Flint Calendar last installed).
    If it's still 400 after that, send Claude the log line. It holds no
    calendar data.
  - **413** ("refused the snapshot"): the snapshot is over 2 MiB. Flint
    Calendar cuts every snapshot to fit, so this is the same mismatch as 400:
    do the same. To read less in the meantime, open Flint Calendar, choose
    fewer calendars and click Connect.
  - **422** ("refused the snapshot"): the snapshot was read too long before it
    arrived (for example, the Mac slept in between), or it was no newer than
    the last one Flint took. Flint Calendar reads again 5 minutes later, and
    that push should land on its own. If it's still 422 after that, send
    Claude the log line. It holds no calendar data.

### Rolling P2.6 back

The migration's `down.sql` (`20261006000000_p26_apple_calendar`) belongs to a
rollback, not to turning the source off:

1. First deploy a runtime from before P2.6. P2.6's job bus expects the Apple
   Calendar queue that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. It puts PersonGuard and the
   forget trigger back exactly as P2.5 had them.

Any later deploy of P2.6 code applies the migration again.

## Goals (P3)

Goals arrive in parts. This first part is only what the database guarantees,
and it changes nothing you see: a goal starts, finishes, is abandoned, or
changes what counts as done or its timing only with your signature, and every
change to its plan is a card you sign. Nothing files a goal card yet, and
nothing reviews goals.

### What the next parts must do

- **The goals panel (part 2)** must forward each card's `consequential` mark to
  the console and ask for a fresh touch on every card that has it. Today the
  console decides `fresh` from `apprAlone` alone, which doesn't look at it, so a
  goal card could go through Approve All on one earlier touch.

### Rolling P3 back

The migration's `down.sql` (`20261009000000_p3_goals`) belongs to a rollback:

1. First deploy a runtime from before P3, with reviews off. P3's job bus
   expects the three goal queues that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. Your goals, their plans and
   their reviews go with it. Their history keeps only lengths, never your
   words, and their forecasts stay in the prediction ledger.

A goal card still waiting expires on its own. One you approve while P3 is
rolled back isn't carried out ("not carried out by the runtime") and stays
approved. Any later deploy of P3 code applies the migration again. Claude runs
`down.sql` only with your OK, after the dump.

## When a database update fails

A runtime deploy whose migration fails installs nothing. You get a note ("A
database migration failed") and Settings > Health lists **Updates**. That
commit isn't tried again until you clear it:

1. A copy of the database from just before the update is in
   `~/FlintBackups/pre-migrate/<sha>.dump`.
2. Fix the migration, then run its `down.sql` by hand.
3. Delete `~/.flint/runtime/migrate-failed`. The next deploy applies the
   migration again.

If the copy itself can't be taken, the deploy stops before the migration and
the note is "The runtime did not deploy" instead: nothing changed, and the
deploy is tried again (as any deploy that fails its checks is).
