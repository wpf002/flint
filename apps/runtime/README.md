# @flint/runtime

Flint's always-on runtime: the world model, the prediction ledger, the job bus,
triage and self-health, on `[::1]:8090` under launchd (`com.flint.runtime`).
`install-runtime.sh` deploys it; your own settings go in
`~/.flint/runtime.override.env`, which deploys never write.

## Your calendar (`google_calendar`)

The runtime reads your primary Google Calendar, read-only, every 5 minutes: the
next 14 days become commitments and deadlines in the world model. An event or
deadline within a day gets one heads-up note, once triage is on and its notes
are promoted (P2's promotion table). A few rules hold throughout:

- **Titles stay out of the world model.** An event's title is kept in a
  separate table. It's refreshed while the event is on your calendar and deleted
  a week after it last was. A note says "On your calendar Tue Oct 6 at 14:30" and
  never the title. Only the console's Lanes view shows it, under the "text from
  outside" banner, and a chat read of the event taints the turn.
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
   4. Under "Credentials", create an OAuth client ID of type **Desktop app**.
      Download its JSON and save it as `~/.flint/google/client.json`, then
      `chmod 600` it.
2. **Sign in once:** `pnpm --filter @flint/runtime google-login`. It opens
   Google's consent page and waits on `127.0.0.1` for the redirect. It writes
   `~/.flint/google/token.json` (0600). The offsite backup leaves `~/.flint/google`
   out.
3. **Switch it on:** add `FLINT_SOURCE_GOOGLE_CALENDAR=on` to
   `~/.flint/runtime.override.env`, then run
   `launchctl kickstart -k gui/$(id -u)/com.flint.runtime`.
4. **File the card that turns it on:**
   `pnpm --filter @flint/runtime enable-source google_calendar`. Then sign it in
   the console's Approvals. Signing needs your approval key enrolled, and the
   server in runtime mode (`FLINT_RUNTIME_URL`).
5. **Turn the old Watcher off later.** Do this only once triage is on
   (`FLINT_RUNTIME_TRIAGE=on`), P2's promotion table is signed (`triage.rule`
   and `notify.inapp`), and `p25-report` shows a heads-up delivered. Before
   that, the runtime records heads-ups but doesn't send them. To do it, put
   `FLINT_WATCHER=off` in `~/.flint/secrets.env` and run
   `launchctl kickstart -k gui/$(id -u)/com.flint.server`.

`pnpm --filter @flint/runtime p25-report` measures how it's doing:
- what's ahead;
- p95 freshness (target: under 15 minutes);
- the token's age (it should survive 30 days);
- people only from the calendar.

After a week of calendar syncs,
`pnpm --filter @flint/runtime promotion-table --phase p25` files the card
that would let the sync and person creation run on their own.

### Turning it off

1. Remove the line from `runtime.override.env` and kickstart the runtime. The
   source stops.
2. To revoke Flint's access at Google too, remove it at
   myaccount.google.com/permissions and delete `~/.flint/google/token.json`.
3. Leave the titles: retention deletes each a week after it was last seen. To
   remove one at once, forget its event.

### Rolling P2.5 back

The migration's `down.sql` (`20261001000400_p25_google`) belongs to a rollback,
not to turning the calendar off:

1. First deploy a runtime from before P2.5. The P2.5 code reads the table
   `down.sql` drops, and its job bus expects the calendar's queue.
2. Then take a dump and run `down.sql` by hand.

Any later deploy of P2.5 code applies the migration again.
