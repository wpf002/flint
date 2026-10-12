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
   across triage and reviews, and each waits while a chat turn is running. A
   review asks the model at most twice. If the model isn't there at all, the
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
a claim, and nothing outside the runtime files under a job's name.

### The P3 report

`cd ~/flint && pnpm --filter @flint/runtime p3-report` prints P3's eight exit
criteria, measured now. Each says pass, fail or null (not enough to measure
yet), with the numbers behind it:

1. active goals (3 are needed), and how many of their checks Flint reads itself;
2. reviews that ran over 24 hours late in the last 30 days, and goals that late
   now. Late is counted the way the panel and Settings > Health count it: the
   time a review waited while Flint was reviewing. A goal that was due while
   reviews were off, or the Mac was asleep, was waiting, not late. It also says
   how many ran over an hour late (the digest's count), which does not fail it.
   It passes after 30 days;
3. how long a watched item's change took to set off its review (10 minutes is
   the limit; a test proves the worst case, and this measures the real ones);
4. plan versions without a signed card behind them, and reviews that filed
   their small changes on more than one card (both must be 0). A card a review
   found still waiting, and kept, counts for the review that filed it;
5. started goals without your signed approval behind their latest change;
6. reviews without their goal's forecast in the ledger;
7. suggestions from chat without your own quoted words (a later part files
   suggestions; until then this is null);
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
| 1 review ran over 24 hours late | A scheduled review in those days had waited more than a day, while Flint was reviewing, when it ran. It ages out of the week. |
| 1 goal is over 24 hours past a review | A review is that late right now: Settings > Health shows **Goal Reviews** as down. |
| the local model has not answered a review yet | No review's plan stage got an answer. Check that `FLINT_TRIAGE_MODEL` is set and Ollama is running. |

The card's details say what the week measured, in numbers: "This week Flint
reviewed your goals 9 times, and none was late. The local model answered 7. It
would have suggested 5 changes." Late there is the digest's count: a review
that ran over an hour late. Under it, each rule the card signs is a sentence:
"Goal reviews may run on their own, up to 20 a day, until Apr 5, 2027." Every
rule card reads that way (the earlier tables' and the backups' too): its
details never show the stored rows. Filing it twice is the same card.

`--phase p3c` is a second, later table, for goals Flint suggests from your
chats (a later part builds those): it lets a suggestion land in Suggested
without asking, 3 a day at most, and needs 14 days of those cards first. A
suggested goal is never active until you start it with your signature.

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
- **Suggestions from chat (part 5)** must add their commitments row to the
  later promotion table (`P3C_PROMOTIONS`: a commitment from chat, 10 a day),
  and, in the console:
  - mark a suggested goal's words as Outside Text when the goal is tainted;
  - show the links and the sensitivity "Make It a Goal" signs, before it signs;
  - make Dismiss undoable, or ask first (a dismissed goal is final today);
  - give a suggested goal whose date has passed a way to start (today its card
    is refused until the date is changed, and a suggested goal can't be edited).
- **A later part** must add a way to forget a goal's words (a signed
  `goal.forget`). Goals, plans, steps and reviews have no forget path yet.

### Known limits

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
  inside data blocks, and nowhere else. A linked item is sent as a short ref and
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
  The rows are kept 30 days, so the report's oldest waits are counted from
  what is left of them.
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

## Predictions (P4)

Predictions arrive in parts. The first part was the store and what the
database guarantees about it. The second is Flint checking its own predictions
(see "Checking predictions" below). Nothing is forecast yet, and nothing here
changes what you see. Flint will forecast its own numbers on this Mac: no
series is sent anywhere, and no part of this calls an outside service.

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
   enforces it. Nothing files that card for you yet: the console's panel comes
   in a later part. Approvals already knows the card. It shows as Turn On
   Predictions and names each number it covers. It says when spending or
   calendar numbers are among them, and when the local model's second opinion
   is included. It always asks on its own, with a fresh touch.

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
   after Flint asked you about it, and never before it asked. Nothing asks
   yet (the questions come with the console's panel), so until then yours
   stay open.

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

**Settings > Health** has a row, **Prediction Checks**. It's Off until both
switches are on. It needs a look when no check has run in 3 hours, when the
database refused one of its writes, when a prediction has nothing Flint can
check it by, when no scores have been written two days after you turned
predictions on, or when the scores are over two days old. It's Down when no
check ran in 26 hours. A restart buys 70 minutes and no more: a runtime that
restarts every few hours and never checks still reads late, then Down. What
ran out is said beside what was checked, never as checked.

**Rolling it back:** turn `FLINT_PREDICT` off. The jobs are unscheduled at the
next start. Resolutions already written stay (a resolution is never deleted),
and each says in its evidence that the sweep wrote it. This part has no
database update of its own.

### What changed on deploy

Three things, and none changes anything you use:

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

- **The console's panel** must file the Turn On Predictions card from the
  console. The database acts on that card only if it carries `consequential`
  and is at least as sensitive as each number it lists, which the runtime sets
  when it files one.
- **A template only the runtime fills** goes in `RUNTIME_CLAIM_TEMPLATE_IDS`
  in `packages/policy/src/claims.ts`, which keeps it out of chat's. A goal
  review's `goal_on_track` and the forecaster's `series_range` are there. The
  ledger route takes `ChatPrediction` and nothing wider.
- **The forecaster's predictions** must carry the rule the sweep settles them
  by, in `resolverSpec`: `{seriesKey, at, op: 'range'}` for a range and
  `{seriesKey, at, op: 'above' | 'below', value}` for a question, where `at` is
  the first instant of the day or week the claim is about, the same instant its
  metric point is stored under. `resolveBy` should be when that number will be
  there (the next morning's run), since the sweep reads a prediction only once
  it's due.
- **The forecaster** must write each run and its predictions at READ COMMITTED
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
  stays as it was recorded.
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

The migration's `down.sql` (`20261013000000_p4_forecasts`) belongs to a rollback:

1. First deploy a runtime from before P4, with `FLINT_PREDICT` off. P4's job bus
   expects the six prediction queues that `down.sql` drops.
2. Then take a dump and run `down.sql` by hand. Forecast runs, which numbers
   were on, and your questions and answers go with it. So do the scores only P4
   keeps (range scores and the finer measures), which a later snapshot
   recomputes. Every prediction and resolution stays, and so does each yes/no
   score; a forecast's predictions lose their range and their link to the run.
   The four safeguards on goal cards go back to how P3 had them.

A Turn On Predictions card still waiting expires on its own. One you approve
while P4 is rolled back isn't carried out ("not carried out by the runtime")
and stays approved. Any later deploy of P4 code applies the migration again.
Claude runs `down.sql` only with your OK, after the dump.

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

One thing on the Studio is needed once, because its roles were made by hand
before this existed: the migration owner must be a member of the restoring
role. `restore-production --check` says so, with the command, if it is missing.

The tests for all of these run against a throwaway Postgres of their own
(`test/scratch-cluster.ts`), never against `flint` or `flint_test`.
