# @flint/runtime

Flint's always-on runtime: the world model, the prediction ledger, the job bus,
triage and self-health, on `[::1]:8090` under launchd (`com.flint.runtime`).
`install-runtime.sh` deploys it; your own settings go in
`~/.flint/runtime.override.env`, which deploys never write. That file must be
readable only by you (`chmod 600`): the runtime refuses to start otherwise.

Run the commands below in the deploy checkout, `~/flint`, which is always on
`main` with its packages installed.

## The shadow week: labeling Activity

When triage turns on, it runs in shadow for a week: it sorts what comes in and
sends nothing. Open **Activity** in the console. **Important** is what Flint
judged worth your attention; **Other** is what it filed away. Click a row and
mark it: **Correct** if Flint got it right, **Not Important** (in Important) or
**Important** (in Other) if it didn't. Your marks give the precision that
P2's promotion table (`pnpm --filter @flint/runtime promotion-table`) reports
on the card that lets triage send anything.

## Your calendar (`google_calendar`)

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
3. **Switch it on.** These keep the override file `0600`, whether or not it
   exists yet:
   ```bash
   touch ~/.flint/runtime.override.env && chmod 600 ~/.flint/runtime.override.env
   echo 'FLINT_SOURCE_GOOGLE_CALENDAR=on' >> ~/.flint/runtime.override.env
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
