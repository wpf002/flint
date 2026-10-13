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

Goals arrive in parts. The first part is what the database guarantees: a goal
starts, finishes, is abandoned, or changes what counts as done or its timing
only with your signature, and every change to its plan is a card you sign.

The second part is the Goals panel in the console (the target icon at the top
right). You add a goal there, open it, and change it. Every signed change is a
card you sign in place, with Touch ID each time, never as part of Approve All.
Pausing, your marks on your own checks, and your steps' progress need no
signature; each is in the audit trail with ids only. Checks on items (a pull
request, an issue, CI, a service, a deploy, a thread) are read as the item
stands: a merged pull request meets "Is Merged" even after GitHub archives it.

A card you leave waiting can't undo a later change. A change to what counts as
done, or to the timing, says what it changes from; if the goal has changed since,
the card is refused ("The goal changed since this card was filed."). Filing a
newer change of the same kind also rejects the older card still waiting.

The third part is reviews, which ship off (see [Turning reviews on](#turning-reviews-on)).
With them on, Flint reviews each active goal on its own cadence, at 09:00 your
time whatever the clocks do, and within minutes when something the goal watches
changes: a watched field of an item, an item finished or reopened, a step due
within two days, a forecast about one of its items that came false, or you
pressing **Review Now**. One review answers everything that was waiting when
it ran: three steps that come due the same day are one review, not three. (A
goal's own forecast coming false never sets one off, or a goal past its date
would review itself every day.) A review has two stages:

1. **The review itself** uses no model, so it never waits on one. It reads the
   checks as they stand, records how likely the goal is to be done in time, and
   sets the next review. That forecast is a rule (the checks met against the
   time gone, less a little for each overdue step), it goes in the prediction
   ledger under its own count, and the database refuses a review without one.
2. **The plan stage** asks the local model on this Mac (Ollama; never an outside
   service) whether the plan needs a change. The model only picks among
   templates, steps, items and checks by id. It never writes a step's title, or
   any other word that is stored or shown: a new step's title comes from a
   template ("Check on wpf002/flint #57"). One model request runs at a time
   across triage, reviews and second opinions, and each waits while a chat
   turn is running. Before it is asked, Ollama's own list of models is checked:
   a model that isn't on this Mac is never sent a goal's words (see "A model
   on this Mac"). A review asks the model at most twice. If the model isn't there at all, the
   plan stage comes back 2 minutes later, up to 3 times, before the review
   says the model didn't answer.

Every plan change is still a card you sign. A review's small changes (a status,
a date moved by a week or less, the order) share one card, which can ride
Approve All; each bigger one (a step added or skipped, a date moved further or
past the finish date, anything on a decision or a Flint action) is a card of its
own, signed with a fresh touch. A review files at most 2 new bigger cards, and
Flint at most 9 new plan cards a day. Small or bigger is decided by rule from
what the card holds, never from what it is called: by the runtime when the card
is filed and again when it runs, and by the console before Approve All.

**Cards that wait are yours.** A later review does not clear them away:

- A change a waiting card already asks for is that card. It is kept and not
  filed again, whatever would hold a new card back (the day's 9, the review's
  2). A due date within a week of the card's is the same change, so "in 3
  days" tomorrow does not replace yesterday's card. Once the card's day has
  passed, though, it is replaced by a card with the fresh date: you are never
  asked to sign a day that is already gone.
- Flint withdraws a waiting card, unsigned ("A newer review replaced it."),
  only when the plan has moved on so the card can no longer apply, or when a
  newer review changes the same thing differently (another status, a date over
  a week away, another place).
- A review that suggests nothing, or whose model gave no usable answer,
  withdraws nothing that still applies. A card that can no longer apply is
  cleared away either way.
- A card is never cut in two. When a review changes its mind about one of two
  changes on a card and the day's 9 are used up, the whole card goes, and both
  changes say they come back at the next review.
- A step you already approved and still have open is not suggested again.
- What you reject is not suggested again for a week. Rejecting a card that
  moves a date and changes a status turns down each of them.
- A suggestion that got no card because of a limit is listed under LATEST
  REVIEW with "Flint will suggest this again at the next review."

**The trial week.** Until you sign the card that promotes reviews (see
[Ending the trial week](#ending-the-trial-week)), every review is in its trial
week: it records what it found and what it would suggest, and files no card. The panel says so under LATEST REVIEW.

**Review Now in the trial week files no card either.** It runs a review right
away, and you read what Flint would change under LATEST REVIEW; nothing lands
in Approvals. That is on purpose: the trial week is for reading its suggestions
before any of them asks for your signature. Review Now says yes only when a
review will run; otherwise it says why in a sentence (reviews are off, a rule
stops them, or the goal has had its 12 for the day). After a yes, the open goal
reads itself again on its own: after a few seconds, after about a minute, then
every minute until the review has finished looking at the plan. Only the facts
and LATEST REVIEW are redrawn, never while you are typing in Add Step, and it
stops when you go elsewhere.

Flint reviews a goal on your request or a change at most 12 times a day; its
scheduled reviews are never capped, and the local model is asked for at most 20
reviews a day. Settings > Health lists **Goal Reviews**:

- off while the planner is off;
- an issue when a review has waited over an hour while Flint was reviewing,
  and down when it has waited over a day of that. Time Flint was off, restarted
  or asleep doesn't count, so a review that came due overnight is not late in
  the morning; but the waiting adds up across nights and deploys, so a review
  stuck for days does show as down;
- an issue when no local model is set up, or when the last few reviews that
  asked the model (up to 3) all got no usable answer. Reviews still run then,
  but suggest nothing.

**On Track** is shown on a goal only when its forecast is for the goal's own
finish date. A goal with no date, or one past its date, still gets a forecast
in the ledger at every review, but for another day, so the panel shows its next
review instead.

The fourth part is goals in chat, the P3 report and the promotion table:

- **Goals in chat** is the server's, and ships off. With it on, a chat turn that
  a model on this Mac answers starts from your active goals: each one's title,
  how many of its checks are met, its forecast and its steps to do. It is never
  sent to an outside model unless you say so, and neither is the turn it was
  answered in. The server's README has the settings and the rules ("Goals in
  chat"); the runtime only answers `GET /v1/goals/now`.
- **The P3 report** measures P3's eight exit criteria as numbers
  ([The P3 report](#the-p3-report)).
- **The promotion table** ends the reviews' trial week
  ([Ending the trial week](#ending-the-trial-week)).

Chat has no tool that reads, files or runs a goal: the runtime connector serves
none, its token is refused by every goal route, and a goal or plan card filed
from a chat is refused ("Goals are changed from the console.").

### The goal routes

All under `/v1/goals`, with the `proposals` scope only: the runtime connector's
token (`world:read|ledger`) can never read a goal's words. `GET /now` answers
the server's goals block: the active goals as closed values (a ref, counts,
days, the open forecast as one of the ledger's seven words and a whole
percent), with a title only for a goal you signed that carries no outside text,
and never a description, a check's text or a step's title. `GET ?tab=` and
`GET /:id` answer the panel; `POST` files a new goal's card from the form's draft
key (the goal's id is made from it, so the same form twice is one card, and a
changed form's card replaces the one still waiting); `POST /:id/edit|timing|done|abandon|resume|plan`
files that card with exactly the args the panel showed (`edit` and `timing`
carry `from`, what the goal was, and replace an older card of theirs still
waiting, whether it came from the console or the CLI); `POST /:id/pause|dismiss`,
`/:id/criteria/:cid` and `/:id/steps/:key` are the unsigned writes; `POST /linkable`
lists items by a label made from their key or from what they are ("Nexus Thread
from Oct 3", and "Nexus Thread 2 from Oct 3" for the second one first seen that
day), never a title or a raw id. `POST /:id/review` is Review Now: unsigned and
audited, it sends the goal's review job, and says yes only when that job will
review (not while a rule stops reviews). A refusal is one of the fixed sentences
in @flint/policy (`GOAL_SAYS`) with its code.

`POST /v1/proposals` refuses any card whose origin is `runtime:<job>`: a job's
cards are filed by the job, inside the runtime. Over the wire an origin is only
a claim, and nothing outside the runtime files under a job's name. It refuses
`goal.propose` and `world.commitment.from_chat` too, whatever the card says:
only the candidates intake files those (below).

### Suggestions from chat

Off until the server is told to send them (`FLINT_EXTRACT_CANDIDATES=1` there
for goals; commitments have their own switch, `FLINT_EXTRACT_COMMITMENTS=1`,
also off: see "A view of commitments" under the follow-ups).
The server's memory extractor, on a model that runs on this Mac, hands the
runtime a goal you set or something you said you would do: a few words, your
own sentence quoted whole, and the conversation and turn they came from (`POST /v1/goals/candidates`, scope
`proposals`: the server's token only, never the runtime connector's). The
server has already checked that the quote is in your own message of that turn.
The runtime holds no transcript, so that check is the server's. Everything else
it checks again, whatever the server says:

- the request's shape: ids as the server names conversations and turns; a
  quote of 12 to 300 characters in your own characters, one space between
  words; a short text of 3 to 120 characters, counted as a goal's title is,
  with no control or format character (no direction override, no zero-width
  mark); a real day that has not passed and is at most ten years out; a turn
  that ended in the last 30 days;
- the same conversation, turn and quote is one suggestion for good. Its source
  (`chat:` and a hash of the three) is kept in the audit trail, so a replay
  files nothing, even after you dismissed the card and its words were cleared;
- once you turn one down (Dismiss, or Reject on its card), nothing more of
  that kind is taken from that turn, however the quote is cut;
- at most 3 goals and 10 commitments a day.

Known, the day's limit and the filing happen as one step, under one lock on
the source: the same suggestion posted many times at once is one card and one
of the day's slots, and a card that fails to file takes none.

Then it files a card (`src/goals/candidates.ts`), from a chat origin, personal,
kept 7 days, with your quote as its provenance. Each card is marked
consequential: it asks on its own, with its own touch, and is never part of
Approve All, so what a later table rests on is cards you read one at a time. The database refuses such a card
without your quoted words (`proposal_quote_check`, part 1), and the card is
checked once more when it runs: its origin, its template, and that its source
is the hash of that conversation, turn and quote.

- **Suggest a Goal from Chat** (`goal.propose`): approving it adds a proposed
  goal to the Goals panel's Suggested tab. Its title is the short text, its
  description your quote. It is never active: **Make It a Goal** opens the New
  Goal form with your words in it, and one signature (`goal.activate`, through
  `POST /v1/goals/:id/start`) starts it. Made a goal before its own card was
  approved, that card is set aside in the same step; made a goal after, the
  goal the card added is the one started, never a second one. A waiting card
  whose goal already exists, in any status, is not listed as waiting, and
  Dismiss sets that card aside.
- **Add a Commitment from Chat** (`world.commitment.from_chat`): approving it
  adds an unconfirmed commitment. The world model holds no word of it: your
  quote is kept apart, as a calendar title is, and cleared after a week; what
  stays is its hash and the day Flint read. No route on `world:read` serves it
  (chat's tools cannot read it, by id or in a count), and it can never stand
  behind a person: people come from calendar events only.

A new suggestion that shares two content words with an active goal's title asks
for that goal's review, as a watched item's change does, within its 12 a day.

**What runs without a card rests on the database.** A goal Flint takes from
chat is written only when the database itself can tie it to your signature
(the `p3_chat_goal_floor` migration, a guard on every new goal whose origin is
Flint):

- **its own card:** a "Suggest a Goal from Chat" card you approved, being
  carried out now, naming this goal and this source. The goal's title is the
  card's title and its description the card's quote; the card's approval is
  used once, for this goal;
- **Make It a Goal:** your signed start of a suggestion whose own card still
  waits, with exactly what you signed there: its title, its description, its
  checks, how often it is reviewed and its date. That approval is used by
  making the goal, so it is made and started in one step or the card starts
  nothing;
- **a rule you signed:** the later table's row for goals (below), live and
  unscoped, with nothing holding it back, and the intake's audit entry for
  this goal already written. The entry carries the digest of what was added,
  and the database checks the row against it. The description must be a quote
  by the card's measure (12 to 300 characters).

Anything else is refused, with an error that names the goal's id and nothing
it holds (and an id only when it is exactly one made from a source: words
dressed as an id are not repeated). The guard is on new rows only: a goal
proposed before it is listed, started and dismissed as before. It is not on
the migration owner's role (a repair by hand), and a restore loads rows before
any guard exists.

It holds only for a write that reads the database as it is now (READ
COMMITTED, which every writer in the runtime uses). A transaction at a higher
isolation level keeps reading the database as it was when it began: it would
not see the goals added since, a rule switched off since, or a card that has
ended since. So the guard refuses any such write outright, on all three ways
in.

The runtime asks the database whether that guard is there each time it would
add a goal without a card, and each time the later table is asked for. It is a
question, never a constant: after a rollback, or a restore of an older backup,
the same runtime files a card for every suggestion and the table refuses with
one sentence: "Suggestions from chat stay cards for now: the database does not
yet hold a goal Flint adds from chat to a card you signed." The database has
the last word after that too: if it refuses an add (a rule that ended a moment
ago, its own limit), nothing is written and the suggestion is filed as a card.

Under the rule a goal lands as a suggestion, 3 a day at most by the runtime's
count (whatever cap a rule carries). The database counts as well, by its own
clock: never more than twice the day's limit of goals from chat in any 24
hours, which is the most an honest count allows across a midnight. Past that
it lets none in.

What that is worth, exactly: with a rule you signed, a runtime can add at
most that many goals from chat in 24 hours (6 under the table's own row),
whatever it counts itself. Their words are the runtime's own record: it
writes the audit entry and the row, so they are not proof that you said them.
Your signature on each goal is what the two card paths carry, and only those.

A row that holds the rule back is a brake you set, and it holds against the
runtime too. The guard lets nothing in while a live row holds goals from chat
at approval, and the runtime can't switch that row off: the database refuses
it. You switch it off with a card you sign, and the way is then open again
under the row that promotes it. See "Your rules, and switching one off".

**A commitment is always a card.** The database has no such guard under a
commitment, so the intake files a card for each one whatever a rule says, and
the later table never offers the commitments row.

The Suggested tab reads each row against the panel's contract and leaves out
one that does not fit (a title stored before a rule tightened, say), with a
count in the log: one bad row never takes the tab, or the Finished tab, down.

### The P3 report

`cd ~/flint && pnpm --filter @flint/runtime p3-report` prints P3's eight exit
criteria, measured now. Each says pass, fail or null (not enough to measure
yet), with the numbers behind it:

1. active goals (3 are needed), and how many of their checks Flint reads itself;
2. reviews that ran over 24 hours late in the last 30 days, and goals that late
   now. Late is counted the way the panel and Settings > Health count it: the
   time a review waited while Flint was reviewing. A goal that was due while
   reviews were off, or the Mac was asleep, was waiting, not late. Each review
   records its own wait when it runs (over an hour, and over a day), so the
   count does not change when old health checks are cleared. It also says how
   many ran over an hour late (the digest's count), which does not fail it.
   Reviews must also have been on for every whole day it counts: a month with
   reviews off fails, since nothing ran late only because nothing ran. It
   passes after 30 days;
3. how long a watched item's change took to set off its review (10 minutes is
   the limit; a test proves the worst case, and this measures the real ones);
4. plan versions without a signed card behind them, and reviews that filed
   their small changes on more than one card (both must be 0). A card a review
   found still waiting, and kept, counts for the review that filed it;
5. started goals without your signed approval behind their latest change;
6. reviews without their goal's forecast in the ledger;
7. suggestions from chat without your own quoted words (must be 0), with how
   many you approved, how many you made into goals yourself (Make It a Goal
   on one still waiting, which sets its card aside: that is a yes, and is
   counted as one, not as a rejection), how many you rejected and how many
   expired, and how many a signed rule added with no card;
8. the size of the goals block on the chat turns that carried it, by day: the
   mean and the largest, which must stay within 300 tokens.

It holds numbers only: no title, no check, no id. So it is also served as
`GET /v1/p3/report` on the `world:read` scope, like P2's and P2.5's reports.

### Ending the trial week

After a week of reviews, this files the card that promotes them:

```bash
cd ~/flint && pnpm --filter @flint/runtime promotion-table --phase p3
```

Sign it in Approvals ("Let Goal Reviews Run on Their Own"), or let it expire and
reviews stay in their trial week. Signed, it lasts 175 days, and from then on:

- a review files the plan changes it suggests, each still a card you sign (its
  small changes on one card, each bigger one on its own);
- the local model keeps its limit of 20 reviews a day;
- nothing else changes. Starting, finishing, abandoning or changing a goal,
  and every plan change, still take your signature. Those are in no table, and
  no rule you sign can promote them.

The command refuses, and says why, until the week has been lived:

| It says | It means |
| --- | --- |
| the shadow week is not over: 3.2 of 7 days of goal reviews | Flint's first review was less than 7 days ago. |
| goal reviews were on all day on 5 of the 7 days before today (not on ...) | On those days reviews were off, or a rule stopped them, for some of the day, or the health check never ran (the runtime was down all day). A day with nothing due still counts: a weekly goal has no review on most days. |
| goal reviews are off right now | The last health check found reviews off. A week that was lived is no reason to promote reviews that are off. |
| a rule stops goal reviews right now | The last health check found a rule forbidding reviews. |
| the health check has not looked at goal reviews in the last 15 minutes | The runtime is not running, or its health check is stopped. |
| 1 review ran over 24 hours late | A scheduled review in those days had waited more than a day, while Flint was reviewing, when it ran. It ages out of the week. |
| 1 goal is over 24 hours past a review | A review is that late right now: Settings > Health shows **Goal Reviews** as down. |
| the local model has not answered a review yet | No review's plan stage got an answer. Check that `FLINT_TRIAGE_MODEL` is set and Ollama is running. |

The card's details say what the week measured, in numbers: "Since Oct 5, Flint
reviewed your goals 9 times, and none was late. The local model answered 7. It
would have suggested 5 changes." The day it names is the first of the 7 days
the command counted, so the card never says a number the command did not see.
Late there is the digest's count: a review that ran over an hour late. Under
it, each rule the card signs is a sentence: "Goal reviews may run on their own,
up to 20 a day, until Apr 5, 2027." Every rule card reads that way (the earlier
tables' and the backups' too): its details never show the stored rows as they
are stored, and list whatever a sentence leaves out (a row's reason, an action
the console has no words for).

Filing it twice is the same card, but only its own: one this command filed,
with the very rules it would file now and the reason this command writes (its
fixed first sentence, then the gate's own sentence). A waiting card that only
carries the table's name (another limit, another filer) is left where it is and
a fresh one is filed beside it. If a card with exactly these rules is already
waiting and this command did not file it, or it carries other words than the
command's, the command stops and names that card, for you to reject first.

`--phase p3c` is a second, later table, for the goals Flint takes from your
chats (see "Suggestions from chat"). It lets a goal land in Suggested without
asking, 3 a day at most. It is goals alone: the commitments row is never
offered, however many were suggested, because the database has no guard under
a commitment added without a card. It needs the first goal suggestion's card
to be 14 days old, and some of them filed within those 14 days; a commitment's
card is not its evidence. Its card is "Let Flint Suggest Goals from Chat", and
its details count what you did with the goal suggestions: "Since Oct 1, Flint
suggested 9 goals from chat: you approved 4, made 2 into goals yourself,
rejected 2, and 1 expired." A suggested goal is never active until you start
it with your signature. Against a database without the guard under goals from
chat, the command files nothing and says so in one sentence.

**What the command checks is evidence. Your signature is the boundary.** The
command reads rows the runtime itself writes: health checks, reviews, cards.
Two database rules keep those honest as far as they can be (the
`p3_policy_floor` migration):

- a health check and a card are dated by the database when the runtime writes
  them, as a review already was, so a week of "reviews were on" or a two-week-old
  suggestion cannot be written in an afternoon;
- a rule card always asks on its own, with a fresh touch, never in Approve
  All. The runtime sets that mark whoever files the card, the database refuses
  a rule card without it, and the console treats one as asking on its own
  whatever it was sent. A card that turns a source on, and one that adds a
  triage rule, are marked the same way when they are filed: one changes what
  Flint reads, the other how it sorts it.

That is all they claim. Something with the runtime's own database access could
still write a row dated now, or delete a health check, or file a card under the
command's own name with the command's own words. Nothing it writes turns a
rule on: only your signature over the rows on the card does, and the card's
details say each of them as a sentence and list everything else the card
holds, in full.

### Turning reviews on

Reviews are off by default: nothing is scheduled, nothing is ever shown as late,
and the panel says so. They cost nothing to run (the local model only). Claude
turns them on once you say OK, with the lines below, which keep the override
file `0600`, add the setting only once and start it on a line of its own:

```bash
touch ~/.flint/runtime.override.env && chmod 600 ~/.flint/runtime.override.env
grep -q '^FLINT_PLANNER=' ~/.flint/runtime.override.env || printf '\nFLINT_PLANNER=on\n' >> ~/.flint/runtime.override.env
launchctl kickstart -k gui/$(id -u)/com.flint.runtime
```

Only `on` turns them on (any case, spaces around it ignored); anything else is
off. Within a few minutes each active goal has its first review, and Settings >
Health shows **Goal Reviews**. The plan stage asks the model triage uses
(`FLINT_TRIAGE_MODEL`); without one, reviews still run and say the local model
is off, and Health lists it as an issue.

### Turning reviews off

Remove the `FLINT_PLANNER` line from `~/.flint/runtime.override.env` and run
`launchctl kickstart -k gui/$(id -u)/com.flint.runtime`. Nothing is scheduled
any more, Health shows Goal Reviews as off, and nothing is shown as late. Your
goals, their plans, their past reviews and any plan cards still waiting stay as
they are. This is also the first step of rolling P3 back.

### What the next parts must do

- **Anything that writes a goal's plan, steps, link cursors or reviews** must
  take the goal `FOR UPDATE` first, as the card executor, the panel's step ticks
  and marks, the review tick and both review stages do. A step write already
  takes the goal `FOR NO KEY UPDATE` in the database, so two ticks on one goal
  wait in turn; a writer that locked a plan or a step first could still wait on
  another in a circle. It must also run at READ COMMITTED (the database refuses
  plan writes above it), write a plan version's draft and its activation in one
  transaction, and hold no lock while a model is asked or a card is filed.
- **Nothing but a signed card changes a plan.** A review only files cards
  (`plan.change`, under its two templates); a later part that wants Flint to
  act on a plan must do the same. The card gate (`checkGoalCard`) holds every
  such card to the review's rules, whoever calls it: a new step only from a
  template and only about one of the goal's own linked items or checks, never
  a Flint action, always waiting for you; only a step's status, date or place
  changed; nothing bigger under the small-change template. A part
  that needs more (a Flint action step) must widen the gate on purpose, with
  its own template and tests.
- **A waiting review card is withdrawn only by the plan stage's rule** (it no
  longer applies, or a newer review changes the same thing differently). A
  later part must not clear a goal's waiting cards wholesale.
- **A goal's forecast is its review's alone.** It is written only by the
  review, with the goal's own template and `auto_world` as its resolver; the
  ledger's route takes neither a goal id nor that template, and the database
  ties a goal's forecast to the goals writer.
- **Anything that puts a goal's words in front of a model** must ask the
  server's one question first (`brainIsLocal`, apps/server/src/policy.ts): is
  the brain being asked on this Mac? The goals block does, for every ask. A
  chat tool that read goals would have to be served to a local brain only, and
  today there is none.
- **Anything else that files a suggestion from chat** must go through the
  candidates intake (`takeCandidate`), never `createProposal` on its own: the
  intake is the one place the request is checked, the source is recorded and the
  day's limit is claimed. A source that is not your own typed words (mail, a
  page, a transcript of someone else) must not use these two actions at all: the
  database's floor is "your own untainted words from chat".
- **Anything that reads commitments for a model** must leave the ones from chat
  out, as the `world:read` routes do, unless the brain being asked is on this
  Mac: one may come from a turn that stays here.
- **A view of commitments in the console** is still to build: an approved
  commitment from chat is kept, and shown nowhere yet but on its card, and
  nothing removes one. That is why commitments have their own switch on the
  server (`FLINT_EXTRACT_COMMITMENTS`), off: turn it on when a panel lists them
  and a route forgets one.
- **A guard under commitments from chat** is still to add, before their row
  is ever offered: the database would have to hold an unconfirmed commitment
  to its own signed card or to a signed rule, as it now holds a goal
  (`p3_chat_goal_floor`). It needs a signed-card check for a card that is not
  a goal's, a record of that approval's one use, and a rule on the world
  model's own table. Until then a commitment is always a card
  (`ALONE_WITH_FLOOR` in `src/goals/candidates.ts`, `P3C_OFFERED` in
  `src/governance/promotion.ts`).
- **A later part** must add a way to forget a goal's words (a signed
  `goal.forget`). Goals, plans, steps and reviews have no forget path yet.

### Known limits

- **Whether a turn exists is the server's word.** The runtime holds no chat
  transcript and no list of turns: it checks a suggestion's ids for their shape
  and binds the card to them, but it cannot check that the turn happened or
  that the quote is in it. That check is the server's, on your own message
  only. What the runtime adds is its own shape rules, the one-suggestion-per-
  source rule, the day's limit and the database's floor.
- **A dismissed suggestion is final for that turn.** Dismiss asks first; after
  it, nothing more of that kind is suggested from what you said that time. The
  same goal said again in a later chat is a new suggestion, and the Dismiss
  question says so.
- **One sentence is one suggestion.** A goal and a commitment in the same
  sentence come to one card, whichever the model named first.
- **What a signed rule adds leaves no card.** Once you sign the later table, a
  goal is added with an audit entry (its source, the day you said it, the rule
  that let it, the digest of what was added) and no card to read. The P3
  report counts those apart, and its seventh criterion rests on the cards.
- **Under the rule, the audit entry is the runtime's own.** The database
  checks that the entry is there and that the row matches its digest, but the
  runtime writes both. Against a runtime gone wrong, what holds is the rule
  you signed, the shape of the row (yours, personal, untainted, named by its
  source, a quote's length) and the database's count: at most twice the day's
  limit of goals from chat in any 24 hours. What it says you said is the
  runtime's word, as on a card it is the server's.
- **A row that holds goals from chat back ends only on your card.** The
  runtime can't switch it off (see "Your rules, and switching one off"). Once
  you do, the promoting row lets goals land again, within the same count.
- **A commitment's words last a week.** Your quote is kept beside the
  commitment for 7 days, then cleared with the rest of the kept text; the
  commitment and the day Flint read stay. Forgetting the commitment clears its
  words at once, but its approved card keeps them until the cleanup clears that
  card (7 days after it ran).
- **A refused suggestion is not asked again.** One refused because a rule
  forbids suggestions is recorded by its source like any other, so lifting the
  rule later does not bring it back.
- **History keeps lengths.** A goal's history records how long each changed text
  was, never the text. Someone who can read the database and guesses a short
  title could confirm the guess from its length. That's accepted.
- **What holds against a runtime that breaks the rules.** The rules bound to
  your signature hold even then, because they rest on your approval: what a goal
  is and what counts as done, its timing, its links, each plan version, the
  digest of what you signed, one transaction per approval, and the snapshot
  checks. Three rules are written by the runtime itself, so they catch its bugs,
  not a runtime gone wrong: the quote check on chat suggestions, the proof that a
  Flint action step was done, and the `runtime:goals` label on a goal's forecast.
- **A fresh touch is the console's to keep.** A goal card is marked
  `consequential`, and the console signs it only with a fresh Touch ID or
  password prompt, on its own. Neither the server nor the runtime can tell a
  fresh signature from one made under the Mac's 5-minute unlock: the Secure
  Enclave signature is the same either way (a passkey always asks). A console
  that ignored the mark could still sign a goal card on an earlier touch.
- **Item titles in the picker.** To find an item, the panel shows its title
  beside its label, marked as outside text. What is stored and signed is the
  item's id and its label, never the title.
- **What a change changes from is checked by the runtime, not the database.**
  A card to change what counts as done, or the timing, signs `from` (what the
  goal was), and the runtime refuses it when the goal no longer matches. The
  database still compares only the new values with the row; checking `from`
  there too would need a migration. Every such card must carry `from`, however
  it is filed (the console, or the CLI straight at the runtime): one without it
  is refused when filed and again when it runs.
- **The local model reads a goal's words.** A review's plan stage sends the
  goal's title, why it matters, its checks and its steps to Ollama on this Mac,
  inside data blocks, and nowhere else. "On this Mac" is checked before each
  request, with Ollama itself, for that exact model: its address alone isn't
  enough (see "A model on this Mac"). A linked item is sent as a short ref and
  its state (open, merged, healthy), never its title. Logs, jobs, audit entries
  and errors carry ids and counts only.
- **A model request already running is not interrupted.** A review checks for a
  chat turn before each request, and waits if there is one; a request it has
  already sent can hold chat up for as long as it runs (at most 90 seconds, and
  usually a few).
- **Late is counted from the health check's own rows.** How long a review has
  waited "while Flint was reviewing" is added up from the Goal Reviews rows the
  5-minute health check keeps in the database (rows at most 12 minutes apart
  count as one stretch). Nothing is kept in memory, so a restart loses nothing.
  The other side of it: if the health check itself is stopped (a rule forbids
  it), no time is counted and nothing shows as late; and the rows are kept 30
  days, which is far more than the day it takes to show as down.
- **Waiting plan cards can add up.** Because a review no longer clears the
  cards before it, a goal can have several days of suggestions waiting at once
  (at most 9 new cards a day across all goals, each kept a week). Reject the
  ones you don't want: they are then not suggested again for a week.
- **A plan change can set off one more review.** When a step is due within two
  days and the plan changes (you approve a card), Flint reviews the goal once
  for the new plan. Each needs your signature first, and a goal has at most 12
  such reviews a day.
- **A quiet week still counts.** The promotion table asks that reviews were on
  for each of the 7 days, not that each day had a review: goals reviewed weekly
  have none on most days. So a week with few reviews can be promoted; the card
  says how many there were, and that the local model answered at least one.
- **A day counts on the health check's word.** The promotion table and the P3
  report read the same Goal Reviews rows lateness is counted from. A day counts
  when a check that day found reviews on, and none found them off or stopped
  by a rule. A runtime that was down for part of a day leaves no check for that
  part, so that day still counts; a day with no check at all does not. If the
  health check itself is stopped, no day counts and the table can't be filed.
  A day is your day, in `FLINT_TZ`.
- **`FLINT_TZ` is a zone's name.** "America/Chicago", not "-06:00": the runtime
  and its database read an offset's sign the opposite way, so one is passed
  over with a warning in the log and the next setting, or America/Chicago, is
  used. A name that is no zone at all still stops the runtime at start.
- **Forecasts wait for their dates.** When you mark a goal done or abandon
  it, that card settles the goal's forecasts. A forecast whose date comes
  with the goal not finished is recorded as not met by the prediction check
  (see "Checking predictions"), which runs only once predictions are turned
  on. Until then such forecasts stay open in the ledger, one for each review.
- **A review's suggestions are a model's.** The rules bound what a suggestion
  can be (a template, a step, a date, a status that is never "done"), not
  whether it is a good idea. That is why each is a card, and why reviews start
  with a trial week.
- **Older card kinds.** For goal and plan cards the database checks that the
  digest you sign is the digest of the stored args. For older kinds it doesn't
  yet (P1's `consume_approval` compares two digests, not args). For every kind,
  the console hashes the args its card shows you and signs nothing unless that
  is the digest it's asked to sign, and the server checks the same before it
  starts. A database check for the older kinds is a follow-up.

### Rolling P3 back

The migration's `down.sql` (`20261009000000_p3_goals`) belongs to a rollback:

1. First turn reviews off (above) and deploy a runtime from before P3. P3's
   job bus expects the three goal queues that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. Your goals, their plans and
   their reviews go with it. Their history keeps only lengths, never your
   words, and their forecasts stay in the prediction ledger.

A goal card still waiting expires on its own. One you approve while P3 is
rolled back isn't carried out ("not carried out by the runtime") and stays
approved. Any later deploy of P3 code applies the migration again. Claude runs
`down.sql` only with your OK, after the dump.

The guard under goals from chat is a database update of its own
(`20261015000100_p3_chat_goal_floor`). In a rollback, anything newer is undone
before it. Its `down.sql` takes away two triggers and their function, and
loses nothing: no table, no row, and the record of which approvals were used
stays. It needs no older runtime. The runtime sees the guard is gone, files a
card for every suggestion again, and refuses the later table. A rule you
already signed stays signed and does nothing while the guard is away.

## Predictions (P4)

Predictions arrive in parts. The first part was the store and what the
database guarantees about it. The second is Flint checking its own predictions
(see "Checking predictions" below). The third is the numbers themselves and
their forecasts (see "Daily numbers and forecasts"). The fourth is where you
see it all: the console's Predictions panel (see "The Predictions panel"). The
fifth is the local model's own estimate beside each forecast (see "The local
model's second opinion"), which has a switch of its own. All of it is off
until you turn it on. Flint forecasts its own numbers on this
Mac: no series is sent anywhere, and no part of this calls an outside
service.

What the database now holds to, whatever the runtime's code does:

- **Nothing is forecast until you turn it on.** A number is forecast only after
  you sign the Turn On Predictions card that lists it. The card acts once, in
  one transaction, and only if it was filed to ask for your own touch. Turning a
  number off needs no signature, and stops its forecasts at once.
- **A forecast says what it earned.** A prediction is recorded as `statistical`
  only when its forecast beat a plain guess in its own backtest, and as
  `base_rate` only when it didn't.
- **Spend and calendar numbers stay labeled.** A series' sensitivity can never
  change. A series in dollars, or of spend, is financial, and a calendar series
  is never ops data. Before this, a runtime could have relabeled a spend series
  as ops data. The update also puts right any series that already was.
- **No number leaves this Mac.** No series can be marked as allowed to leave,
  by anyone, under any card. There's no such card. Every forecast is computed
  here, and Flint has no action that calls an outside forecaster.
- **Your predictions are yours to settle.** A prediction that only you resolve is
  settled only by your answer to its question.
- **Scores wait for enough results.** The finer accuracy measures are stored only
  once 100 predictions in a group have been scored.
- **A forecast's numbers stay out of errors and out of chat.** A forecast, a
  daily number or a result that the database refuses names the row and the
  rule, never a number. Chat's list of open predictions leaves forecasts out,
  so a spend or calendar figure can't reach a chat model through it.

### The two switches

Both must be on before anything runs:

1. `FLINT_PREDICT=on` in `~/.flint/runtime.override.env`. It's off by default,
   and any other value is off. Off, the prediction jobs aren't scheduled at
   all. On, they're scheduled and still do nothing until the card is signed.
2. The signed Turn On Predictions card. This is the real gate, and the database
   enforces it. You file it from the console's Predictions panel and approve
   it there (see "Turning predictions on" below). The card names each number
   it covers, and says when spending or calendar numbers are among them. It
   always asks on its own, with a fresh touch, and never rides Approve All.

### Daily numbers and forecasts

Each night, for the numbers you turned on, in this order:

| When | What |
|---|---|
| 03:30 | Yesterday's value of each number is recorded. |
| 03:40 | The sweep checks the forecasts that value settles. |
| 03:45 | The scores are written. |
| 03:50 | Today's forecast of each number is made. |

**The numbers.** Each is built from what Flint already holds, with no text
read and nothing sent anywhere:

| Number | What one day (or week) is |
|---|---|
| Anthropic, OpenAI, Perplexity, Tavily Spend | The day's last reading of that vendor's running total. |
| Deploys | Deployments seen with a new commit that day, and deployments seen for the first time. The day a place (the Studio, Railway) is first read, everything deployed there is seen for the first time at once: those were already there and aren't counted. |
| Flint, Nexus, Trident, Helm Commits | Commits that landed on the main branch of your clone that week. A branch's commits count when they land on main, as one merge, never before. The count is from git and never fetches. |
| Service Downtime | Minutes any of Flint's or Nexus's services was down that day. |
| Open Threads | Threads open at the end of the day. It has no numbers until the Nexus source is on. |
| Calendar Hours | The hours of the day that had an event you accepted, or made. Two events that overlap count once, so a day never has more than 24. All-day events and ones cancelled before they ended don't count. An event moved before it ended counts at its new time. |

A day is your local day, so a 23- or 25-hour day is one day. A number is
written once and never rewritten. The first run fills in what Flint still has
(up to 400 days, or 60 weeks). A day the runtime was down for more than 20
hours is left blank, never written as zero, because nothing was watching.

Each number remembers where it was read to. The next night reads on from
there, so the night's work is the day that just ended, however long Flint has
been running. A blank day is read once and stays blank.

Commits are counted on main only because that's the one count that is the
same whenever it's taken. Counting every branch in the clone gave 79 for a
week that had 15 on main, and a different answer for the same week a month
later.

**The forecast.** A number needs 24 days of history (19 weeks for a weekly
one). That's what it takes to have ten past errors to build a range from.
Flint then tries a few simple forecasters against that number's own past, and
compares the best of them with a plain guess: the last value, the same
weekday last week, or the recent average.

- **Yesterday's number has to be in.** A forecast leans hardest on its latest
  value, so Flint never makes one from a value it filled in. If yesterday's
  number is missing, that number waits a night. Older gaps of a day or two are
  filled from the week before, but never more than a fifth of the history,
  and each forecast records how many of its days were filled.
- **A forecaster has to earn its place.** It's kept over the plain guess only
  with 56 days of history (26 weeks), only if it beat the plain guess by 5%,
  and only if that edge is more than chance. Then the forecast is recorded as
  `statistical`.
- **Otherwise it's the plain guess,** recorded as `base_rate`, and Flint's
  words for it are "no reliable trend".
- **Either way it records an 80% range,** taken from how far off that
  forecaster has been. A range needs ten past errors behind it. With fewer,
  Flint states none.
- **Weekdays get their own range when that fits better.** If a number's busy
  days and quiet days differ, one range for all of them is too wide on the
  quiet days and too narrow on the busy ones. Flint tries it both ways
  against the number's own past and uses the one that held up better.
- **A yes/no question: will today be above the usual?** Its chance is how
  often recent days were above the usual. Flint says more than that only when
  the forecast has shown, on this number's own past, that it knows more, and
  never more than its record supports: it takes 26 right calls in a row
  before it may say 90%.
- **One forecast per number per day (or week).** If one is already waiting to
  be scored, Flint doesn't make a second.
- A number that hasn't changed in 28 days gets no prediction. A range of 0 to 0
  would be right every day and flatter every score.

It's arithmetic in the runtime: no outside service, no model, and the same
numbers always give the same forecast. Under 2 ms for a number with four
months of history, about 20 ms for one with 400 days.

**How honest it is.** These rules came from measuring the first version on
made-up numbers shaped like the real ones (a forecast every night for 100
days, 120 series of each shape). A test repeats the measurement on every
change. When the question said "90% or more":

| Shape of number | First version | Now |
|---|---|---|
| Mostly zero with rare bursts (downtime) | 747 nights, came true 10% | Never says it |
| Sparse counts (deploys) | 639 nights, 26% | Never |
| Nothing to find (counts, dollars, hours) | 289 nights, 32% to 56% | Never |
| Busy weekdays, quiet weekends | 4,154 nights, 53% to 77% | Never |
| A number that drifts (open threads) | 2,903 nights, 97% | 179 nights, 98% |

On the burst shape the question now scores the same as always saying the base
rate (0.092; the first version scored 0.156, where lower is better). The cost
is that it says less where it did know something: on the drifting number its
score went from 0.085 to 0.150, still half the base rate's 0.303.

A forecaster was kept by luck on numbers with nothing to find in up to 19% of
runs at day 22. Now it's 0% to 5%, at day 56, and none before. The cost: on
numbers with a real weekday pattern a forecaster is kept about half the time
after day 56 (it was three times in four), so more of those are said as "no
reliable trend" for longer.

The 80% range held on busy days 75% of the time and on quiet days 97% to 100%.
Now it's 77% to 78% on busy days and 88% to 89% on quiet ones. Whole counts
can't be cut that fine: a Sunday that's 0 three weeks in four still gets a
range that holds 98% of the time.

**What you see.** Nothing yet. The numbers, forecasts and results are kept
(the actions run in shadow), and the Predictions panel that shows them is the
next part. Forecast numbers never go into chat, notes or logs.

**Settings > Health** has a row, **Forecasts**. It's Off until a number is on.
It needs a look when last night's forecasts or numbers didn't run, when a
forecast failed, when the database refused one, or when the night stopped at
its daily limit. Each says which. It's Down after two nights. "Ran" is said
only of a run in the last 26 hours, and never of zero numbers. A restart buys
70 minutes and no more, so a forecaster that has stopped doesn't read Normal
because the runtime restarted. A number still waiting for enough history, or
for yesterday's number, is said, and isn't a fault.

### Turning predictions on

Two steps. Claude does the first with your OK; only you can do the second.

1. Claude sets `FLINT_PREDICT=on` in `~/.flint/runtime.override.env` and
   restarts the runtime. Until then the Predictions panel says "Predictions are
   switched off on this Mac." and offers nothing to turn on.
2. You open Flint and click **Predictions** in the top bar (the chart icon,
   beside Goals). Click **Turn On Predictions**. Every number is switched on to
   begin with; switch off any you don't want, then click **Continue**. Flint
   shows the card: the numbers by name, which of them are spending or calendar
   numbers, and that turning this on also checks the predictions Flint has
   already made. Click **Approve with Touch ID**. Nothing is forecast until you
   do. **Not Now** leaves the card waiting in Approvals for 7 days.

Asking again replaces a card that is still waiting, so a card you left behind
can't be approved later by mistake. One exception: asking for a second opinion
on a number that's already on (see "The local model's second opinion")
replaces only a waiting card that names that number. It doesn't throw away the
card you haven't approved yet for other numbers.

The first forecasts appear the night after a number has 24 days of history
(19 weeks for commits). Spend, deploys, downtime, commits and calendar hours
are filled in from what Flint already has, so most start that night.

To turn one number off: open it in Predictions and click **Turn Off
Forecasts**. No signature is needed, because it only narrows what Flint does. Turning it on
again takes the card.

Claude can still file the same card from the command line, with your OK:

```
cd ~/flint && pnpm --filter @flint/runtime predictions-on
```

That files one Turn On Predictions card for all twelve numbers (or name the
ones you want after the command). Run again, it returns the same card. If
`FLINT_PREDICT` isn't on, it files nothing, says so, and fails.

### The Predictions panel

The **Predictions** button is in the console's top bar once the runtime is
new enough. The panel has three tabs.

**Forecasts** lists the numbers that are on, under TODAY and THIS WEEK. Each
row says one of these, and never a number Flint doesn't have:

| It says | When |
| --- | --- |
| "Flint expects about 4, with an 80% range of 2 to 6." | The forecast beat a plain guess on this number's own past. |
| "There's no reliable trend, and a plain guess gives an 80% range of 0 to 3." | With enough history to judge (56 days, or 26 weeks), it didn't. Only the range is given, never a middle. |
| "It's too early to tell a trend, and a plain guess gives an 80% range of 0 to 3." | There's less history than that, so nothing has been judged yet. |
| "This number hasn't changed in 24 days." | There's nothing to forecast. The count is of the days it really has, up to 28. |
| "Yesterday's number isn't in yet, so there's no forecast for today." | Flint never forecasts from a made-up latest value. It waits a night. |
| "Flint needs 24 days of history. It has 9." | Not enough history yet (19 weeks for a weekly number). |
| "This number has no data yet." | Nothing has been kept for it. |
| "Flint makes its next forecast tonight." | It's ready, and tonight's run makes its forecast. |
| "Flint couldn't forecast this number last night." | The forecast failed. Settings > Health says more. |
| "Forecasts for this number are off." | You turned it off, or never turned it on. |

Click a number to open it: each day (or week) of its forecast with its range,
the chance that today runs above its usual level, how many of its last 30
ranges held, and **Turn Off Forecasts**.

**Questions** is where Flint asks you about the predictions only you can
settle: the ones it made in a chat. Each morning at 07:20 it picks up to five
that have come due, oldest first. Each row is the prediction in plain words
and one line under it: "Flint said likely, around 70%, on Oct 3. It was due
Oct 5 at 3:00 PM." Your answer is recorded as of that due time, so the row
says it. Then three buttons:

- **Yes** or **No** records the result as yours, as of the prediction's due
  time. It's scored like any other.
- **Skip** records that you skipped it and no result. The prediction runs out
  14 days after it was asked, unscored.

Nothing is recorded on one tap. The first tap arms the row: the other choices
go away, and the row shows **Cancel** and one button that says what it will
record (**Record Yes**, **Record No** or **Skip for Good**). The second tap
records it. A double tap doesn't count as the second.

An answer needs no signature: it's what you saw, not something Flint does. It
is recorded once and can't be changed yet (see Known limits), which is why it
takes two taps. Each answer is in the audit trail (who, when, which
prediction, which answer), so a wrong one can be found.

**What Flint can't put in plain words, you can only skip.** That's a
prediction about an item that's gone or about a person, about a number that
isn't one of Flint's own, or one whose words came from outside text. Its row
says "Flint made this prediction in a chat." and "Flint can't show what this
one was about, so it can only be skipped.", and offers only **Skip**. The
runtime refuses Yes or No for it whoever asks. One odd prediction never takes
the tab down: a row that wouldn't fit is shown that same way.

**The 14 days start when you're told.** Until you let Flint ask on its own
(the action is `ledger.resolve.ask_will`, five a day), questions are asked
quietly: they wait in the panel and nothing announces them. A question nobody
announced never runs out. It stays in the list, and stays answerable, for as
long as it takes. Once you let Flint ask on its own, the Predictions button
shows a dot while any wait, the morning summary adds one line ("Flint has 2
questions for you in Predictions."), and the 14 days begin: from then for the
questions already waiting, and from when each is asked for new ones. A
question you skipped you have seen, so that one runs out 14 days after it was
asked either way.

**With predictions switched off on this Mac** (`FLINT_PREDICT` not on),
nothing is forecast, asked or scored. The panel still opens and says so on
each tab. Two things are refused with "Predictions are switched off on this
Mac.": turning predictions on, and answering a question. One thing still
works: turning a number off, which only narrows what Flint does. Reading is
unaffected.

**Accuracy** says how Flint has done, by area, from the night's scores:

- "When Flint said about 70%, it happened 64% of the time, over 41
  predictions." This is the chance it stated most often, and how often that
  came true.
- "Its 80% ranges held 79% of the time, over 120 forecasts."
- "Flint did better than always guessing the usual rate.", or that it didn't.
- Below 30 results of a kind it says how many it has: "Flint has 12 of the 30
  results it needs for its ranges."
- From 100 results: its error score (lower is better) and how far its stated
  chances sat from what happened.

Under LEFT UNSETTLED it counts what was never scored: predictions that ran
out, ones revised close to their date, ones that depended on advice you
declined, and ones set aside with your approval.

**What stays private.** A forecast's numbers include what Flint spends and
how many hours are on your calendar. They go from the runtime to the console
when you open the panel, and nowhere else: not into chat, a note, a log or
the audit trail, and never to an outside service. Until you open it the
console asks only whether questions are waiting, which holds no number. When
you close it, the console drops what it was showing, and the server tells the
browser not to keep any of it. The chat connector's token can't read these
routes or answer a question for you. The audit trail records that you turned
a number off or answered a question, by id, and never a number's value or a
prediction's words.

Chat has its own, older view of Flint's track record (see "The scores can
reach chat, when chat asks" below). For the spend and calendar areas it no
longer includes the range loss.

### The local model's second opinion

Flint's forecasts are arithmetic. A second opinion is the local model's own
answer to the yes/no question each forecast already asks ("does today run
above its usual level?"). It never replaces the forecast. Both answers are
kept, both are checked against what happened, and Flint compares them. It's
off until you turn it on, number by number.

**Turning it on.** On the Turn On Predictions sheet, under LOCAL MODEL, switch
on **Second Opinion**, then **Continue**. The card you approve says so, under
SECOND OPINION. For a number that's already on: open it in Predictions and
click **Turn On Second Opinion**. That shows a card for that one number, which
says "Flint already forecasts this number, so only its second opinion
changes." Either way, nothing changes until you approve the card with Touch
ID.

That card does only what it says. If the number is turned off before you
approve it, it's refused: "This number's forecasts were turned off, so this
card no longer applies. File it again." It never turns forecasts back on. The
runtime decides which kind of card it is when it files it, from whether every
number on it is already on, and the console words the card from that answer.

The switch is offered only where a local model is set (`FLINT_TRIAGE_MODEL`,
the model triage and goal reviews use). Without one, the open number says "No
local model is set on this Mac."

**Turning it off.** Open the number and click **Turn Off Second Opinion**. No
signature is needed, because it only narrows what Flint does. The number's
forecasts stay on, and the estimates already made stay on record. **Turn Off
Forecasts**, at the bottom, turns the number itself off, and its second
opinion with it.

**What you see.**

- On the open number, one sentence: "The local model said about 60%." If it
  hasn't answered for this forecast: "The local model has no estimate for this
  forecast."
- Under **Accuracy**, once the local model and the forecast have both answered
  30 of the same questions in an area: "Over 45 questions, the forecast was
  closer than the local model." (or the local model was closer, or they "did
  about as well"). The same is said against "the usual rate", for the
  questions where no forecast beat a plain guess. Below 30 it says how far
  along it is: "The local model has 12 of the 30 results it needs to be
  compared."
- Nothing is announced: no note, no dot, no line in the morning summary.

An area's own lines under Accuracy don't count the local model's answers:
each is a second answer to a question the forecast already answered, so the
question would count twice. They're scored only in the comparison above. The
scores chat can ask for leave them out for the same reason, so turning a
second opinion on or off never moves what chat reads of Flint's accuracy.

**What the model is asked.** Each night at 03:50, after the forecasts are
written, one question for each number with the switch on: the number's name,
its unit, its last 28 values, the level the question is about, the forecast's
own range, and how the question has come out before. Numbers and fixed words
only. It can reply with only a chance from 5% to 95% and one of six fixed
reasons. A chance outside that range is thrown away, never rounded into
range, and so is a reply with any other word in it. It's asked at most twice
a night for a number, and at most 30 numbers a day. Both limits are counted in
the database, so a job that fails or is run again can't ask a third time. A
job that fails is not retried: that night's second opinion is skipped. An
answer that arrives after the day it's about has ended is thrown away too.

**When there's no answer.** A number with no forecast that night (it hasn't
changed, it's still waiting for history, or yesterday's value isn't in) gets no
second opinion either. The model waits while you're chatting, for up to 10
minutes. Then it gives up for the night, and **Settings > Health > Forecasts**
says so for an hour: "Chat was busy for 10 minutes, so a forecast went without
the local model's second opinion." A model that isn't set, isn't running or
isn't on this Mac means no second opinion. It never becomes a call to an
outside model. The forecast is already written by then, and isn't affected.

If the model answers and its answer can't be saved, that night's second
opinion is missed, and Forecasts says so for an hour: "The local model's
second opinion couldn't be saved, so a forecast went without it." A missed
second opinion is never counted as a failed job under **Settings > Health >
Job Queue**: nothing runs it again, and one missed answer isn't a failing
queue.

**What stays on this Mac.** The model reads a number's values, spend and
calendar hours among them, because it runs here. Its question goes to Ollama
on this Mac and nowhere else, and isn't kept: not in a log, a job or the audit
trail. What's kept of its answer is the chance and the reason code.

### A model on this Mac

Three things in the runtime ask the local model: triage (an item's title), a
goal review (the goal's title and why it matters, in your words) and a second
opinion (a number's values). Each may only ask a model that runs on this Mac.

Ollama's address on this Mac isn't enough to know that. Ollama can serve a
model from its own servers under any name: a cloud model copied to a plain
name looks local, and isn't. So before every one of those requests the runtime
asks Ollama for its list of models, and asks the model only when all of this
holds:

- the model's name isn't a cloud model's (`-cloud` or `:cloud`);
- Ollama's address is this Mac, and Node isn't set to send requests through a
  proxy (`NODE_USE_ENV_PROXY`), which would carry them off this Mac first. A
  proxy is fine when `NO_PROXY` names Ollama's host exactly (an IPv6 address
  with its brackets: `[::1]`);
- Ollama's own list holds that exact model, and says nothing of a remote host
  for it.

The list is asked before each request, and again at the last moment: after
the wait for the model's one slot, and before a second try. One answer is
shared for two seconds, so requests that come together ask once. If the list
fails at once it's asked one more time. If it still doesn't come, hangs, or
doesn't hold the model, the answer is no. What Ollama said a moment ago isn't
trusted once it stops answering.

When the answer is no, nothing is sent to the model, and each caller does what
it does with no model:

| Caller | What happens | What you see |
| --- | --- | --- |
| Triage | The item is logged to Other without the model's review. It's never escalated on a guess. | The item is in Other. |
| A goal review | It tries again 2 minutes later, up to 3 times, then suggests nothing. | "The local model didn't answer, so Flint suggested no plan changes." |
| A second opinion | None is recorded that night. | "The local model has no estimate for this forecast." |

**Settings > Health > Local Model** reads the same list, and says which it is:
"The local model isn't on this Mac.", "The local model isn't installed.", or
"Flint couldn't check which models are installed."

The server decides the same question for chat with the same rules (they're
shared code, in `packages/policy/src/models.ts`). It keeps a watch on the
list and trusts it for a few minutes, because it reads it on every chat turn.
The runtime's requests are few and carry your own words, so it asks each time.
If the Mac's clock is set back, neither trusts what it heard before: an
answer's age can't be told then, so each asks again.

To fix a model that isn't on this Mac: set `FLINT_TRIAGE_MODEL` in
`~/.flint/runtime.override.env` to a model `ollama list` shows without a cloud
tag, and restart the runtime. Claude does this with your OK.

### Checking predictions

Flint now settles and scores its own predictions. Until this part, nothing
did: a prediction was recorded and then sat open for good. Both jobs below run
only with the two switches on, so on deploy nothing runs.

**Turning predictions on also checks what Flint has already predicted.** The
first check after you sign the card goes over every prediction already in the
ledger, not only new ones:

- Triage's "this service will be healthy again" predictions, of any age, are
  settled from how the service stood at the time.
- Advice still waiting is decided from what you did with its note. Under
  shadow triage you were shown none of it, so all of it lapses, and what each
  piece promised is set aside as "condition unmet".
- A goal's forecast whose date has passed with the goal not finished is
  recorded as not met.
- Your own predictions, the ones only you can answer, are left open. Flint
  doesn't let one of yours run out before it has asked you.

None of that can be undone: a result is never deleted, and nothing corrects
one yet (see Known limits). The Turn On Predictions card says so under Show
Details. Nothing is voided, and nothing is recorded as yours.

**The sweep** runs every hour at :40. In order:

1. It decides each piece of advice from what you did with its note. You
   acknowledged it before its time was up: taken. You dismissed it: declined.
   You left it: lapsed.
2. It settles every prediction that is due and can be checked without you:
   - A forecast is checked against its own number for that day or week, once
     the day or week is over and the number is there.
   - Triage's "this service will be healthy again" is checked against how the
     service stood at that time, never how it stands now, and only once Flint
     has seen the service again.
   - A goal's "on track" forecast that reaches its date with the goal not
     finished is recorded as not met. When you mark a goal done or abandon it,
     that card settles the goal's forecasts, as it already did.
   - A prediction about advice you declined, or let lapse, is set aside as
     "condition unmet". If you took the advice, it's checked like the others.
3. What can't be settled runs out. A prediction Flint can check itself runs
   out 72 hours after its time. One only you can answer runs out 14 days
   after you were told its question waits, and never before. Flint asks in
   the Predictions panel's Questions tab, up to five new ones a morning. A
   question asked quietly, before you've let Flint ask on its own, hasn't
   been announced to anyone, so its 14 days haven't started (see "The
   Predictions panel").

It never answers for you. A prediction only you resolve is never given to a
resolver, and the database refuses any attempt. It never voids a prediction,
which needs your signature.

**Whose a prediction is.** The check settles, counts and runs out only its
own: a prediction whose rule is one of the four it knows, or that hangs on a
piece of triage's advice. A prediction with no rule at all is nobody's, so
nothing can ever settle it: it's counted, Health says so, and it runs out. A
prediction that carries a rule this check doesn't know belongs to another
part of Flint. It's left exactly as it is: not settled, not counted as a
fault, and never run out from here, so a later part that settles its own
predictions late finds them as it left them. The same goes for advice of any
type but triage's.

**A forgotten item** takes its predictions' words and rules with it. Those
wait and then run out quietly. They aren't a fault, and Health doesn't
report them.

**Triage's first predictions** said they'd be judged by how the service stood
"when it is next observed after the resolve time". Triage now says "at the
resolve time", which is what Flint can read exactly. The older ones are still
judged by their own sentence. Flint keeps a record each time a service's
state changed, not each time it looked, so the state at that next look is
either the one at the resolve time or the next recorded one. Where those two
agree, the prediction is settled by its own rule. Where they differ, the
records can't tell which the next look saw, and the prediction is left to
run out. It's never settled by a rule it didn't state.

**One check is one transaction.** Every row it changes and the audit entry
that counts them are written together or not at all. A check that dies leaves
nothing behind, and the next one starts from the same rows. A single write
the database refuses is taken back alone, counted and left, and the check
goes on. One check runs at a time: a second that starts while one is running
does nothing. It writes one audit entry per run, with counts only.

A check takes on at most 5,000 predictions. If it stops there, the ones it
tried that are past their 72 hours still run out, so a backlog that can never
be settled makes way for what's behind it.

**The scores** are written every night at 03:45 for the last 90 days, one row
per area, kind of claim, method, and yes/no or range:

- Yes/no predictions: the Brier score, the usual rate, and how the stated
  chances compared with what happened, in ten bins.
- Ranges: how often the range held, and a loss that grows with how wide the
  range was and how far off a miss landed.
- Beside each: how many are open, ran out, were set aside, were voided, or
  were revised close to their date.
- The unresolved rate: the share that never got a result. That's the ones
  that ran out, plus revised predictions whose date passed more than 14 days
  ago with no result. A revised prediction keeps its "superseded" status for
  good, so it can't be marked as run out; the rate counts it anyway.
- From 100 scored: the average calibration gap (ECE), and a 90% interval
  around the Brier score. The interval treats predictions that share a day, or
  a goal, as one result, so many predictions about the same week don't look
  like more evidence than they are. With results from fewer than 10 days (or
  goals) there's no interval.

The three actions behind this (`ledger.resolve.auto`, `ledger.expire`,
`ledger.calibration.snapshot`) run in shadow: they write only Flint's own
records and send nothing to you or to chat. A rule that forbids one stops
that part.

**The scores can reach chat, when chat asks.** Chat has had a tool for this
since the ledger was built (`ledger_calibration`), and it reads the latest
night's rows. What it gets is totals only: counts and scores by area. Never a
prediction's words, and never a number a prediction was about. Those totals
go wherever the chat model runs, so with an outside model they leave this
Mac. A group with nothing scored yet is given with no score at all, since a
stored 0 would read as a perfect Brier score, or as a range that never held.
For the spend and calendar areas chat is not given the range loss either: it
is worked out from those numbers' own values, and chat has no use for it.

**Settings > Health** has a row, **Prediction Checks**. It's Off until both
switches are on. It needs a look when no check has run in 3 hours, when the
database refused one of its writes, when a prediction has nothing Flint can
check it by, when no scores have been written two days after you turned
predictions on, or when the scores are over two days old. It's Down when no
check ran in 26 hours. A restart buys 70 minutes and no more: a runtime that
restarts every few hours and never checks still reads late, then Down. What
ran out is said beside what was checked, never as checked.

**Rolling it back:** turn `FLINT_PREDICT` off. All five jobs are unscheduled
at the next start. Resolutions, daily numbers and forecasts already written
stay (none is ever deleted), and each resolution says in its evidence that the
sweep wrote it. Parts 2 and 3 have no database update of their own.

### What changed on deploy

Three things from the first part, and one from the third. None changes
anything you use:

- The third part has a small database update of its own: two new columns
  (see "Rolling P4 back"). Both start empty and are written only by the two
  nightly jobs, which don't run until predictions are on.

- `POST /v1/ledger/predictions` now takes only what chat's
  `ledger_record_prediction` sends. It refuses any other method or resolver,
  and any range, series or forecast field. Nothing sent those.
- `GET /v1/ledger/open` leaves out predictions made from a forecast. There are
  none yet.
- A health check in `HEALTH_EXTRA` can't be named `spend` or `calendar`. Its
  timing is kept as ops data under that name, and the database now reads those
  two names as dollars and as the calendar, so it would refuse the series and
  stop the health source. The runtime refuses the name at start instead, and
  says so. Use a longer name, like `spend-api`.

The update also resets `offBoxAllowed` on every series (no code ever set it)
and fixes the label of any dollar, spend or calendar series stored wrong.

### What this part changed for goal cards

Four safeguards built for the predictions card now cover goal and plan cards
too:

- A card you sign can't be kept for later. It has to expire within a week of
  your signature. Flint files every such card for a week at most, and a test
  holds every place that files a card to that.
- Your approval can't be used up without the change you approved being made.
- A link that is already there doesn't use up an approval when it's written
  again.
- An approval that was used stays used after the database is restored from a
  backup. Each use is recorded with when its transaction began, as well as
  that transaction's number, which a restored database hands out again.

Goal and plan cards work as before.

### What this part fixed for the test database

The `down.sql` files for P2, P2.5 and P2.6 failed on a database with nothing in
it, which is where the test helpers start on a new machine. They now skip what
isn't there.

The action that will tell chat Flint's track record is named
`calibration.note`. An earlier name for it, `persona.calibration_note`,
contains "person", and Flint's rule against collecting on people forbids any
action so named.

### What the next parts must do

- **The console's panel** files the Turn On Predictions card through the
  runtime (`proposeForecasts`, the same call the command makes). Anything else
  that files one must go the same way: the database acts on that card only if
  it carries `consequential` and is at least as sensitive as each number it
  lists, which the runtime sets when it files one.
- **A template only the runtime fills** goes in `RUNTIME_CLAIM_TEMPLATE_IDS`
  in `packages/policy/src/claims.ts`, which keeps it out of chat's. A goal
  review's `goal_on_track` and the forecaster's `series_range` and
  `series_above` are there. The ledger route takes `ChatPrediction` and
  nothing wider. A forecast's question says "on" its day (`series_above`),
  since it's about the whole day or week; chat's `threshold` says "at the
  resolve time" and is left as it is.
- **Anything else that writes a forecast's predictions** must do it as the
  runner does (`predict/run.ts`): the rule the sweep settles them by in
  `resolverSpec` (`{seriesKey, at, end, op: 'range'}` or `{seriesKey, at, end,
  op: 'above' | 'below', value}`, with `at` the first instant of the day or
  week, the same instant its metric point is stored under, and `end` the
  instant that day or week ends), and a `resolveBy` of when that number will
  be there. The rule carries its own `end` so that the step it's about is
  fixed when the forecast is made: if `FLINT_TZ` changes later, the forecast
  is still settled against the day it was about. A rule without `end` is
  still read, with the end worked out in the zone of the day; the runner
  never writes one.
- **The Predictions panel** shows a forecast's range only through the phrase
  table (`predict/phrasing.ts`): "about 4, with an 80% range of 2 to 6" when
  the run beat a plain guess, and "no reliable trend, and a plain guess gives
  an 80% range of 0 to 3" when it didn't. Every sentence about a number, a
  question or a score is made there, by the runtime, and sent as words; the
  console writes none of them and formats no number, so it can't show one the
  runtime didn't send. A new state needs its sentence there first. A run may
  hold fewer than seven days ahead (only the days it has ten past errors
  for), and the panel lists what the run holds.
- **A forecast's numbers go to the console and nowhere else.** The panel's
  routes need the `proposals` scope, the server's proxy
  (`apps/server/src/predictions-routes.ts`) keeps nothing and logs only
  statuses and field paths, and nothing in `predict/view.ts` or
  `predict/questions.ts` writes a log line. Anything that would put a number
  from these views into chat context, a note or a log needs its own decision.
- **The next database update** should take two things this part holds in code
  only:
  - A recorded day can still be changed or deleted by the runtime's own
    database role, and a point that isn't a number, is negative, or is dated
    ahead is accepted. The numbers job never does any of that ("written once"
    is its own rule), but the database doesn't refuse it.
  - A day is stored under its first instant in the zone of the time. If
    `FLINT_TZ` changes, older days read as the day before, and the first night
    writes a second point for a day that already has one. A forecast made
    before the change is still settled against the day it was about (its rule
    carries that day's end); the history it's read from is what moves. Don't
    change `FLINT_TZ` with predictions on until the days are stored by their
    date.
- **The local model's estimate** (`predict/reason.ts`) is the only file under
  `predict/` that may reach anything, and only loopback Ollama through
  `scopedFetch`. `test/predict/no-egress.test.ts` lists every file there and
  names that one. `test/predict/no-egress-db.test.ts` runs the night's
  jobs with the network taken away and every command recorded: a new command,
  or anything that reaches for the network, fails it. For the estimate's job
  it gives one thing back, a stand-in for Ollama on this Mac, and holds the
  job to two requests: the list of models, then the question.
- **Anything new that asks the local model** asks `model/here.ts` first
  (`runsHere`), before it builds a request, and treats a no as "unavailable".
  It sends through the shared slot (`model/slot.ts`), so two local requests
  never run at once. `test/model/here.test.ts` lists every file that asks a
  model and fails when a new one isn't on the list;
  `test/model/here-server.test.ts` holds each to "nothing is sent" against a
  stand-in Ollama whose list says the model runs elsewhere, hangs, or fails.
- **Anything that reads Ollama's lists** (what's installed, what's loaded)
  reads them through `model/here.ts` (`list`). Settings > Health does.
- **Whatever writes a run** (the runner does, and the local model's estimate)
  must write it and its predictions at READ COMMITTED
  (the database refuses them above it). A refused run means the number was
  turned off: skip it, don't retry it. A run's provider is `local` and its
  endpoint is `local:` and a short name (`local:fc.v1`), never a URL. Its
  points are `{at, mean, lo, hi}` and nothing else, with `at` as
  `Date#toISOString` writes it; build them with `JSON.stringify` from finite
  numbers, so the database is never sent JSON it can't read (see Known
  limits). A run takes one range and one yes/no question from the forecaster,
  and one estimate from the local model; a second of any is refused. Every
  prediction the two forecast writers make names its run and its series,
  carries the series' own unit, and is filed under the registry's domain for
  that series.
- **The questions** (the console's panel) are what let a prediction of yours
  run out: it runs out 14 days after its question was asked, and one that was
  never asked about stays open.
- **A part that settles its own predictions** gives them a rule of its own
  shape in `resolverSpec` and settles them itself. The check leaves any rule
  it doesn't know alone, for good. A rule the check should settle is added to
  `ResolverSpec` in `predict/resolvers.ts`, with its resolver.
- **The answer route** must set `flint.actor` to `will:console` in the same
  transaction as the answer and its resolution.
- **A correction to a result** (`ResolutionCorrection`) has no id-only check
  yet, so a refused one could still print its value into Postgres's log.
- **Whatever shows forecasts** must use its own routes, behind the `proposals`
  scope. `GET /v1/ledger/open` is chat's and never lists them.
- **A forget** doesn't reach forecast runs or a forecast's predictions yet. A
  forgotten series gets no new runs or predictions, and its past numbers stay,
  as its metric points do. Whether to blank them is still open.
- **Goal reviews** must keep `auto_world` on a goal's forecasts, so the check at
  each forecast's date can settle it. A forecast marked for you alone is settled
  only by your answer, or by the card that finishes its goal.

### Known limits

- **What holds against a runtime that breaks the rules.** The rules bound to
  your signature hold even then: which numbers are on and the one use of each
  approval. So do the rules that need no signature because nothing may break
  them: a series' sensitivity, and that no series leaves this Mac.
  Three things are written by the runtime itself, so there the database
  catches a bug and can't catch a runtime gone wrong: a forecast run's own
  arithmetic (whether it beat a plain guess), the snapshot's scores, and the
  `will:` label on an answer. An answer isn't signed on purpose.
- **A wrong result can't be corrected yet.** The rules name a signed
  correction (`ledger.resolution.correct`) and a signed void (`ledger.void`),
  and the database has a place for each. Nothing carries either out yet, and
  the scores don't read corrections. Until a later part does both, a result
  stays as it was recorded. That includes your own answer to a question: a
  wrong one can't be undone yet. It takes two taps to record one, and the
  audit trail says which answer was given to which prediction, so a wrong
  one can be found and put right once corrections are carried out.
- **What an automatic check records.** The outcome of an automatic check is
  the runtime's own reading of its rows. The database holds it to the rest:
  who may resolve what, that the event isn't before the prediction or after
  now, and that it's never recorded as yours. A wrong one can't be corrected
  yet (see above).
- **What can't be checked runs out.** A service that was removed or forgotten
  before its time came, a number that never arrived, a goal forecast left
  behind by a finished goal, and one of triage's first predictions whose own
  rule the records can't answer are not guessed at. They run out after 72
  hours and count against the unresolved rate.
- **A revised prediction can't run out.** It stays "superseded", and the check
  keeps trying it for 14 days after its date. A check that stops at its limit
  can't clear those out of its way, so 5,000 of them that can never be settled
  would hold up what's behind them until they age out. Flint revises a few
  dozen a day at most.
- **A late result can still set off a goal review, within a week.** A result
  that came false sets off a review of a goal that watches the item only when
  both the result and what it was about are from the last 7 days. So the
  first check of old predictions sets off reviews only for last week's.
- **The question says less than it could.** To never say "90%" of something
  that happens one night in ten, the yes/no question now says the plain share
  of recent days unless the forecast has earned more on that number's own
  past, and it needs 26 right calls in a row before it may say 90%. On a
  number that really does drift, that's a blunter answer for the first few
  months than the first version gave.
- **The honesty numbers are from made-up series.** Every coverage and
  calibration figure above is measured on simulated numbers shaped like the
  real ones. Your own numbers get their real scores from the nightly check,
  once predictions are on.
- **Commits are what your clone has.** The count is of the main branch as the
  clone last fetched it. A clone that isn't fetched for a week counts that
  week low, and the number, once written, stays.
- **A deployment that was already there isn't a deploy, by place.** The first
  day a place is read, none of its first sightings count. A deployment added
  to that place later counts on the day it's first seen, even if it had been
  running elsewhere.
- **Taking advice means acknowledging its note.** Flint reads "you took the
  advice" from the note being acknowledged before the prediction's time. It has
  no other way to know yet.
- **A series born under the wrong label.** A series' label can't change, so one
  created wrong stays wrong. The database refuses the wrong labels it can
  recognize: a dollar or spend series that isn't financial, and a calendar
  series marked ops. For anything else, the Turn On card refuses a series whose
  stored label isn't the registry's, so it's never forecast under that name.
  The item a series is about is fixed when the series is made, too. It can't
  be tied to one later, so forgetting an unrelated item never stops a number.
  The Turn On card also refuses a registered number whose stored row is tied
  to an item: Flint's own numbers are about no single item.
- **Errors and Postgres's own log.** The id-only rule covers the `INSERT` and
  `UPDATE` statements the runtime makes. Three things are outside it. `COPY`,
  which the runtime never uses, quotes the line it refused. A value Postgres
  can't read as its type at all is refused before any rule runs, and that
  error quotes the text around the fault: malformed JSON for a run's points
  (a `NaN`, say) shows the numbers beside it, and text that isn't a number
  shows the text. The runtime sends typed values and builds JSON with
  `JSON.stringify`, so it sends neither. And a Postgres set to log every
  statement's values would log them all.
- **An outside comparison would need its own update.** If Flint is ever to
  compare its forecasts with an outside forecaster, a later database update
  has to add a signed way for a series to leave. Nothing here can open one.
- **Chat's own tools are a separate matter.** The rule against an outside
  forecaster covers Flint's own actions. A tool that a connected service offers
  to chat is judged by the rules for chat tools.
- **A transaction held open.** A signed card acts in one transaction. A runtime
  that kept that transaction open could delay when its changes land. A restart
  of the runtime ends it.

### Rolling P4 back

P4 has two database updates, and each has a `down.sql` that belongs to a
rollback. Updates are undone newest first, and two others sit between P4's
two:

1. `20261014000000_p4_forecast_inputs` (P4's third part): two columns, how
   many days of each forecast were filled in and where each number was read
   to. Its `down.sql` drops them and loses nothing else. Undone alone, it
   needs a runtime from before that part.
2. `20261013000150_public_schema_floor` (who may reach the database at all).
3. `20261013000100_p3_policy_floor` (goals, part 4). See "Rolling P3 back".
4. `20261013000000_p4_forecasts` (the store). Undoing this one is the real
   rollback of P4.

To roll the store back:

1. First deploy a runtime from before P4, with `FLINT_PREDICT` off. P4's job bus
   expects the six prediction queues that the store's `down.sql` drops.
2. Then take a dump and run the four `down.sql` files by hand, in the order
   above. Forecast runs, which numbers were on, and your questions and
   answers go with the store. So do the scores only P4 keeps (range scores
   and the finer measures), which a later snapshot recomputes. Every
   prediction and resolution stays, and so does each yes/no score; a
   forecast's predictions lose their range and their link to the run. The
   four safeguards on goal cards go back to how P3 had them.

The Predictions panel (P4's fourth part) added no database update. Rolling
it back is deploying the code from before it: the Predictions button goes
away, the morning's questions stop being picked, and every question already
asked and every answer stays in the database.

The second opinion (P4's fifth part) added no database update either. To stop
it without a deploy, turn it off for each number (open the number, **Turn
Off** under SECOND OPINION). Rolling it back is deploying the code from before
it: no second opinion is asked for, the switch and its sentences go away, and
the estimates already made stay on record and are still checked. A number's
Second Opinion switch stays set in the database, and does nothing until the
code is back. That part also changed how triage and goal reviews decide a
model is on this Mac (see "A model on this Mac"); rolling it back puts back
the older check, which looked at Ollama's address only.

A Turn On Predictions card still waiting expires on its own. One you approve
while P4 is rolled back isn't carried out ("not carried out by the runtime")
and stays approved. Any later deploy of P4 code applies the updates again.
Claude runs a `down.sql` only with your OK, after the dump.

## Assets, tasks and reviews (P5)

This arrives in parts. The first part is the store and what the database
guarantees about it. The second adds the runtime's side for work that needs no
model: one asset (the CI Watcher), tasks, and the cards that run them. It
ships switched off. The one thing you'll see is a Tasks row in Settings >
Health, shown as off. Nothing else changes until tasks are switched on and you
turn an asset on, and the Tasks panel that lets you do that comes in a later
part.

Three things live here:

- **Assets** are what Flint may hand work to. The first is the CI Watcher,
  which only reads CI runs Flint already tracks. The local model comes next.
- **Tasks** are single pieces of work handed to an asset. Each has a written
  bar and ends with a record of whether it met it.
- **Reviews** are an argued verdict on a card, written before you approve it.
  A review is advice. It never rejects anything.

What the database now holds to, whatever the runtime's code does:

- **An asset is off until you turn it on.** It's turned on only by the card you
  sign for it, once, and only as exactly what that card describes: its kind,
  what it can do, whether it spends, and the item it stands for. Turning it off
  needs no signature.
- **The later signature stands.** When you've signed two cards about the same
  asset, task or review requirement, the later one counts, whichever one Flint
  carries out first, and whatever happens to the later card afterwards. Signing
  against a card counts the same as signing for one. This holds for a card that
  was on record when you signed it. A card to turn an asset on that you signed
  before you turned that asset off can't turn it back on. The database records
  when you signed and what each signature was for, so nothing can put your
  signatures in another order.
- **A task runs only as the task you signed.** Its card carries the whole task:
  the asset, the title, what to do, the bar, any goal and step, the due time
  and the cost estimate. If any of them differs when Flint goes to run it, the
  task doesn't run. It runs only while its asset is on, whenever you signed
  its card. Each run also needs its forecast on record first, naming the task
  and the rule that settles it.
- **Paid work says its price first and its cost after.** A task for an asset
  that spends runs only on a spend card filed from the console that carries the
  same estimate, above zero, and it can't end without its cost. No asset that
  spends exists yet. The rule is in place for when one does. No paid review is
  taken at all yet.
- **Flint doesn't accept its own work on its own say.** A task is accepted only
  with its check on record and, until you promote that check, only on a card
  you sign. That card names the result it accepts, and it counts only if you
  signed it after the result was handed in. A task is checked and accepted only
  while its result is on record. Rejecting a result that passed, accepting one
  that failed, and cancelling a task that has gone out each take your signed
  card too. An override says the call was yours.
- **You have a day to overrule a check.** A task's forecast is scored only for
  its task, a day after the task ended, and only as it ended. Until then the
  runtime can't score it, so it can't close the door on your override. A
  forecast of this kind that has no task yet isn't scored at all. Once it's
  scored, the result is final.
- **A review is of the card you're shown.** It's written once, only while the
  card is still waiting, of exactly that card's contents, and only while a
  reviewer is on. What it found never changes. Its words stay while the card
  waits for you. They can be cleared later, never rewritten.
- **Requiring reviews is your switch.** It's off. A card you sign turns it on,
  and only while a reviewer is on. Once it's on, a card that needs a review
  can't be approved without one, and your signature names the review and the
  verdict you saw. A review written after you signed doesn't count. So
  approving past a warning is on record as your choice. Your own card that
  turns the requirement off again never waits for a review. The last reviewer
  can't be turned off while reviews are required.
- **Which cards need a review is decided when a card is filed.** A card with
  outside text in it, one that can't be undone, one about financial data, and
  any card that spends, changes policy or a rule, opens a pull request, forgets
  or voids always needs one. The runtime may mark more. Nothing can unmark one.
- **A plan step that is a Flint task is done only when its task was accepted.**
  Nobody can tick it by hand, Flint included. If you later reject that result,
  the step is no longer done.
- **A forget reaches all of it.** Forgetting an item clears the text of tasks
  about it, deletes their outputs, clears those tasks' cards, clears the words
  of the reviews that read any of them, and blanks the words of those tasks'
  forecasts. An output or a review being written at that moment goes too.
  Outcomes, verdicts and numbers stay. Afterwards no output, no review and no
  card result is taken for those tasks. Two things are kept: a task's title,
  and the codes a review found.
- **Task and review text stays out of errors and history.** A task, an output,
  a review or a card of any kind that the database refuses names the row and
  the rule, never a title, a spec or a model's words. History keeps only how
  long the text was.

### Tasks without a model (part 2)

Part 2 ships switched off (see "Switching tasks on" below). What the runtime
does once tasks are switched on and an asset is on:

- **The CI Watcher** is the one asset so far. It watches a CI run that the
  GitHub source already tracks and reports how it ended. It calls nothing and
  costs nothing. Turning it on needs the GitHub source on first.
- **A task's life.** You ask for a task. Flint writes it down and files its
  card. You approve the card, and the task goes out with a forecast that it
  will meet its bar. The asset hands in a result. Flint checks the result
  against the bar. A result that fails is rejected. A result that passes waits
  for your accept card.
- **Accepting on its own.** Flint accepts a passing result without a card only
  once you sign a rule that names that check exactly (`task.check_bar`). A rule
  over all task actions doesn't cover it. Even then Flint accepts at most 20 a
  day on its own, and a result past that comes to you on a card. The database's
  own check is coarser: once such a rule exists it lets Flint accept for every
  asset alike, with no limit. The by-name rule and the daily limit are held by
  the code.
- **Seven cards**, each carried out in one step with the database's own checks:
  turn an asset on, require reviews or stop requiring them, run a task on the
  local model, watch a CI run, accept a result, cancel a task that has gone
  out, and overrule a check.
- **Your latest signature counts.** If you approve a card and then sign
  something newer about the same task or asset, the earlier card fails with
  "You signed something newer about this, so this card didn’t run." That holds
  even when the newer signature lands while the earlier card is running.
- **Only your own no ends a result that passed.** An accept card that fails,
  for any reason, is offered to you again. Turning one down, or letting it
  lapse, ends the task. Its line then reads "You didn’t accept its result."
- **Ending a task sets its other cards aside.** When your cancellation or your
  override runs, the task's other waiting cards, a review of it among them, are
  turned away with "You ended this task another way, so this card wasn’t
  needed."
- **Accept Anyway needs the result.** A task's raw output is deleted a week
  after it ended. After that the result can't be accepted any more, and the
  panel won't offer it.
- **A task's time.** A task with a due time is watched until then, however far
  off, and then ends with "It wasn’t finished by its due date." A task with no
  due time ends after a day without moving, with "It ran out of time."
- **The day's limits.** 50 watches and 20 local tasks can go out a day. A card
  that is refused doesn't use one of them.
- **A result that isn't one ends the task.** Whatever an asset hands back that
  isn't a result, a wait or a known failure ends the task with "Its result
  wasn’t usable." Nothing of it is kept.
- **A forgotten item stops its cards.** A card about something you had Flint
  forget doesn't run. It ends with a sentence and no result.
- **The forecast is scored a day after the task ended**, by the task tick,
  true if it was accepted and false if it was rejected or failed. It runs the
  way Flint's other prediction checks do, and a rule that forbids those stops
  it. A cancelled task's forecast is never scored. It's marked as run out once
  its date has passed.
- **Cleanup.** A task's spec, bar, summary and evidence are cleared 30 days
  after it ended, or 7 days for one that is personal, financial or read outside
  text. Its raw output is deleted 7 days after it ended. Its title stays, and
  its line then says its checks are no longer kept.
- **Health** has a Tasks row, under THIS MAC. It's shown as off while tasks
  are switched off or no asset that runs tasks is on. Otherwise it says when a
  task is stuck or a rule stops Flint from checking results.

There is no panel yet. The routes the panel will use exist, behind the same
token scope as approvals, so no model can read a task or start one:

| Route | What it does |
|---|---|
| `GET /v1/assets` | The assets, whether each is on, and whether reviews are required |
| `POST /v1/assets/:id/on` | Files the card that turns it on |
| `POST /v1/assets/:id/off` | Turns it off. No signature needed |
| `GET /v1/tasks?tab=active\|finished` | A tab of tasks |
| `GET /v1/tasks/:id` | One task |
| `POST /v1/tasks` | A new task and its card |
| `POST /v1/tasks/:id/cancel` | Cancels it, or files the card to cancel one that has gone out |
| `POST /v1/tasks/:id/accept` and `/reject` | Files the card that overrules its check |

While tasks are switched off, every one of these answers "Tasks are turned off
on this Mac." and reads nothing.

Two things filed over `POST /v1/proposals` now get a sentence back instead of
an error: a spend card that says no cost, and a task or spend card whose
details hold a number that isn't whole.

Three more things hold whether or not Flint knows the card's name:

- From chat, no card about a task, an asset or a review is filed.
- No caller can claim such a card or report it done. The runtime carries out
  its own seven, and nothing carries out the others yet.
- The list of open predictions that chat reads leaves task forecasts out.

**Switching tasks on.** Part 2 ships off. No task job is scheduled, nothing
reads a task or an asset, the routes above say tasks are turned off, and Health
shows Tasks as off. To switch tasks on, set `FLINT_ASSETS=on`. Claude does that
once you say OK, with the lines below, which keep the override file `0600`, add
the setting only once and start it on a line of its own:

```bash
touch ~/.flint/runtime.override.env && chmod 600 ~/.flint/runtime.override.env
grep -q '^FLINT_ASSETS=' ~/.flint/runtime.override.env || printf '\nFLINT_ASSETS=on\n' >> ~/.flint/runtime.override.env
launchctl kickstart -k gui/$(id -u)/com.flint.runtime
```

Only `on` switches them on (any case, spaces around it ignored); anything else
is off. On is not enough for anything to run: each asset stays off until you
sign the card that turns it on.

**Switching tasks off** is the rollback. Remove the `FLINT_ASSETS` line from
`~/.flint/runtime.override.env` and run the `launchctl` line again. The task
jobs are no longer scheduled, no task or asset card is filed or run, and the
routes and Health say tasks are off. Nothing else is changed. An asset you
turned on is still on when tasks come back. A card you already approved stays
approved until then, or until it expires. A task that was out waits where it
was: the first tick after tasks are back on sends it again, or ends it if its
time is up. The nightly cleanup above still runs, so what has ended is still
cleared on time. Part 2 has no database update of its own.

### What changed on deploy

Nothing you use. Every card filed from now on records whether it needs a
review, and cards of the kinds listed above are marked. Nothing reads the mark
yet, and reviews aren't required, so every card is approved as before. Four
job queues exist and nothing sends to them. No plan has a Flint task step yet,
so the new rule on those steps holds nothing back.

Cards filed before this update stay unmarked. One of them could be approved
without a review even after reviews are required, until it expires, a week at
most after it was filed. No reviewer exists yet, so reviews can't be required
before then.

Three things are now refused when a card is filed that were accepted before: a
spend card with no estimate or an estimate of zero, a negative estimate on any
card, and a task or spend card whose args hold a number with a fraction.
Nothing files such a card today, and a card already on record is not held to
these rules, so it can still be approved, rejected or expire.

The time on each approval is now stamped by the database as the server records
it. The server sent none before, so nothing changes for it. Each approval or
signed rejection also records which asset, task or gate its card named
(`Approval.signedFor`, a new column, empty for every approval so far and for
every card that isn't one of these). A forget is now refused above READ
COMMITTED, the default level. Nothing calls it yet.

A card of any kind that breaks one of its own rules is now refused by name,
with its id and the rule. Before, only goal, plan and task cards were. The
rules themselves are the same.

### What the next parts must do

Part 2 does each of these for tasks and assets. The parts that add the local
model, reviews and the panel must hold to them too.

- **Cards.** A card that turns an asset on (`asset.enable`) or changes the
  review requirement (`review.enforce`) acts only if it's a `policy` card filed
  from the console or the CLI, untainted, with `consequential` set. A
  cancellation (`task.cancel`) and an override (`task.bar_override`) are `task`
  cards from the console or the CLI, never tainted: keep their args to ids,
  even for a task that read outside text. A dispatch and an acceptance
  (`task.check_bar`) are `task` cards from the console, the CLI or a runtime
  job, never from chat. Every one of them must expire within 7 days of your
  signature, and its digest must be its args' digest. `card-ttl.test.ts` must
  learn each new file that files a card. Every task and spend card's digest is
  checked when it is filed, so its args hold no number with a fraction. A spend
  card says an estimate above zero.
- **The later signature wins.** A card acts only if it's the latest one you
  signed about its asset, task or gate. If you've signed a later one, for it or
  against it, the earlier one is refused as "signed before a later decision",
  even when the later card failed or expired: ask for a new signature, don't
  retry. File and sign each card when it's wanted, not ahead of time. Commit a
  card before its signature is recorded: a signature recorded for a card that
  isn't on record yet acts on nothing, and doesn't stand in an earlier card's
  way. Write an asset's row before filing the card that turns it on: a card
  signed before the row was written, or before the asset was last turned off,
  doesn't turn it on.
- **The subject on the card.** What a signature is for is read from the card as
  the signature is recorded. Stamp the subject on the card itself as it's
  filed, so the order check can read the later card and no longer depends on
  the card being on record at that moment.
- **Filing.** A spend card needs an estimate above zero. The route that files
  cards must answer 400 with a sentence for one that has none. The database
  refuses it, which would otherwise surface as a 500.
- **What each card's args hold.** `asset.enable`: `assetId`, `kind`,
  `externalRef`, `name`, `capabilities`, `dispatchAction`, `spends`, `entityId`
  (null when it stands for no item), exactly as the asset's row has them. A dispatch: `taskId`, `assetId`, `assetKind`,
  `title`, `spec`, `acceptance`, `goalId`, `stepKey`, `dueAt`, `sensitivity`,
  `tainted`, `estCostMicros`, with `dueAt` as `Date#toISOString` writes it (or
  null) and money as whole micro-dollars. The card's own `sensitivity` and
  `tainted` must equal the task's. `task.cancel`: `taskId`. `task.check_bar`:
  `taskId`, `outputRef` (the task's own) and `metBar` (`true`), filed and
  signed after the result was handed in.
  `task.bar_override`: `taskId` and `to`. `review.enforce`: `gate` (`proposal`)
  and `enforced`.
- **Transactions.** Each signed change is written at READ COMMITTED, in the
  transaction that claims and completes its card. An approval is used by the
  first transaction that makes its change and by no other.
- **The dispatch** must write the task's forecast first (`assets`,
  `task_meets_bar`, created by `runtime:tasks`, resolver `auto_world`, with
  `resolverSpec` `{ taskId, rule: 'task_meets_bar' }`) and set it with the move
  to `queued`, in the same transaction. A forecast belongs to the one task it
  names. The rule is what keeps P4's sweep away from it: the sweep leaves alone
  a prediction whose rule it doesn't know, and would let one with no rule run
  out 72 hours past its date.
- **The check** must set `metBar` and `barCheckedBy` in one write while the task
  is `checking`, and write `barEvidence` then too. `outputSummary` is written
  as the result is handed in, or while it is `submitted`. Acceptance names an
  audit entry of kind `action`, outcome
  `ok`, action `task.check_bar` (or `task.bar_override`), correlated
  `task:<id>`. A failed task gives one of the classes the database knows
  (`unavailable`, `invalid`, `capped`, `timeout`, `asset_off`, `budget`,
  `expired`, `error`).
- **Promotion.** The database lets Flint accept on its own only while a live,
  unscoped policy row promotes `task.check_bar` (or `task.*`) and no live row
  holds it back. The runtime can't switch such a row off: only your signed
  card does (see "Your rules, and switching one off").
  That check is all or nothing: it knows no asset and no limit. The code is
  stricter, and a later part must keep it so: only a row that names
  `task.check_bar` exactly promotes it, and each acceptance Flint makes alone
  takes one of 20 places a day in the transaction that accepts.
- **Adapters.** The run reads what an adapter returns strictly: a result with
  its summary, a wait, or one of the failure classes above, and a result that
  is plain data. Anything else ends the task as `invalid`. Keep every file
  under `tasks/adapters` to type-only imports: the test reads each one, in any
  sub-directory, and its list of files is closed.
- **Money.** A dispatch that spends asks `reserve.take(cardId, micros)` before
  it writes anything. Make `take` idempotent by the card's id, and `release`
  of a key that holds nothing a no-op. A key is kept only for the card whose
  dispatch happened. The runtime calls `release(cardId)` whenever a run of the
  card ends and the card is known not to have sent its task out; for a task's
  other dispatch cards once it has gone out on one; and for all of a task's
  dispatch cards when it is withdrawn before it went out (its card lapsed, or
  you cancelled it). Pass `reserve` to the tick and to `cancelTask` as well as
  to the executor. When a run ends and it can't be told whether the card ran,
  nothing is released then, and the next of those three gives it back. One
  case is the keeper's own: a card whose item was forgotten and that never
  runs again. Let a key lapse once its card's expiry has passed.
- **Lock order.** A forget locks a task's cards by id, then the task. A card
  that writes to the task's other cards (a cancellation, an override) locks
  them with its own, by id, before the task (`lockCards`). Keep that order in
  anything else that sets a card aside.
- **Whose card counts.** Anything that asks whether a task or an asset has a
  card waiting, or had one turned down, reads only cards the executor would
  run: the check's own accept card, and cards filed from the console or the
  CLI (`ACCEPT_CARD`, `WILL_ORIGINS`). A card written under another origin
  never holds a real one back and is never your answer.
- **The Hive.** A Hive dispatch card names one pool, as a plain name, at the
  top of its args. Give its args a contract before anything carries one out.
- **Caps.** A dispatch takes its place under the day's cap after its writes,
  in the same transaction. Keep it last, so a refused card uses none.
- **Outputs** are written while the task is `dispatched` or `running`, and are
  always tainted. An output's digest is the database's own count over the body
  as it stores it: `encode(sha256(convert_to(body::text, 'UTF8')), 'hex')`.
  Compute it in the `INSERT` and read it back; any other digest is refused. A
  task's `outputRef` is `out:` and the first 12 or more characters of that
  digest. Write the output and hand the task in under that reference in one
  transaction: a task is checked, and accepted, only with that output on
  record. Retention may delete one, and clear a task's
  text (setting `textPurgedAt`), only once the task has ended. After that an
  override can still reject the result, but can no longer accept it. A task
  whose text was cleared takes no output and no review.
- **After a forget.** Call `forget_entity` at READ COMMITTED. A card of a
  forgotten task that is still running must finish with no result (the
  database refuses one; it can still fail with its reason). Don't file a new
  task or card that names a forgotten item: nothing here refuses that. A
  forgotten task's forecast loses its rule with its words, so P4's sweep lets
  it run out.
- **Clean text before it is written.** Postgres refuses JSON that holds a NUL
  or a lone surrogate before any rule here runs, and its own log then keeps
  about 40 characters of the value. Strip both from a model's output, a spec
  and a card's args before any write.
- **A task's title is kept for good.** Keep it to template text, with none of
  your words in it.
- **Reviews** must be written, and attached to the card, in one transaction
  while the card is still pending, with the card's own digest, at least its
  taint and exactly its sensitivity. A review of a task's output is written
  while the task is `checking`, by the output's digest, and is always tainted.
  Only `attack`, `defense` and `verdictReason` can ever be cleared, so `findings`
  and `reasonCodes` must hold codes and `models` names, never words. A review
  is written only while a local reviewer is on. Clear a card's review no later
  than its args: a forget finds a card by its args, so a review left behind
  after them keeps its words.
- **Signing with reviews required.** The server must put `reviewId` and
  `verdict` in the signed payload's `fields`.
- **Scoring.** A task's forecast is recorded as `auto_world`, by one writer,
  at READ COMMITTED. The database takes the score only a day or more after the
  task ended as accepted, rejected or failed, with an outcome that says whether
  it was accepted. A cancelled task's forecast is left to expire, and the task
  tick must expire it: P4's sweep leaves a task's forecast alone. P4's rule on
  results recorded as yours is unchanged, so your accept or override card does
  not score the forecast itself. "Was the reviewer right" has to go through a
  question, which can be asked only once the forecast is due.
- **Steps.** When you reject a result that was accepted, the database moves the
  step back to blocked. The goal's progress is the runtime's to work out again.

### Known limits

- **What holds against a runtime that breaks the rules.** The rules bound to
  your signature hold even then: which assets are on, which task runs, whether
  reviews are required, and the one use of each approval. What the runtime
  writes itself, the database can only check for shape: whether a check was
  honest (which is why accepting waits for you until you promote it), what a
  review found, how good a forecast is, what a paid task cost, who asked for a
  task, and which items it lists.
- **A reviewer that can't answer.** With reviews required and the reviewer
  down, cards that need a review wait. That includes a card to turn another
  asset on. The way out is the card that stops requiring reviews.
- **What an output says is the runtime's.** The database checks that an
  output's digest is the digest of its body, and that a review of the output
  names it. It can't check that the body is what the asset really returned.
- **Errors and Postgres's own log.** As for P4: the id-only rule covers the
  `INSERT` and `UPDATE` statements the runtime makes, not `COPY` or a Postgres
  set to log every statement's values. One more limit: JSON that Postgres
  can't store at all (a NUL, a lone surrogate) is refused before any rule here
  runs. The runtime's own logger drops that error's text, but Postgres's log
  keeps about 40 characters of the value at its default settings.
- **A row that holds acceptance back.** Flint accepts on its own only while no
  live policy row holds that back. Such a row is a brake you set, and it holds
  against the runtime too: the database refuses the runtime's attempt to
  switch it off, and it ends only on a card you sign (see "Your rules, and
  switching one off").
- **Never chat, against bugs.** A card's origin is a column the runtime writes.
  "Never from chat" holds against a mistake in the runtime, not against a
  runtime that lies about where a card came from.
- **When you signed.** The order rules compare when each approval was recorded.
  The database stamps that time, and what the card was about, as the server
  records the approval, so neither the server nor the runtime can change either.
  It's the time the server recorded your signature, not the moment you touched
  the key. Two approvals recorded in the same millisecond are ordered by their
  ids.
- **A later card that didn't run.** If the later of two cards about the same
  thing fails or expires, the earlier one still doesn't act. You sign again.
- **Signing waits for a change to the card table.** Recording a signature now
  reads its card. A database update that changes the card table and is held
  open, such as one queued behind the nightly dump, delays a signature until
  it's done.
- **What a forget leaves.** A task's title and a review's finding codes are
  kept, which is why both must hold no words of yours. A task or card filed
  after the forget that names the forgotten item isn't refused.
- **A transaction held open.** A signed card acts in one transaction. A runtime
  that kept that transaction open could delay when its changes land. A restart
  of the runtime ends it.

### Rolling P5 back

The migration's `down.sql` (`20261014000100_p5_assets`) belongs to a rollback:

1. First deploy a runtime from before P5. P5's job bus expects the four queues
   that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. Assets, tasks and their outputs,
   reviews and the review requirement go with it. Every card stays, without its
   review or its mark. Task forecasts stay in the ledger. A plan step that is a
   Flint task goes back to being held by the console alone.

`down.sql` refuses to run while a task, asset or review card is approved or
running. The record of which approvals were used goes with the rollback, so
such a card could otherwise act a second time later. Let each one finish, fail
or expire (a week at most), then run it again.

A task or asset card still waiting expires on its own. One you approve while P5
is rolled back isn't carried out ("not carried out by the runtime") and stays
approved. Any later deploy of P5 code applies the migration again. Claude runs
`down.sql` only with your OK, after the dump.

### Follow-ups

- A restore from a backup brings assets and the review requirement back as the
  backup had them. An asset you turned off since would be on again, and reviews
  you required since would no longer be required. The restore carries forward
  keys, promotions and triage rules you took away, and doesn't know these two
  yet. It should carry both forward the same way, since both only take power
  away: an asset that is off in the database being replaced stays off in the
  restored copy, and reviews that are required there stay required. It already
  fails every approved or running card, so no task or asset card acts twice.
  A task that was out when the backup was taken comes back still out, and the
  task tick ends it within a day. Until the restore learns the two switches,
  check Settings after a restore. Only the CI Watcher exists today.
- A card you approve is refused if you've signed something newer about the same
  task or asset. For a card you asked for, the sentence tells you to ask again.
  The panel should offer that in one click.
- The runtime can create a large object, and one it owns makes the backup's
  dump fail. That predates P5 and needs its own fix.

## Your rules, and switching one off

A rule is a row you signed on a policy card. It does one of two things. It
lets Flint do something on its own (the promotion tables file these). Or it
holds something back: Flint asks you each time, or may not do it at all. A
rule that holds back wins over one that lets go, so it works as a brake under
a wider rule: goals from chat ask you each time, while everything else about
goals runs on its own.

This lists the rules that are switched on, each as a sentence under its id:

```bash
cd ~/flint && pnpm --silent --filter @flint/runtime rules
```

To switch one off, give its id (or several):

```bash
cd ~/flint && pnpm --silent --filter @flint/runtime rules --off <id>
```

That files a card, **Switch Off 1 Rule**. Sign it in Approvals. Nothing
changes until you do, and the card waits 7 days. It asks on its own, with its
own touch, and is never part of Approve All. Show Details says each rule that
ends as a sentence, with its id under References. A rule that is switched off
stays off: to have it again, sign a new one.

### What the database holds

Until this update the runtime could switch off any rule by itself, a brake
included. Two reviews found that, and it was listed under P3's and P5's
limits. Now the database decides
(`20261015000200_policy_off_guard`, a guard on the policy table), for every
role but the migration owner:

- **A rule that holds something back goes off only on your signed card.** The
  card is a policy change from the console or the command line, with nothing
  untrusted in it, marked for your own touch, signed under a key that is still
  live, being carried out now and not expired. Its stored words are the words
  you signed (the database computes their digest again), and they name the
  rule by its id, what it covers and what it does. A card for one rule
  switches off no other.
- **The runtime may itself switch off a rule that lets Flint act on its
  own.** That only takes power away: the action goes back to asking you.
  There is one exception. When two such rules cover the same action, the
  lower daily limit is the one in force. So a rule with a limit also goes off
  only on your card while another rule that is on could run the same action
  under a higher limit, or none.

Why that rule and no other: this is how the tier engine reads the rows
(`@flint/policy`, `resolveTier`). Of the rules that match an action, the
strictest wins. An action runs on its own only when every rule that matches
it lets it, and then under the lowest daily limit among them and the code's
own. So switching off a rule that lets go either sends the action back to
asking or changes nothing, unless that rule carried the lowest limit.

A test proves it against the engine itself
(`test/policy-off-guard-db.test.ts`). Over every table of up to three rules
about one action and its family (for three such families), 4,000 random
tables, and 150 more put to the database row by row as the runtime's own
role: no rule the runtime may switch off makes any action less restricted, in
any context, whatever the clock says. The same test shows that two simpler
rules fail: "any rule" loosens a tier, and "any rule that lets go" loosens a
limit.

What the next parts must know:

- **The guard reads wider than the engine.** It counts another rule whether
  or not that rule has ended, and whatever its scope. It doesn't read the
  rule's own end either: a brake that has ended still goes off only on your
  card. So it sometimes asks for your card where none was needed. It never
  lets through a switch-off that loosens.
- **A switch-off runs at READ COMMITTED**, which every writer in the runtime
  uses. Above it a transaction reads the database as it was when it began: a
  rule signed since, a card that has since ended, a key since revoked. So the
  database refuses any switch-off there, as the goal and task guards refuse
  their writes.
- **`policy.change` takes `rows` or `off`, never both.** `off` is a list of
  `{ id, pattern, tier }`. A switch-off is filed only as your own untainted
  policy card (the `rules` command files it), and only for rules that are
  there, on, and as written.
- **A refusal is one sentence, once.** If the database refuses a signed
  switch-off (the key was revoked or the card expired while it ran), the card
  fails with "The database refused to switch it off, so it's still on. File
  it again and sign it." The failure is in the audit trail, every rule the
  card named is as it was, and nothing tries again.
- **Nothing in the runtime switches a rule off on its own today.** A later
  part that takes a promotion back after a failure can, for a rule that lets
  go, with no card. It must run at READ COMMITTED and treat SQLSTATE 42501 as
  "this one needs a card", never as something to retry.
- **Errors name the rule's id only**, and only one shaped as an id.

### What changed on deploy

- One database update, `20261015000200_policy_off_guard`: one trigger and its
  function on the policy table. No table, no column, no grant, and no row is
  touched. Rules that are on stay on, rules that were switched off stay off,
  and every rule is held to the guard from then on, whenever it was signed.
- The `rules` command, and the console's card for a switch-off.
- A restore that one of your rules forbids now names the `rules` command.
  It used to point at a control the console never had.

### Known limits

- **A restore switches rules off without a card.** `restore-production` runs
  as the migration owner, which the guard doesn't hold. It switches off a rule
  you had switched off after the backup, and any rule your signature no
  longer covers (a revoked key, a card that doesn't verify). For a rule that
  holds something back, that takes a brake away. Its summary says how many
  stayed off, and names each rule your signature no longer covers so you can
  sign it again.
- **A limit holds against the rules that are there.** While a rule with a
  limit is the only one for its action, the runtime may switch it off. A wider
  rule you sign afterwards then runs under its own limit. Put the limit you
  want on the rule you sign.
- **Stricter than it has to be.** With three rules that let go over one
  action, the middle limit could go safely and is still refused.
- **Ended rules stay listed** until you switch them off. They hold nothing.
- **The migration owner isn't held to it**, as with the other guards: a
  repair by hand can switch any rule off.

### Rolling it back

The migration's `down.sql` takes the trigger and its function away and loses
nothing: no table, no row. It needs no older runtime, and a switch-off card
still works. After it the runtime can again switch off any rule by itself, so
a brake is only as good as the runtime, as before. Any later deploy applies
the migration again. Claude runs `down.sql` only with your OK, after the
dump.

## Health sees the whole machine (P7)

Settings > Health used to cover the runtime's own parts. It now covers the Mac
Flint runs on too. Nothing here changes anything on the Mac: the checks only
read. They run inside the existing health job, every 5 minutes.

Health lists its rows under four headers, MODELS, BACKUPS, THIS MAC and REMOTE
ACCESS. What needs a look is still listed first.

| Row | What it reads | Needs a look when |
|---|---|---|
| **Disk Space** | Free space on the volume your home folder is on. | Under 20 GB free is low. Under 5 GB is nearly full, and you get a note. |
| **Remote Access** | Flint's own Tailscale service on this Mac, asked over its socket. | It is stopped, signed out, offline, or not pointed at Flint. Its sign-in running out is said 14 days ahead. |
| **Local Model** | Ollama's own list of installed and loaded models, on this Mac's address only. | Ollama answers and the model Flint asks is not installed, or the list says it runs somewhere else ("isn't on this Mac": a cloud model, whatever it is named). |
| **Standby Model** | The same list. | The server's settings name a standby model and it is not installed, or the list says it runs somewhere else. There is no row when they name none. |
| **Files Backup** | The record the nightly files backup writes for each archive. | The last run failed, or the last good archive is over 26 hours old. |
| **Offsite Backup** | The same record, beside the database's own. | Either copy, the database's or the files', did not go offsite. |
| **Offsite Restore Test** | The MacBook's own test of an offsite copy. | Off until the MacBook reports a first result. Then a failure, or over 8 days without one. |
| **Automatic Updates** | When the deploy job last looked for an update. | No look in an hour, or updates are paused. |
| **Database** | Whether it holds a large object. | It holds one. Flint keeps nothing in them, and no backup includes one. |
| **Backups** | The database's nightly backup, as before. | Now also as soon as a run fails, not only once the last good one is old. |

A reading that is missing, cut short or not the shape expected is **Unknown**,
never Normal.

**What it runs and asks.** Remote Access runs one program, `tailscale`, by its
full path from a fixed list, with fixed arguments, nothing of the runtime's
environment and a five-second limit. Nothing it prints is passed on: only a
state, a reason from a fixed list, and the day the sign-in runs out. The models
are asked of Ollama on this Mac's own address, and only for its two lists. No
call leaves the Mac.

**Notes.** One note each, once per occurrence, through the existing triage
rules:

- This Mac Is Nearly Full: under 5 GB free. Critical, once a day while it lasts.
- No Backup Has Reached iCloud in 3 Days: once per last good copy, and only
  once your backup key is on this Mac.
- Remote Access Expires in 12 Days: at 14 days, and once more in the last 3.
- Remote Access Is Down: after 30 minutes down, once per outage.
- Flint Stopped Checking for Updates: after 3 hours with no look, unless
  updates are paused.
- Your MacBook Hasn't Tested a Backup in 5 Weeks: once per last test.

A nightly job that stops before its first question to the database is answered
(the database is down) now tells you, once a night. Before, it ended in a log
line.

### The files backup's record

The nightly archive of Flint's files is made by a shell script with no database
(`apps/studio/backup_flint.sh`). It now writes one line for each archive it
made or could not make, here and offsite, in `~/.flint/backup-events.jsonl`. A
line holds ids, enums, numbers and hashes, never a path. The health job reads
those lines into the list of backups. Reading the same lines again writes
nothing: there is one record for each backup file, and a failure never takes
the place of a good record.

That script also checks for room before it writes, and records a run that was
stopped. It can catch up a night that was missed, when you log in. That is
off. To turn it on:

1. Add this line to `~/.flint/backup.env`:

   ```
   FLINT_BACKUP_CATCHUP=on
   ```

2. Load its LaunchAgent, once. A deploy does not load it. A rebuild does.

   ```
   cp ~/flint/apps/studio/com.flint.backup-catchup.plist ~/Library/LaunchAgents/
   ```

   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flint.backup-catchup.plist
   ```

It runs once when it is loaded and at each login. It makes a backup only when
the newest one is over 26 hours old.

### Removing old backups

Before a deploy changes the database it takes a copy of it, in
`~/FlintBackups/pre-migrate`. Nothing ever removed those. `prune-backups` does:

```
pnpm --filter @flint/runtime prune-backups
```

It lists what would go, by count and size, and removes nothing. Add `--remove`
to remove them (nothing else means "remove": any other word after the command
is refused). It keeps the newest 10, anything under 30 days old, and always the
copy taken before the version that is running. When it cannot tell which
version is running, it removes nothing. A rule of yours that forbids
`backup.prune` forbids `--remove` too.

The nightly job runs it last, as the action `backup.prune`, which ships at
APPROVAL. On a night there is something to remove it files one card, Remove Old
Backups. The card says how many copies would go and how much room that frees,
and that it can't be undone, so it asks on its own and Approve All skips it.

The card signs those copies and no others. It carries their count, their
megabytes and a digest of their names, sizes and times; the list itself is kept
in `~/.flint/prune-plans`, and is believed only when it gives that digest. A
run on the card removes the copies on its list that are still the same files
and that the rule still lets go: never one that was not on it, and never more
room than the card said. If the folder changed so that none of them may go, or
the list cannot be believed, it removes nothing, and the next night's run files
a new card.

A promotion signed for the backups as a group does not cover it. To let it run
on its own, sign a rule that names it. Nothing said in chat can ask for it.

Every run looks again just before it removes each copy: the folder must be the
folder it listed, and the copy the file it saw, with the same size and time, or
it is left. The audit trail says a run is starting before anything goes, and
what it did after; if the first cannot be written, nothing is removed.

The encrypted copies offsite and the nightly dumps are kept to their own limits
by their own jobs, as before.

To see what takes room on the Mac, and to remove old logs and old runtime
versions, see entry 6 of [docs/RECOVERY.md](../../docs/RECOVERY.md).

### What changed on deploy

- One database update, `20261015000000_p7_resilience`: one record for each
  backup file (a unique index), and a backup kind named for a host Nexus has
  left is renamed. No new table, column or queue. If a file was recorded more
  than once (the offsite step used to write a new record each time the same
  dump was sent again), the update keeps one record of it, a good one before a
  failed one and then the newest, and removes the others. It cannot stop on
  them. No backup file is touched.
- The nightly jobs record a backup the same way whether or not that update has
  been applied yet. They run from the checkout as soon as it is updated, which
  can be before the runtime's own deploy.
- Every dump of the database is taken without large objects. Flint keeps
  nothing in them, and one that the backup role could not read would have
  stopped every later backup.
- The deploy job leaves the time of each look for an update in
  `~/.flint/deploy-tick`.
- A LaunchAgent file, `com.flint.backup-catchup`, comes with the code. A deploy
  does not load it (the steps are above). Loaded, it does nothing unless the
  catch-up is on.
- The nightly job gains its last step, `prune-backups --auto`. It files no card on a
  night there is nothing to remove. The list of copies a card signs is kept in
  `~/.flint/prune-plans`, a folder it makes for you alone, and is removed once
  no card that could still run names it.

### Known limits

- Offsite Restore Test stays off: nothing on the MacBook reports a result yet.
- Standby Model has a row only when the server's settings name one. When they
  name none, the server picks a standby for this Mac by itself and Health does
  not say which.
- Remote Access reads Flint's own Tailscale service. It cannot tell whether
  your phone itself is signed in.
- The files backup's record names the default folders. A folder set by hand
  for one run of the script is not known to the runtime.
- A failed `prune-backups` is in its log and the audit trail. It posts no note, and
  tries again the next night.

### Rolling P7 back

The migration's `down.sql` (`20261015000000_p7_resilience`) belongs to a
rollback:

1. First deploy a runtime from before P7. P7's nightly jobs write one record
   for each backup file and rely on the index that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. Every record stays, and the
   renamed kind gets its earlier name back. A second record of one file that
   the update removed is not brought back.

Any later deploy of P7 code applies the migration again. Claude runs `down.sql`
only with your OK, after the dump.

## Nexus is backed up and tested (P7)

Nexus runs on this Mac and keeps its database on the same Postgres server as
Flint. Flint can now back that database up the way it backs up its own: a
dump every night, an encrypted copy offsite, and a weekly test that restores
the dump and compares it.

It ships off. Until you switch it on nothing of it runs, nothing of Nexus is
read, and Settings > Health shows Nexus Backup as Off.

What Flint does and does not do to Nexus:

- Flint only reads Nexus, and it reads through a login that has no right to
  change Nexus's tables: Flint's own backup login. Before each dump Flint looks
  that login's rights up, through every role it belongs to. If it holds any
  right to change the database, it is refused and nothing is backed up.
- It never stops, restarts or reconfigures Nexus, its database or its logins.
- The weekly test restores into a scratch database, `nexus_restore_test`, and
  drops it. It never opens the Nexus database.
- Nothing about Nexus can hold up Flint's own night. Nexus's steps run after
  every one of Flint's own, and each ends within an hour whatever happens.
- The dump is a file only you can read. It leaves this Mac only encrypted to
  your backup key. No model ever reads it.
- Nexus's own backup job is not touched. It still runs.
- Flint cannot put a Nexus backup back yet. See Known limits.

### Switching it on

Run these once, in Terminal on the Studio.

1. Let Flint's backup login into the Nexus database:

   ```
   psql -d postgres -c 'GRANT CONNECT ON DATABASE nexus TO flint_backup'
   ```

   This grants one thing: that login may connect to Nexus. It can already read
   every table on this Mac's Postgres, from Flint's own setup, and holds no
   right to write one. Today any login may connect to Nexus, so this changes
   nothing yet. It keeps the backup working when Nexus closes its database to
   other logins.

2. Switch the backup on:

   ```
   cd ~/flint && pnpm --filter @flint/runtime nexus-setup
   ```

   It works the address out from Flint's own backup address: the same login
   and password, with the Nexus database's name. Before it saves anything it
   opens Nexus once with that login, to see that the login is let in and holds
   no right to change the database. Then it writes one line,
   `FLINT_NEXUS_BACKUP_URL`, into `~/.flint/backup.env`. It never shows the
   address. If the Nexus database has another name, add `--database <name>`.

3. Take a first backup and test it:

   ```
   cd ~/flint && pnpm --filter @flint/runtime nexus-backup
   cd ~/flint && pnpm --filter @flint/runtime nexus-drill
   ```

   Run by hand they are you, so they need no card. With your backup key on
   this Mac, `nexus-offsite` sends the encrypted copy the same way.

If the backup says Flint's backup login is not let in, it prints the two
commands that fix it. The second, `GRANT pg_read_all_data TO flint_backup`,
lets that login read every table, view and sequence and gives it no right to
change one. Flint's own setup already gave it; the command is there in case it
was taken away.

Run `nexus-setup` again after Flint's database passwords are changed, and
after a rebuild. The address holds a password, so no backup carries it.

### What the login check covers

Before every dump, and in `nexus-setup`, Flint asks Postgres what the login
may do, for the login itself and for every role it is a member of (also one it
could only switch to, or only hand to itself). It is refused if any of them:

- is a superuser, may pass row security, may make roles or may replicate;
- belongs to one of Postgres's own roles that is not read-only;
- owns the database, a schema, a table, a view, a sequence, a function, a
  type, or anything else in it;
- may make schemas in the database, or things in a schema;
- holds any right on a table but reading it: adding, changing or removing
  rows, emptying it, referencing it, hanging a trigger on it or maintaining
  it, on the whole table or on one column;
- may advance a sequence;
- owns or may use a foreign server or a foreign data wrapper;
- owns a large object or may change one;
- may hand any right of its own on to another login, reading included.

Rights given to everyone count as the login's own. Such a right is not the
login's to give up, so Flint says it differently: Nexus gives every login that
right, and the change is on Nexus's side. A database carried over from before
Postgres 15 is the usual case, where every login may make things in the
`public` schema. Until Nexus takes the right back from everyone, Flint backs
nothing up there.

What no check of rights can rule out, because Postgres gives it to every
login that may connect: a read-only login can still call a function Nexus
opened to everyone (one that runs with its owner's rights could then write),
make temporary tables, make a large object of its own, send a notification
with `NOTIFY`, and takes ordinary read locks while it dumps. Flint calls no
function of Nexus's, makes no table or large object there and sends no
notification. The read locks are why the dump gives up after 15 seconds if
something in Nexus holds a table locked, and tries again the next night.

### What runs each night

The 02:15 job runs Nexus's three steps after every one of Flint's own (its
backup, its offsite copy, its Sunday restore test and its cleanup), and only
while the address is set:

| Step | Action | Card | Cap |
|---|---|---|---|
| The dump, into `~/FlintBackups/nexus` (14 kept) | `backup.nexus` | Run Tonight's Nexus Backup | 1 a day |
| The encrypted copy, into iCloud Drive's `FlintBackups/nexus` (7 kept), only with your backup key here | `backup.nexus.offsite` | Run Tonight's Nexus Offsite Copy | 1 a day |
| The restore test, on Sundays | `restore.drill.nexus` | Run This Week's Nexus Restore Test | 1 a week |

- Each ships at APPROVAL: it files a card and waits for you. To let one run on
  its own, sign a rule that names it. A rule you signed for the backups as a
  group does not cover these. Nothing said in chat can ask for them.
- Each dump has its row counts and a fingerprint sealed with this Mac's key
  beside it, taken in the same snapshot. Large objects are left out, as in
  Flint's own dumps.
- The offsite copy is never written in plaintext: with no key there is no
  copy. Its row counts go with it, encrypted, and are removed with it.
- Each file is recorded once, under the kind `nexus_dump`. A file written
  again is the same record.
- With `FLINT_OFFSITE_DIR` set, the copies go into a `nexus` folder inside it.
- Each step ends within 60 minutes, whatever its parts add up to. Inside a
  step every limit is per tool and per statement: 20 minutes for one run of
  `pg_dump` and for each statement before it (the check of the login, each
  table's count), 20 for each run of `age` (the dump, then its row counts),
  30 for one run of `pg_restore` and for each statement of the comparison.
  Each part gets its own limit or what is left of the hour, whichever is
  less.
- Past a limit the tool is stopped along with anything it started, the step
  fails at that moment, and nothing half-written is left. The dump also gives
  up after 15 seconds waiting on a lock someone holds in Nexus.
- Only one Nexus restore test runs at a time. A second one waits up to two
  minutes for the first, then says so and ends. A scratch database an earlier
  test left behind is replaced, with any session still on it.
- If Nexus ever holds large objects, the backup says how many it left out.
- If the address cannot be used (it does not name a database on this Mac, or
  it names Flint's own), none of the three steps runs and none files a card.
  The command says why, and Nexus Backup in Health says the address needs
  fixing.

Settings > Health has one row, Nexus Backup, under BACKUPS. It says the worst
of three things: the dump (none yet, failed, or its age), its offsite copy
(only with your key here), and its test (failed, or over eight days old).
Restore Test and Backups stay Flint's own database's.

You get a note when one of the three jobs fails (Nexus Backup Failed, Nexus
Offsite Backup Failed, Nexus Restore Test Failed), and a critical one, Nexus
Backups Have Stopped, when the last good dump is over 36 hours old.

### Switching it off

Take the line out, and keep the file yours alone:

```
sed -i '' -E '/^(export[[:space:]]+)?FLINT_NEXUS_BACKUP_URL=/d' ~/.flint/backup.env && chmod 600 ~/.flint/backup.env
```

The next night nothing of it runs and Health shows Off. A line left with
nothing after the `=` is off too. The dumps already taken stay where they are.

### What changed on deploy

- No database update. The records use a kind the P7 update already allows.
- Four commands: `nexus-setup`, `nexus-backup`, `nexus-offsite`,
  `nexus-drill`. The last three do nothing until the address is set.
- One setting, `FLINT_NEXUS_BACKUP_URL`, in `~/.flint/backup.env`. It is listed
  in `apps/studio/settings.manifest` as one a rebuild leaves to you.
- Settings > Health gains the row Nexus Backup. It reads Off.
- Restore Test and the note The Last Restore Test Failed now read only the
  tests of Flint's own database. They did before too, because there were no
  others.

### Known limits

- Flint cannot restore Nexus. What exists is the dump, its encrypted copy and
  the weekly test. Putting a dump back into Nexus is a later part.
- The login check looks at rights. It does not make Nexus unchangeable: see
  What the login check covers.
- The test compares the row count of every table in `public`, which is the
  only schema Nexus's own updates make. A table in another schema is dumped
  and restored but not counted.
- The test proves a dump restores and holds as many rows as were dumped. It
  does not compare what is in the rows.
- The address is set once and kept. If Nexus moves its database, or Flint's
  passwords change, the nightly job fails, says its setup needs fixing, and
  prints what to run.
- A failed Nexus restore test is a note from its own job and shows in Health.
  It does not raise The Last Restore Test Failed, which is Flint's own.
- While both run, Nexus's own backup job and this one each take a dump.

### Rolling it back

Switch it off (above). No database update needs undoing, and this runtime
reads the records of kind `nexus_dump` only for Nexus Backup's own row.

Going back to a runtime from before this part needs one more step, if any
Nexus restore test has run. That older runtime's Restore Test row and its note
The Last Restore Test Failed read the newest tested backup of any kind, so a
Nexus test would show there as Flint's own. Clear the Nexus tests first:

```
psql -d flint -c "UPDATE \"BackupRun\" SET \"restoreTestedAt\" = NULL, \"restoreOk\" = NULL, \"restoreDetail\" = NULL WHERE kind = 'nexus_dump'"
```

The dumps and their records stay.

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

## Putting the database back from a backup

What to type is in [docs/RECOVERY.md](../../docs/RECOVERY.md). This is how it works
(`src/backup/restore.ts`, `catalog.ts`, `carry.ts`).

- **`restore-production`** (Will runs it as `apps/studio/restore_database.sh`,
  which starts it directly so that nothing but its own sentences is printed)
  replaces the production database with a nightly dump. It is the action
  `restore.production`: APPROVAL in code for Will at the keyboard, never
  promotable, FORBIDDEN from chat and for Flint on its own, and refused when a
  policy row of Will's own forbids it (the command reads his rows from the
  database in use when it still can). It cannot wait on an approval card (the
  cards live in the database it replaces), so the approval is Will at a
  terminal, typing `RESTORE`. There is no `--auto`.

  Asking at a terminal stops an accident: a script, a pipe or a job. It does not
  stop someone who sets out to answer for him, because a program can run the
  command under a pseudo-terminal and type the word. What such a caller could
  do is bounded by what the command itself refuses, below, not by the prompt.

  What it does, in order. Nothing in use is touched before step 9.
  1. One restore at a time (an advisory lock), and no update while it runs: it
     makes `~/.flint/deploy-hold` for as long as it runs, and refuses while the
     deploy job is installing one. If an earlier run was stopped part-way (the
     database is closed, or missing while a kept copy is there) it says exactly
     that, with the repair command.
  2. Checks the setup: the roles and their powers, who owns the database, that
     the saved passwords still sign in.
  3. Checks the dump before anything reads it: its name, that it is a plain
     file of Will's own that no one else can write, and its fingerprint against
     EVERY record of it: the file the nightly backup writes beside each dump
     (sealed with a key in `~/.flint/backup-fingerprint.key`, so that whoever
     can change a dump cannot simply write a new hash beside it) and the
     `BackupRun` row. A mismatch with any of them is a refusal. With no record
     at all nothing is restored unless Will adds `--without-fingerprint`.
  4. Restores into a database of its own, as `flint_restore`: a role that owns
     nothing else. The SQL in a backup file runs as that role, which cannot
     reach the production database.
  5. Compares the copy, object by object, with a database built from THIS
     checkout's own migrations (after checking, by checksum, that those are the
     migrations the backup records): every table and column, constraint, index,
     view, trigger (and whether it is switched on), every function's whole
     definition, rules, row policies, default privileges, every privilege on
     every object, and the full list of what the application roles may do. Any
     difference is a refusal that names the object. Row counts are compared
     with the counts taken in the dump's own snapshot.
  6. Hands the copy to `flint_owner`, applies any migration made since the
     backup, and compares again.
  7. Carries forward what Will took away after the backup, when the database in
     use can still be read: a revoked approval key stays revoked, a promotion or
     triage rule he switched off stays off, and a daily cap already used stays
     used. Every promotion and rule still in force is checked against his
     signature, under a key that is still live, and switched off if it fails.
     Unused approvals are marked used, approved cards that had not finished are
     marked failed, and queued jobs are closed, so nothing from before the
     backup acts after it.
  8. Shows Will what will be in force (the keys that can approve, what Flint
     may do on its own, what he must do again) and asks. Then takes a copy of
     the database as it is (`~/FlintBackups/pre-restore`).
  9. Stops the runtime, closes the production database to new connections,
     waits for the others to leave (saying who is still connected if they do
     not), and changes both names in ONE transaction. The database that was in
     use stays as `flint_damaged_<time>`, closed. Nothing is dropped, except
     kept databases and pre-restore copies from more than 14 days ago, which
     are listed before he confirms. The audit entry is written after the swap.

  If the swap fails or is interrupted (Ctrl-C, a closed window), what happens
  next is decided by reading the catalog: production is opened again under its
  name and the runtime started, or, when that cannot be confirmed, the copy is
  kept and the real state is printed with the commands that fix it. "Nothing
  was changed" is printed only when that was confirmed.
- **`restore-production --check`** is a trial run: steps 1 to 7 on the copy,
  which is then dropped. Nothing in use changes, and it says how long a real
  restore would take and what would be in force. It is recorded in the audit
  trail and in `~/.flint/restore-log.jsonl`, as is every attempt that fails.
- **`restore-production --compare`** reads the database in use and says every
  way it is not what this copy of the code builds, with no backup and without
  restoring anything. It is the comparison of step 5, taken from the database
  in use, so every difference is listed at once before one stops a restore.
  The database is read in sessions that refuse every write. One scratch
  database is built beside it and removed again, also when the command is
  interrupted; one that a run cut short by a power loss left behind is removed
  at the next start, and said. What it lists first would stop a restore, and
  its last sentence counts only that. What it says after that lives on the
  server and is in no backup (who owns what, the database's own rights and
  settings, the roles): a restore sets or carries those itself, so they stop
  nothing.
- **`restore-production --repair`** puts right what a run that was stopped
  part-way left: a closed database is opened, a missing one gets its newest
  kept copy back (Will confirms that one), copies that never went into use are
  removed, and the runtime is started.
- **`restore-empty --from-rebuild --dump <file> --sha256 <fingerprint>`** is the
  rebuild's step (`apps/studio/rebuild.sh`), and refuses to run without the
  rebuild's flag: the same path, into an empty database only. It asks no one,
  so its audit entry says the rebuild ran it, not Will.
- **`bootstrap-db --port <n>`** makes the five roles and the `flint` and
  `flint_test` databases on a rebuilt Mac (`src/backup/bootstrap.ts`). Every
  password is new, reaches the server only as a SCRAM verifier, and is written
  only to `~/.flint/secrets.env` and `backup.env`: staged first, then every
  role in one transaction, then the files take their names. It refuses a Mac
  that already has them.

Who may connect to the database, create a schema in it or make temporary
tables is in no backup: Postgres keeps that on the server. A restore gives its
copy exactly Flint's own setup for everyone and for Flint's three roles, and
carries over what any other role holds on the database in use (an addition of
your own, which it says by name). It takes away everything else. A backup's SQL
runs as the owner of its own copy and can give a right on that copy to any role
the server already has; that right is removed before the copy is compared, and
a restore checks once more, just before the swap, that no role holds a right on
the copy beyond those two lists.

### Rolling the public schema floor back

`20261013000150_public_schema_floor` takes everyone off the public schema and
off the database, and names Flint's three roles instead. Its `down.sql` gives
back what a database built before it had: everyone may connect and use the
public schema again.

Do not run that `down.sql` on the Studio. Its database was closed to everyone
by hand at first setup, long before this update existed, and the update changed
nothing there when it was applied. So on the Studio `down.sql` would not put
back what was there before the update ran. It would leave the database looser
than it has ever been. `rollback.sh` never runs a `down.sql` itself, and Claude
runs one only with your OK, after a dump.

One thing on the Studio is needed once, because its roles were made by hand
before this existed: the migration owner must be a member of the restoring
role. `restore-production --check` says so, with the command, if it is missing.

The tests for all of these run against a throwaway Postgres of their own
(`test/scratch-cluster.ts`), never against `flint` or `flint_test`.
