# Flint Calendar

Flint Calendar is a small helper that lets Flint read your Apple Calendar. It
runs quietly in the background on this Mac, with no Dock icon, and keeps
working when you quit Flint. It reads the next two weeks of the calendars you
choose, every 5 minutes and whenever one changes, and it never changes an
event. No Apple password is stored anywhere.

## Connect it (once, about 3 minutes)

1. Open Terminal: press Cmd-Space, type Terminal, and press Return. Paste this
   and press Return:

   ```
   ~/flint/apps/desktop-calendar/connect.sh
   ```

   It checks that Flint Calendar is installed, then opens it.
2. macOS asks whether "Flint Calendar" may have full access to your calendar.
   Click **Allow Full Access**. macOS has no read-only choice; Flint Calendar is
   built so that it can't change events.
3. The Flint Calendar window lists your calendars:
   - under ICLOUD and ON MY MAC, every calendar is ticked;
   - under SUBSCRIBED and OTHER ACCOUNTS, none is ticked;
   - Birthdays isn't shown.

   Untick anything Flint shouldn't read, then click **Connect**. It checks that
   it can read its token (the one file it may read outside its sandbox), then
   says "Apple Calendar Is Connected". Click **OK**.
4. Terminal carries on by itself. It turns the source on, restarts Flint's
   runtime, starts Flint Calendar in the background and files a card. macOS
   shows a "Background Items Added" notice for Flint Calendar (it may say "Flint
   Dev"). That's expected: it's the part that keeps reading while Flint is
   closed.
5. In Flint, click the shield button at the top (Approvals). Find the card
   "Turn On the Apple Calendar Source", click **Approve**, and confirm with
   Touch ID or your Mac password.
6. About 5 minutes later, run this in Terminal:

   ```
   cd ~/flint && pnpm --filter @flint/runtime apple-calendar
   ```

   It prints one line, such as "Connected · Last Read 2 Min Ago · 23 Events".
   It shows counts, never titles.

If you click Cancel or Don't Allow, nothing changes, and you can run
`connect.sh` again whenever you like. If Flint Calendar is turned off under
Login Items, `connect.sh` says so before it opens anything.

## Your controls

- **Change which calendars count:** open Flint Calendar from Applications, or
  run `connect.sh` again (once the source is on, it files no new card). A
  calendar you add later counts if it is in iCloud or On My Mac. Your choice is
  kept by each calendar's account and name too, so a calendar that comes back
  with a new identity after a full sync (signing out of iCloud and back in)
  keeps it.
- **Pause reading:** System Settings > Privacy & Security > Calendars, then turn
  Flint Calendar off. Flint says "Calendar Access Is Off" and keeps what it
  already knows. Turn it back on to resume.
- **Stop the background part:** System Settings > General > Login Items &
  Extensions > Allow in the Background, then turn Flint Calendar off.
- **Disconnect completely:**

  ```
  ~/flint/apps/desktop-calendar/disconnect.sh
  ```

  It stops Flint Calendar (and checks that it stopped), archives your Apple
  events in Flint, and turns the source off. If Flint's runtime is down or
  restarting, it keeps trying for a minute; if Flint still can't be told, the
  source stays on and it asks you to run it again in a few minutes. Add
  `--uninstall` to remove the app as well. To remove the calendar permission
  too, run `tccutil reset Calendar com.flint.calendar`.

## What it reads, and what reaches Flint

- It reads only the calendars you ticked, from now to 14 days ahead, from this
  Mac's own copy of your calendar.
- For each event, Flint gets the time, the title, your answer (organizer,
  accepted, maybe, declined, or not answered) and whether it repeats.
- Who else is invited goes to Flint only for events you organized or accepted,
  never their answers, and never you.
- It never reads notes, locations, links, alarms or attachments. Calendar
  names stay on this Mac; Flint gets only how many you chose and a digest of
  which.
- It sends a snapshot to Flint's runtime on this Mac (`http://[::1]:8090`) with
  its own token, which can file a snapshot and nothing else. It listens on
  nothing, so no other program can ask it for anything.

## How it stays read-only

macOS only grants full calendar access, so read-only is enforced by how
Flint Calendar is built. `install_calendar.sh` refuses to install a build that
breaks one of these rules (its header and its three lists are the exact rules):

- **The Swift source** may not name an EventKit method that writes (save,
  remove, commit, reset, a span, a write-only or reminders request, a new event
  or calendar). Nor may it use what could reach one without naming it: a
  selector, class or function made from data (`Selector`,
  `NSSelectorFromString`, the `sel_`, `class_`, `method_` and `objc_`
  functions, `dlsym`), a method looked up or cast (`method(for:)`,
  `unsafeBitCast`, `@convention(c)`, `@_silgen_name`, `AnyObject` lookup,
  `Unmanaged`), a method called by name (`perform`, `sendAction`, key-value
  coding, predicates, expressions, sort descriptors, bindings), or another
  program (`Process`, `posix_spawn`, `system`).
- **The compiled binary** may not hold a write selector, a selector that finds
  or calls a method by name (`methodForSelector:`, `valueForKey:`, predicates,
  bindings) or one that starts with `_` (Apple's private methods). It may not
  import a function or class that makes a selector, class or function from
  data, loads code, or starts another program. Its strings are checked for
  write selectors too, but Swift keeps a string of 15 bytes or fewer inside the
  code, where no scan of strings can see it, so a selector made from short
  strings is stopped by what it must import, not by its name.
- These are lists of the known ways in, checked by name; they are not a proof
  that no other way exists. The sandbox and the signature below still hold.
- It runs in the App Sandbox with exactly four entitlements: the sandbox,
  calendars, outgoing connections, and read-only access to its token file. It
  can't send Apple events, so it can't ask Calendar to change anything either.
- It asks for events only, never reminders, and Flint's policy forbids every
  `apple.*` write.

## Updates

After a change to this directory reaches `main`, the Studio's auto-deploy runs
`update_calendar.sh`, once the runtime is live with that commit's code. It
builds, tests, scans, signs and installs `/Applications/Flint Calendar.app`. It
never opens the app and never starts its background part; it restarts that
part only if you connected it. The signature must really meet the Flint Dev
requirement, and that requirement must match the installed app's, so macOS
keeps the calendar permission; if it doesn't, the installed app is kept.
`connect.sh` checks the installed app's signature the same way before it opens
it. A build that fails is skipped until the directory changes again, and
`~/.flint/calendar-install.log` says why.

To build and install by hand:

```
~/flint/apps/desktop-calendar/install_calendar.sh
```

It needs the "Flint Dev" signing identity that `apps/desktop-mac/install_app.sh`
makes, and never signs ad-hoc.

## If something looks wrong

- `apple-calendar` says "Calendar Access Is Off": turn Flint Calendar on in
  System Settings > Privacy & Security > Calendars.
- It says "Not Reporting": `~/.flint/calendar.log` has one line per change,
  with counts and status codes only.
- `connect.sh` says macOS didn't show its prompt: Flint Calendar isn't listed
  in Settings then, so there is nothing to turn on there. Send Claude the line
  it printed and the output of the command it gives.
- `connect.sh` says Flint Calendar couldn't read its push token: its sandbox
  exception isn't working, and the app needs a fix. Send Claude the message.
- To see what macOS decided about the permission, run
  `/usr/bin/log show --last 10m --predicate 'subsystem == "com.apple.TCC"' | grep -i flint`
  (on this Mac a bare `log` runs something else).

## Files

| File | What it is |
| --- | --- |
| `CalendarCore.swift` | Every decision, pure: the wire format, ids, your answer, who is sent, all-day days, the zone name, the calendar choice, the byte budget, retry timing, the disconnect's retries and the words shown. No EventKit, no AppKit. |
| `CalendarCoreTests.swift` | A plain command-line test runner for the core, with fake events. It encodes the runtime's golden fixture byte for byte. |
| `FlintCalendar.swift` | The app: `--agent` (the background part), the chooser when you open it, and `--disconnect`. |
| `Info.plist`, `FlintCalendar.entitlements` | The bundle (com.flint.calendar, no Dock icon) and its four entitlements. |
| `install_calendar.sh` | Build, test, scan, sign, check and install. |
| `update_calendar.sh` | What auto-deploy runs. |
| `connect.sh`, `disconnect.sh` | Your two commands. |

The runtime side, and the source's own controls and rollback, are in
[`apps/runtime/README.md`](../runtime/README.md#your-apple-calendar-apple_calendar).
`apps/server/test/desktop-calendar.test.ts` checks all of this without ever
running the app. The server's deploy gate requires its Swift checks when a
deploy changes this directory or the wire it shares with the runtime, and skips
them otherwise, so a broken Swift toolchain never holds back an unrelated
server deploy. `install_calendar.sh` reruns the Swift core tests and both read-only scans before every install; the fitToBudget and time zone parity checks run only in the server gate.
