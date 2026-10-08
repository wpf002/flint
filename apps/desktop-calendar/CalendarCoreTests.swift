// Flint Calendar's core, tested headless: a plain command-line program built
// from CalendarCore.swift and this file (no XCTest, no EventKit, no AppKit, no
// bundle), so it can ask for nothing and show nothing. install_calendar.sh runs
// it before every install, and apps/server/test/desktop-calendar.test.ts in the
// server's gate.
//
//   core-tests --fixture <apple-calendar-snapshot.json>   run every test
//   core-tests --emit <worst|worst-cut|plain|plain-cut> [budget]
//                                                         print one snapshot, for the runtime's fitToBudget to compare
//   core-tests --emit zones                               print the zone name sent for every zone macOS knows and a few
//                                                         fixed offsets, for the runtime's own zone check
//
// Fake events stand in for EventKit's. The golden test encodes them and must
// equal the runtime's fixture byte for byte; the byte-budget tests mirror the
// runtime's fitToBudget tests (apps/runtime/test/sources/apple-calendar.test.ts).

import Foundation

// MARK: - Fakes

struct FakePerson: CalendarParticipant {
  var urlString: String?
  var displayName: String?
  var status: ParticipantStatus = .unknown
  var type: ParticipantType = .person
  var isCurrentUser = false
}

struct FakeEvent: CalendarEvent {
  var externalId: String?
  var eventId: String? = "local-id"
  var occurrenceDate: Date?
  var hasRecurrenceRules = false
  var isDetached = false
  var eventStatus: EventStatus = .confirmed
  var title: String? = "A title"
  var isAllDay = false
  var startDate: Date?
  var endDate: Date?
  var lastModifiedDate: Date?
  var organizerIsCurrentUser: Bool?
  var participants: [CalendarParticipant] = []
  var calendarId: String? = "calendar-a"
}

func t(_ s: String) -> Date {
  let f = ISO8601DateFormatter()
  f.formatOptions = s.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
  guard let d = f.date(from: s) else { fatalError("bad date \(s)") }
  return d
}
let chicago = TimeZone(identifier: "America/Chicago")!
let me = { (s: ParticipantStatus) in FakePerson(urlString: "mailto:will@icloud.com", displayName: "Will", status: s, isCurrentUser: true) }
func person(_ email: String, _ name: String? = nil, _ type: ParticipantType = .person) -> FakePerson {
  FakePerson(urlString: "mailto:\(email)", displayName: name, status: .accepted, type: type)
}
func timed(_ ext: String, _ start: String, _ end: String, _ o: (inout FakeEvent) -> Void = { _ in }) -> FakeEvent {
  var e = FakeEvent(externalId: ext, occurrenceDate: t(start), startDate: t(start), endDate: t(end))
  o(&e)
  return e
}
let iCloud = CalendarInfo(id: "calendar-a", title: "Home", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "iCloud")
let onMyMac = CalendarInfo(id: "calendar-b", title: "Errands", kind: .local, sourceKind: .local, sourceTitle: "On My Mac")
let holidays = CalendarInfo(id: "calendar-c", title: "US Holidays", kind: .subscription, sourceKind: .subscribed, sourceTitle: "Other")
let birthdays = CalendarInfo(id: "calendar-d", title: "Birthdays", kind: .birthday, sourceKind: .birthdays, sourceTitle: "Other")
let google = CalendarInfo(id: "calendar-e", title: "Work", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "Google")
let allCalendars = [iCloud, onMyMac, holidays, birthdays, google]
let NOW = t("2026-10-05T15:00:00.400Z")

func read(_ events: [CalendarEvent], calendars: [CalendarInfo] = allCalendars, ticks: [String: Bool] = [:], access: Access = .full, state: HelperState = .live, now: Date = NOW, last: Date? = nil) -> WireSnapshot {
  Snapshots.build(ReadInput(now: now, timeZone: chicago, access: access, state: state, calendars: calendars, ticks: ticks, events: events, lastGeneratedAt: last))
}

/// The events behind the golden fixture, as EventKit would give them, plus what the core must leave out.
func goldenEvents() -> [CalendarEvent] {
  [
    timed("organized", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") {
      $0.title = "Design review"
      $0.organizerIsCurrentUser = true
      $0.lastModifiedDate = t("2026-10-05T14:56:00.250Z")
      $0.participants = [
        me(.accepted), person("ada@example.com", "Ada Lovelace"), person("grace@example.com"),
        FakePerson(urlString: "urn:uuid:9b1d-room", displayName: "Not an address", type: .person),
        person("room-4@example.com", "Room 4", .room), person("design@example.com", "Design team", .group),
      ]
    },
    timed("accepted-weekly", "2026-10-06T14:30:00Z", "2026-10-06T15:00:00Z") {
      $0.title = "Weekly sync"
      $0.hasRecurrenceRules = true
      $0.organizerIsCurrentUser = false
      $0.lastModifiedDate = t("2026-09-28T09:00:00Z")
      $0.participants = [person("ada@example.com", "Ada Lovelace"), me(.accepted), person("projector@example.com", "Projector", .resource)]
    },
    timed("tentative", "2026-10-08T17:00:00Z", "2026-10-08T18:00:00Z") {
      $0.title = "Maybe lunch"
      $0.eventStatus = .tentative
      $0.organizerIsCurrentUser = false
      $0.participants = [me(.tentative), person("friend@example.com", "Friend")]
    },
    timed("not-answered", "2026-10-09T16:00:00Z", "2026-10-09T17:00:00Z") {
      $0.title = "Vendor pitch"
      $0.organizerIsCurrentUser = false
      $0.participants = [person("sales@vendor.example", "Sales"), me(.pending)]
    },
    timed("declined", "2026-10-09T23:00:00Z", "2026-10-10T01:00:00Z") {
      $0.title = "Optional social"
      $0.organizerIsCurrentUser = false
      $0.participants = [me(.declined), person("host@example.com", "Host")]
    },
    timed("cancelled", "2026-10-06T13:00:00Z", "2026-10-06T13:15:00Z") {
      $0.title = "Old standup"
      $0.eventStatus = .canceled
      $0.organizerIsCurrentUser = false
      $0.lastModifiedDate = t("2026-10-05T14:58:00Z")
      $0.participants = [me(.accepted), person("lead@example.com", "Lead")]
    },
    // All day, Apple's way: from local midnight to 23:59:59 on the last day (CDT is UTC-5).
    timed("offsite", "2026-10-12T05:00:00Z", "2026-10-14T04:59:59Z") {
      $0.title = "Team offsite"
      $0.isAllDay = true
      $0.calendarId = "calendar-b"
    },
    timed("passport", "2026-10-06T05:00:00Z", "2026-10-07T04:59:59Z") {
      $0.title = "Passport renewal"
      $0.isAllDay = true
      $0.calendarId = "calendar-b"
    },
    timed("check-in", "2026-10-05T20:00:00Z", "2026-10-05T20:00:00Z") { $0.title = "Check in" },
    // Left out: the same invitation in another calendar with a weaker answer, a calendar Will didn't choose, no calendar.
    timed("organized", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") {
      $0.title = "Design review (copy)"
      $0.calendarId = "calendar-b"
      $0.organizerIsCurrentUser = false
      $0.participants = [me(.accepted), person("ada@example.com", "Ada Lovelace")]
    },
    timed("holiday", "2026-10-12T05:00:00Z", "2026-10-13T04:59:59Z") { $0.isAllDay = true; $0.calendarId = "calendar-c" },
    timed("work", "2026-10-08T14:00:00Z", "2026-10-08T15:00:00Z") { $0.calendarId = "calendar-e" },
    timed("nowhere", "2026-10-08T14:00:00Z", "2026-10-08T15:00:00Z") { $0.calendarId = nil },
  ]
}

// MARK: - The byte budget's inputs, built exactly as the runtime's tests build them

let CALS = Hash.sha256("calendar-a\ncalendar-b")
let MS_HOUR: TimeInterval = 3600
func at(_ seconds: TimeInterval) -> String { Times.instant(t("2026-10-05T15:00:00Z").addingTimeInterval(seconds)) }
func wireEvent(_ name: String, start: String = "2026-10-07T19:00:00Z", end: String = "2026-10-07T20:00:00Z", title: String? = nil, answer: String = "accepted", attendees: [WireAttendee]? = nil) -> WireEvent {
  WireEvent(id: Hash.sha256(name), recurring: false, status: "confirmed", title: title ?? "Private title \(name)", start: .instant(start), end: .instant(end), modifiedAt: nil, answer: answer, attendees: attendees)
}
func wireSnapshot(_ events: [WireEvent]) -> WireSnapshot {
  WireSnapshot(v: 1, generatedAt: at(0), access: "full", state: "live", window: WireWindow(start: at(0), end: at(14 * 86_400)), tz: "America/Chicago", complete: true, calendars: WireCalendars(count: 2, hash: CALS), events: events)
}
func pad6(_ n: Int) -> String { String(repeating: "0", count: max(0, 6 - String(n).count)) + String(n) }
/// An event at every cap: a 300-character title, and 100 attendees with 100-character names and 254-character addresses.
func atCaps(_ i: Int) -> WireEvent {
  wireEvent("cap\(i)", start: at(Double(i % 300) * MS_HOUR), end: at(Double(i % 300) * MS_HOUR + MS_HOUR), title: String(repeating: "t", count: 300), answer: "organizer",
            attendees: (0..<Wire.maxAttendees).map { j in WireAttendee(email: "\(String(repeating: "a", count: 236))\(pad6(i * 100 + j))@example.org", kind: "person", name: String(repeating: "é", count: 100)) })
}
func worst() -> WireSnapshot { wireSnapshot((0..<Wire.maxEvents).map(atCaps)) }
func plain() -> WireSnapshot {
  wireSnapshot((0..<40).map { i in wireEvent("p\(i)", start: at(Double(i) * MS_HOUR), end: at(Double(i) * MS_HOUR + MS_HOUR), title: String(repeating: "x", count: 300)) })
}

// MARK: - A small runner

final class Runner {
  var passed = 0
  var failed: [String] = []
  var current = ""
  func test(_ name: String, _ body: () -> Void) {
    current = name
    let before = failed.count
    body()
    if failed.count == before { passed += 1 }
  }
  func check(_ ok: Bool, _ what: @autoclosure () -> String, line: Int = #line) {
    if !ok { failed.append("\(current) (line \(line)): \(what())") }
  }
  func equal<T: Equatable>(_ a: T, _ b: T, _ what: String = "", line: Int = #line) {
    check(a == b, "\(what) expected \(b), got \(a)", line: line)
  }
}

func titleCase(_ s: String) -> Bool {
  let small: Set<String> = ["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]
  let words = s.split(separator: " ").map(String.init)
  return !words.isEmpty && words.enumerated().allSatisfy { i, w in
    guard let f = w.unicodeScalars.first else { return false }
    if i > 0 && small.contains(w) { return true }
    return CharacterSet.uppercaseLetters.contains(f) || CharacterSet.decimalDigits.contains(f)
  }
}
func sentence(_ s: String) -> Bool {
  guard let f = s.unicodeScalars.first, let l = s.last else { return false }
  return CharacterSet.uppercaseLetters.contains(f) && ".!?".contains(l) && s.split(separator: " ").count >= 3
}

@main
struct CoreTests {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--emit"), i + 1 < args.count {
      let budget = i + 2 < args.count ? Int(args[i + 2]) : nil
      switch args[i + 1] {
      case "worst": print(JSON.string(worst()), terminator: "")
      case "worst-cut": print(JSON.string(Budget.fit(worst())), terminator: "")
      case "plain": print(JSON.string(plain()), terminator: "")
      case "plain-cut": print(JSON.string(Budget.fit(plain(), budget: budget ?? JSON.bytes(plain()) / 2)), terminator: "")
      case "zones":
        // Every zone this Mac could be set to: the names macOS lists, every file in its zone database, fixed offsets.
        let root = "/usr/share/zoneinfo/"
        var names = TimeZone.knownTimeZoneIdentifiers
        if let files = FileManager.default.enumerator(atPath: root) {
          for case let f as String in files where !f.contains(".") { names.append(f) }
        }
        let offsets = [-43_200, -18_000, -3_600, 0, 3_600, 19_800, 50_400].compactMap { TimeZone(secondsFromGMT: $0) }
        let all = names.compactMap { TimeZone(identifier: $0) } + offsets + [TimeZone.current]
        print(JSON.string(all.map { [$0.identifier, Times.zoneName($0)] }), terminator: "")
      default: FileHandle.standardError.write(Data("unknown --emit\n".utf8)); exit(2)
      }
      exit(0)
    }
    var fixture: String?
    if let i = args.firstIndex(of: "--fixture"), i + 1 < args.count { fixture = args[i + 1] }
    let r = Runner()
    run(r, fixture: fixture)
    for f in r.failed { print("FAIL \(f)") }
    print("\(r.passed) passed, \(r.failed.count) failed")
    exit(r.failed.isEmpty ? 0 : 1)
  }

  static func run(_ r: Runner, fixture: String?) {
    r.test("the golden fixture: fake events encode to it byte for byte") {
      guard let path = fixture, let golden = try? String(contentsOfFile: path, encoding: .utf8) else {
        r.check(false, "no fixture (pass --fixture apps/runtime/test/fixtures/apple-calendar-snapshot.json)")
        return
      }
      let got = JSON.string(read(goldenEvents()))
      r.equal(got, golden, "the encoded snapshot")
      r.check(!got.contains("\\"), "nothing escaped")
      r.check(!got.hasSuffix("\n"), "no trailing newline")
    }

    r.test("JSON is canonical: keys sorted, compact, slashes not escaped") {
      let s = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = "a/b" }])
      let json = JSON.string(s)
      r.check(json.hasPrefix("{\"access\":\"full\",\"calendars\":{\"count\":2,\"hash\":"), json)
      r.check(json.contains("\"title\":\"a/b\""), "a slash stays a slash")
      r.check(json.contains("\"tz\":\"America/Chicago\""), json)
      r.check(json.hasSuffix(",\"v\":1,\"window\":{\"end\":\"2026-10-19T15:00:00Z\",\"start\":\"2026-10-05T15:00:00Z\"}}"), json)
      r.check(!json.contains(" "), "compact")
    }

    r.test("all-day events: Apple's 23:59:59 becomes an exclusive end day, across both Chicago DST changes") {
      func days(_ s: String, _ e: String) -> String {
        let d = Times.allDay(start: t(s), end: t(e), chicago)
        return "\(d.start)..\(d.end)"
      }
      // Spring forward (2026-03-08: midnight is CST, 23:59:59 is CDT).
      r.equal(days("2026-03-08T06:00:00Z", "2026-03-09T04:59:59Z"), "2026-03-08..2026-03-09")
      r.equal(days("2026-03-07T06:00:00Z", "2026-03-09T04:59:59Z"), "2026-03-07..2026-03-09")
      r.equal(days("2026-03-08T06:00:00Z", "2026-03-10T04:59:59Z"), "2026-03-08..2026-03-10")
      // Fall back (2026-11-01: midnight is CDT, 23:59:59 is CST).
      r.equal(days("2026-11-01T05:00:00Z", "2026-11-02T05:59:59Z"), "2026-11-01..2026-11-02")
      r.equal(days("2026-10-31T05:00:00Z", "2026-11-02T05:59:59Z"), "2026-10-31..2026-11-02")
      r.equal(days("2026-11-01T05:00:00Z", "2026-11-03T05:59:59Z"), "2026-11-01..2026-11-03")
      // An end at exactly midnight is already exclusive; an end before its start is still one day.
      r.equal(days("2026-10-06T05:00:00Z", "2026-10-07T05:00:00Z"), "2026-10-06..2026-10-07")
      r.equal(days("2026-10-06T05:00:00Z", "2026-10-05T05:00:00Z"), "2026-10-06..2026-10-07")
      // New Year and a leap day.
      r.equal(days("2026-12-31T06:00:00Z", "2027-01-01T05:59:59Z"), "2026-12-31..2027-01-01")
      r.equal(days("2028-02-29T06:00:00Z", "2028-03-01T05:59:59Z"), "2028-02-29..2028-03-01")
      let e = read([timed("ad", "2026-11-01T05:00:00Z", "2026-11-02T05:59:59Z") { $0.isAllDay = true }]).events[0]
      r.equal(e.start, .date("2026-11-01"))
      r.equal(e.end, .date("2026-11-02"))
    }

    r.test("timed events are UTC instants to the second; an end before its start ends as it starts") {
      let e = read([timed("x", "2026-10-07T19:00:00.900Z", "2026-10-07T18:00:00Z")]).events[0]
      r.equal(e.start, .instant("2026-10-07T19:00:00Z"))
      r.equal(e.end, .instant("2026-10-07T19:00:00Z"))
    }

    r.test("ids: a single event keeps its id when it moves; an occurrence of a repeating one is its occurrence date") {
      let a = Events.id(timed("ext-1", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z"))
      let moved = Events.id(timed("ext-1", "2026-10-08T09:00:00Z", "2026-10-08T10:00:00Z"))
      r.equal(a, Hash.sha256("ext-1"))
      r.equal(moved, a, "a moved single event")
      let occ = timed("series", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.hasRecurrenceRules = true }
      var occMoved = occ
      occMoved.startDate = t("2026-10-07T21:00:00Z")
      occMoved.endDate = t("2026-10-07T22:00:00Z")
      occMoved.isDetached = true
      occMoved.hasRecurrenceRules = false
      let next = timed("series", "2026-10-14T19:00:00Z", "2026-10-14T20:00:00Z") { $0.hasRecurrenceRules = true }
      r.equal(Events.id(occ), Hash.sha256("series|2026-10-07T19:00:00Z"))
      r.equal(Events.id(occMoved), Events.id(occ), "a moved (detached) occurrence keeps its occurrence's id")
      r.check(Events.id(next) != Events.id(occ), "two occurrences are two events")
      // No external id: the event id; neither: unreadable, and the snapshot says it is not complete.
      var local = timed("", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z")
      local.eventId = "EK-123"
      r.equal(Events.id(local), Hash.sha256("EK-123"))
      local.externalId = nil
      r.equal(Events.id(local), Hash.sha256("EK-123"))
      local.eventId = nil
      r.equal(Events.id(local), nil)
      let s = read([local, timed("ok", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z")])
      r.equal(s.events.count, 1)
      r.equal(s.complete, false)
      var noStart = timed("nostart", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z")
      noStart.startDate = nil
      r.equal(read([noStart]).complete, false)
      r.equal(read([timed("ok", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z")]).complete, true)
    }

    r.test("Will's answer: organizer, his own entry, his own event when nobody is invited, else not answered") {
      func answer(_ o: Bool?, _ p: [CalendarParticipant]) -> String {
        Events.answer(FakeEvent(externalId: "x", startDate: NOW, endDate: NOW, organizerIsCurrentUser: o, participants: p)).rawValue
      }
      r.equal(answer(true, [me(.accepted), person("a@x.org")]), "organizer")
      r.equal(answer(true, []), "organizer")
      // His own entry for a meeting he organized: only a "no" (declined or delegated) outranks organizer.
      for s: ParticipantStatus in [.accepted, .tentative, .pending, .unknown] { r.equal(answer(true, [me(s), person("a@x.org")]), "organizer", "\(s)") }
      r.equal(answer(false, [me(.accepted)]), "accepted")
      r.equal(answer(false, [me(.tentative)]), "tentative")
      r.equal(answer(false, [me(.declined)]), "declined")
      r.equal(answer(false, [me(.delegated)]), "declined")
      for s: ParticipantStatus in [.pending, .unknown, .inProcess, .completed] { r.equal(answer(false, [me(s)]), "needs_action") }
      r.equal(answer(nil, []), "organizer")
      // Invited at an address that isn't his Apple Account's: not answered (no heads-up, no people).
      r.equal(answer(false, [person("a@x.org"), person("b@x.org")]), "needs_action")
      r.equal(answer(false, []), "needs_action")
      r.equal(answer(nil, [person("a@x.org")]), "needs_action")
    }

    r.test("a meeting Will organized and then declined is declined, as the Google path has it: no attendees, no heads-up") {
      func event(_ s: ParticipantStatus) -> WireEvent {
        read([timed("mine-declined", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") {
          $0.organizerIsCurrentUser = true
          $0.participants = [me(s), person("ada@example.com", "Ada")]
        }]).events[0]
      }
      r.equal(event(.declined).answer, "declined")
      r.equal(event(.declined).attendees, nil)
      r.check(!JSON.string(event(.declined)).contains("ada@example.com"), "nobody is sent with a meeting he declined")
      r.equal(event(.delegated).answer, "declined")
      r.equal(event(.delegated).attendees, nil)
      r.equal(event(.accepted).answer, "organizer")
      r.equal(event(.accepted).attendees?.map(\.email), ["ada@example.com"])
      // With no one else on it, it is still his "no".
      let alone = timed("alone", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.organizerIsCurrentUser = true; $0.participants = [me(.declined)] }
      r.equal(read([alone]).events.map(\.answer), ["declined"])
    }

    r.test("attendees: only with an event Will organized or accepted, never Will, never a cancelled event") {
      let people: [CalendarParticipant] = [person("ada@example.com", "Ada")]
      func list(_ s: ParticipantStatus, _ status: EventStatus = .confirmed) -> [WireAttendee]? {
        read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.organizerIsCurrentUser = false; $0.participants = [me(s)] + people; $0.eventStatus = status }]).events[0].attendees
      }
      r.equal(list(.accepted), [WireAttendee(email: "ada@example.com", kind: "person", name: "Ada")])
      r.equal(list(.tentative), nil)
      r.equal(list(.declined), nil)
      r.equal(list(.pending), nil)
      r.equal(list(.accepted, .canceled), nil)
      // Organized, with only Will on it: no attendees key at all.
      let mine = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.organizerIsCurrentUser = true; $0.participants = [me(.accepted)] }]).events[0]
      r.equal(mine.attendees, nil)
      r.check(!JSON.string(mine).contains("attendees"), "no empty attendee list")
      r.check(!JSON.string(read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.participants = [me(.accepted)] + people; $0.organizerIsCurrentUser = false }])).contains("will@icloud.com"), "Will is never an attendee")
    }

    r.test("addresses: mailto only, decoded, at most 254 (longer is dropped, never clipped)") {
      r.equal(Text.address("mailto:ada@example.com"), "ada@example.com")
      r.equal(Text.address("MAILTO:Ada@Example.com"), "Ada@Example.com")
      r.equal(Text.address("mailto:ada%2Bflint@example.com?subject=hi"), "ada+flint@example.com")
      r.equal(Text.address("urn:uuid:1234"), nil)
      r.equal(Text.address("https://example.com/ada@example.com"), nil)
      r.equal(Text.address("mailto:"), nil)
      r.equal(Text.address("mailto:not-an-address"), nil)
      r.equal(Text.address("mailto:a%00b@example.com"), "ab@example.com")
      r.equal(Text.address(nil), nil)
      let at254 = String(repeating: "a", count: 242) + "@example.org"
      r.equal(at254.count, 254)
      r.equal(Text.address("mailto:\(at254)"), at254)
      r.equal(Text.address("mailto:a\(at254)"), nil)
      let s = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") {
        $0.organizerIsCurrentUser = true
        $0.participants = [person("a\(at254)"), FakePerson(urlString: "urn:x", displayName: "Room"), person("ok@example.com", "OK")]
      }])
      r.equal(s.events[0].attendees?.map(\.email) ?? [], ["ok@example.com"])
      r.equal(s.complete, true, "a dropped address is not a cut")
    }

    r.test("rooms, resources and groups go as what they are; names are cleaned, clipped, and left out when empty") {
      let s = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") {
        $0.organizerIsCurrentUser = true
        $0.participants = [
          person("r@x.org", "Room", .room), person("s@x.org", "Screen", .resource), person("g@x.org", "Group", .group),
          person("u@x.org", "Who", .unknown), person("n@x.org", String(repeating: "n", count: 101)), person("e@x.org", "\u{0}\u{1}"),
          person("c@x.org", "Line\nbreak\u{0}"),
        ]
      }])
      let a = s.events[0].attendees ?? []
      r.equal(a.map(\.kind), ["room", "resource", "group", "unknown", "person", "person", "person"])
      r.equal(a[4].name, String(repeating: "n", count: 100))
      r.equal(a[5].name, nil)
      r.equal(a[6].name, "Line break")
    }

    r.test("more than 100 attendees: the first 100, and the snapshot says it is not complete") {
      let many = (0..<(Wire.maxAttendees + 5)).map { person("p\($0)@x.org") }
      let s = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.organizerIsCurrentUser = true; $0.participants = many }])
      r.equal(s.events[0].attendees?.count, Wire.maxAttendees)
      r.equal(s.events[0].attendees?.last?.email, "p99@x.org")
      r.equal(s.complete, false)
    }

    r.test("outside text: NUL and other control characters out, a title clipped to 300 without half an emoji") {
      r.equal(Text.clean("a\u{0}b\tc\nd\u{7}e\u{7F}f\r\ng"), "ab c def  g")
      r.equal(Text.clip(String(repeating: "x", count: 299) + "😀tail", 300), String(repeating: "x", count: 299))
      r.equal(Text.clip(String(repeating: "x", count: 298) + "😀tail", 300), String(repeating: "x", count: 298) + "😀")
      r.equal(Text.clip("short", 300), "short")
      let s = read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = "\u{0}" + String(repeating: "t", count: 400) }])
      r.equal(s.events[0].title, String(repeating: "t", count: 300))
      r.check(!JSON.string(read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = "a\u{0}b" }])).contains("\\u0000"), "no NUL reaches the body")
      r.equal(read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = nil }]).events[0].title, "")
    }

    r.test("copies of one event: Will's strongest answer is kept, in the first copy's place") {
      let weak = timed("dup", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = "weak"; $0.organizerIsCurrentUser = false; $0.participants = [me(.tentative)] }
      let strong = timed("dup", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.title = "strong"; $0.organizerIsCurrentUser = false; $0.participants = [me(.accepted)]; $0.calendarId = "calendar-b" }
      let other = timed("other", "2026-10-06T19:00:00Z", "2026-10-06T20:00:00Z")
      let s = read([weak, other, strong])
      r.equal(s.events.map(\.title), ["strong", "A title"])
      r.equal(s.events[0].answer, "accepted")
      r.equal(read([strong, weak]).events.map(\.title), ["strong"])
      let order: [Answer] = [.organizer, .accepted, .tentative, .needsAction, .declined]
      r.equal(order.map(\.strength), order.map(\.strength).sorted(by: >))
    }

    r.test("over 1000 events: the earliest 1000 by start then id, in the order they came, and not complete") {
      let n = Wire.maxEvents + 3
      // Given latest first.
      let events = (0..<n).reversed().map { i in timed("e\(i)", at(Double(i) * 60), at(Double(i) * 60 + 60)) }
      let s = read(events)
      r.equal(s.events.count, Wire.maxEvents)
      r.equal(s.complete, false)
      r.equal(s.events.first?.id, Hash.sha256("e\(Wire.maxEvents - 1)"))
      r.equal(s.events.last?.id, Hash.sha256("e0"))
    }

    r.test("calendars: iCloud and On My Mac ticked, subscriptions and other accounts not, Birthdays never shown") {
      r.equal(Calendars.section(iCloud), .iCloud)
      r.equal(Calendars.section(CalendarInfo(id: "m", title: "Old", kind: .calDAV, sourceKind: .mobileMe, sourceTitle: "MobileMe")), .iCloud)
      r.equal(Calendars.section(onMyMac), .onMyMac)
      r.equal(Calendars.section(holidays), .subscribed)
      r.equal(Calendars.section(CalendarInfo(id: "s", title: "Sports", kind: .subscription, sourceKind: .calDAV, sourceTitle: "iCloud")), .subscribed)
      r.equal(Calendars.section(birthdays), nil)
      r.equal(Calendars.section(google), .otherAccounts)
      r.equal(Calendars.section(CalendarInfo(id: "x", title: "Work", kind: .exchange, sourceKind: .exchange, sourceTitle: "Exchange")), .otherAccounts)
      r.equal(Calendars.selected(allCalendars, [:]).map(\.id), ["calendar-a", "calendar-b"])
      // Will's ticks win; Birthdays stay out even ticked.
      r.equal(Calendars.selected(allCalendars, ["calendar-a": false, "calendar-c": true, "calendar-d": true, "calendar-e": true]).map(\.id), ["calendar-b", "calendar-c", "calendar-e"])
      r.equal(Calendars.summary([onMyMac, iCloud]), WireCalendars(count: 2, hash: CALS))
      r.equal(Calendars.summary([]), WireCalendars(count: 0, hash: Hash.sha256("")))
      // Events in a calendar he unticked are not sent, and the digest changes with the choice.
      let s = read(goldenEvents(), ticks: ["calendar-b": false])
      r.check(s.events.allSatisfy { $0.start.day == nil }, "On My Mac's all-day events are left out")
      r.equal(s.calendars, WireCalendars(count: 1, hash: Hash.sha256("calendar-a")))
      r.check(!JSON.string(read(goldenEvents())).contains("Home"), "no calendar name is sent")
    }

    r.test("the chooser: UPPERCASE sections in order, Title Case titles and buttons, sentences, Connect needs a tick") {
      let m = ChooserModel.make(allCalendars + [CalendarInfo(id: "z", title: "", kind: .local, sourceKind: .local, sourceTitle: "On My Mac")], ticks: ["calendar-a": false])
      r.equal(m.groups.map(\.header), ["ICLOUD", "ON MY MAC", "SUBSCRIBED", "OTHER ACCOUNTS"])
      r.check(m.groups.allSatisfy { $0.header == $0.header.uppercased() }, "headers are UPPERCASE")
      r.equal(m.groups[0].rows, [ChooserRow(id: "calendar-a", nameKey: Calendars.nameKey(iCloud), title: "Home", detail: nil, ticked: false)])
      r.equal(m.groups[1].rows.map(\.title), ["Errands", "Untitled"])
      r.equal(m.groups[1].rows.map(\.ticked), [true, true])
      r.equal(m.groups[2].rows.map(\.ticked), [false])
      r.equal(m.groups[3].rows, [ChooserRow(id: "calendar-e", nameKey: Calendars.nameKey(google), title: "Work", detail: "Google", ticked: false)])
      r.check(!m.groups.flatMap(\.rows).contains { $0.title == "Birthdays" }, "Birthdays is never shown")
      r.equal(m.empty, nil)
      for s in UIText.titles + [m.windowTitle, m.heading, m.cancel, m.connect] { r.check(titleCase(s), "Title Case: \(s)") }
      for s in UIText.sentences + [m.intro, m.footnote] { r.check(sentence(s), "a sentence: \(s)") }
      for a in [Access.denied, .notDetermined, .writeOnly, .restricted] {
        guard let x = UIText.alert(a) else { r.check(false, "an alert for \(a)"); continue }
        r.check(titleCase(x.title) && sentence(x.text) && x.buttons.allSatisfy(titleCase), "\(a)")
      }
      r.check(UIText.alert(.full) == nil, "full access shows the chooser")
      r.check(titleCase(UIText.noTokenTitle) && sentence(UIText.noTokenText), "the token alert")
      r.check(titleCase(UIText.connectedTitle) && sentence(UIText.connectedText), "the connected alert")
      let none = ChooserModel.make([birthdays], ticks: [:])
      r.equal(none.groups, [])
      r.check(none.empty.map(sentence) ?? false, "an empty Mac says so in a sentence")
      let rows = m.groups.flatMap(\.rows)
      r.equal(ChooserModel.canConnect([:], rows: rows), true)
      r.equal(ChooserModel.canConnect(Dictionary(uniqueKeysWithValues: rows.map { ($0.id, false) }), rows: rows), false)
      r.check(!titleCase("Calendar access is off") && !sentence("Calendar Access Is Off"), "the checks themselves")
    }

    r.test("a calendar keeps Will's tick when EventKit gives it a new id (a full sync), by its account and title") {
      let family = CalendarInfo(id: "family-1", title: "Family", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "iCloud")
      let home = CalendarInfo(id: "home-1", title: "Home", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "iCloud")
      let work = CalendarInfo(id: "work-1", title: "Work", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "Google")
      let before = ChooserModel.make([family, home, work], ticks: [:]).groups.flatMap(\.rows)
      // He unticks Family and ticks Work.
      let ticks = Calendars.remember([:], before.map { (row: $0, on: $0.id == "family-1" ? false : $0.id == "work-1" ? true : $0.ticked) })
      r.equal(ticks["family-1"], false)
      r.equal(ticks[Calendars.nameKey(family)], false)
      r.equal(ticks[Calendars.nameKey(work)], true)
      // After a full sync every id is new: his choices hold, and the chooser shows them.
      var family2 = family, home2 = home, work2 = work
      family2.id = "family-2"; home2.id = "home-2"; work2.id = "work-2"
      r.equal(Calendars.selected([family2, home2, work2], ticks).map(\.id), ["home-2", "work-2"])
      r.equal(ChooserModel.make([family2], ticks: ticks).groups[0].rows.map(\.ticked), [false])
      r.equal(read([timed("x", "2026-10-07T19:00:00Z", "2026-10-07T20:00:00Z") { $0.calendarId = "family-2" }], calendars: [family2, home2], ticks: ticks).events, [])
      // The tick under the id wins; a calendar he has never seen gets its section's default.
      r.equal(Calendars.ticked(family, ["family-1": true, Calendars.nameKey(family): false]), true)
      let added = CalendarInfo(id: "trips-1", title: "Trips", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "iCloud")
      r.equal(Calendars.ticked(added, ticks), true)
      r.check(Calendars.nameKey(family) != Calendars.nameKey(CalendarInfo(id: "f", title: "Family", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "Google")), "another account is another calendar")
      // Two calendars with one account and title, ticked differently: the name key falls back to unticked.
      let twinA = CalendarInfo(id: "twin-a", title: "Shared", kind: .calDAV, sourceKind: .calDAV, sourceTitle: "iCloud")
      var twinB = twinA
      twinB.id = "twin-b"
      let rows = ChooserModel.make([twinA, twinB], ticks: [:]).groups[0].rows
      let twins = Calendars.remember([:], rows.map { (row: $0, on: $0.id == "twin-a") })
      r.equal(twins[Calendars.nameKey(twinA)], false)
      r.equal(Calendars.remember([:], rows.map { (row: $0, on: true) })[Calendars.nameKey(twinA)], true)
      // Keys are kept for calendars not shown this time.
      r.equal(Calendars.remember(["gone": false], [])["gone"], false)
    }

    r.test("no full access, or disconnected: no events, no calendars, the state said") {
      for a in [Access.denied, .restricted, .notDetermined, .writeOnly] {
        let s = read(goldenEvents(), access: a)
        r.equal(s.events.count, 0, a.rawValue)
        r.equal(s.access, a.rawValue)
        r.equal(s.calendars, WireCalendars(count: 0, hash: Hash.sha256("")))
      }
      let off = read(goldenEvents(), state: .revoked)
      r.equal(off.state, "revoked")
      r.equal(off.events.count, 0)
      r.equal(off.complete, true)
    }

    r.test("generatedAt is to the second and always after the last one sent; the window is 14 days") {
      let a = Snapshots.generatedAt(now: t("2026-10-05T15:00:00.700Z"), last: nil)
      r.equal(Times.instant(a), "2026-10-05T15:00:00Z")
      r.equal(Times.instant(Snapshots.generatedAt(now: t("2026-10-05T15:00:00.900Z"), last: a)), "2026-10-05T15:00:01Z")
      r.equal(Times.instant(Snapshots.generatedAt(now: t("2026-10-05T14:59:00Z"), last: a)), "2026-10-05T15:00:01Z")
      r.equal(Times.instant(Snapshots.generatedAt(now: t("2026-10-05T15:05:00Z"), last: a)), "2026-10-05T15:05:00Z")
      let s = read([], last: t("2026-10-05T15:00:00Z"))
      r.equal(s.generatedAt, "2026-10-05T15:00:01Z")
      r.equal(s.window, WireWindow(start: "2026-10-05T15:00:01Z", end: "2026-10-19T15:00:01Z"))
      r.equal(Times.zoneName(chicago), "America/Chicago")
      // A fixed offset is not a zone the runtime takes (Intl refuses "GMT+0100"): UTC instead, never a refused snapshot.
      r.equal(Times.zoneName(TimeZone(secondsFromGMT: 3600)!), "UTC")
      r.equal(Times.zoneName(TimeZone(secondsFromGMT: -18_000)!), "UTC")
      r.equal(Times.zoneName(TimeZone(identifier: "Asia/Kolkata")!), "Asia/Kolkata")
      r.equal(Times.zoneName(TimeZone(identifier: "GMT")!), "GMT")
      r.equal(Times.zoneName(TimeZone(identifier: "EST5EDT")!), "EST5EDT")
      r.equal(Times.zoneName(TimeZone(identifier: "Etc/GMT+5")!), "Etc/GMT+5")
      r.equal(Times.zoneName(TimeZone(identifier: "Factory")!), "UTC")
      r.equal(read([], now: NOW).tz, "America/Chicago")
      r.equal(Snapshots.build(ReadInput(now: NOW, timeZone: TimeZone(secondsFromGMT: 3600)!, access: .full)).tz, "UTC")
      r.check(TimeZone.knownTimeZoneIdentifiers.allSatisfy { Times.zoneName(TimeZone(identifier: $0)!) == $0 || $0.count > 64 }, "every zone macOS knows goes by its own name")
      r.equal(Times.daysFromCivil(1970, 1, 1), 0)
      r.equal(Times.dayString(Times.daysFromCivil(2026, 2, 28) + 1), "2026-03-01")
    }

    r.test("the push token: 64 lowercase hex digits, a final newline allowed") {
      let hex = String(repeating: "0123456789abcdef", count: 4)
      r.equal(Token.parse(hex + "\n"), hex)
      r.equal(Token.parse(hex.uppercased()), nil)
      r.equal(Token.parse(String(hex.dropLast())), nil)
      r.equal(Token.parse(nil), nil)
      r.equal(Token.parse(""), nil)
      r.equal(Wire.pushURL, "http://[::1]:8090/v1/sources/apple_calendar/snapshot")
    }

    r.test("backoff per status: 5 minutes after 202, 404 and 409; 30 minutes for a refused token; a ladder when down") {
      func d(_ o: PushOutcome, _ n: Int = 1) -> TimeInterval { Backoff.delay(after: o, failures: n) }
      r.equal(d(.status(202)), 300)
      r.equal(d(.status(409)), 300)
      r.equal(d(.status(409), 50), 300, "never more than 5 minutes after a 409")
      r.equal(d(.status(404)), 300)
      r.equal(d(.status(401)), 1800)
      r.equal(d(.status(403)), 1800)
      r.equal(d(.status(429)), 10)
      for c in [400, 413, 422] { r.equal(d(.status(c)), 300, "\(c)") }
      r.equal((1...8).map { d(.unreachable, $0) }, [15, 30, 60, 120, 240, 300, 300, 300])
      r.equal((1...7).map { d(.status(503), $0) }, [15, 30, 60, 120, 240, 300, 300])
      r.equal(d(.noToken), 300)
      r.equal(d(.status(418)), 300)
      r.equal(Backoff.changesPushSooner(after: .status(404)), true)
      r.equal(Backoff.changesPushSooner(after: .status(401)), false)
      r.equal(Backoff.changesPushSooner(after: .status(403)), false)
      r.equal(Backoff.changesPushSooner(after: .status(409)), true)
      r.equal(Backoff.changesPushSooner(after: .unreachable), true)
      r.equal(Backoff.sameKind(.status(500), .status(503)), true)
      r.equal(Backoff.sameKind(.status(409), .status(404)), false)
      r.equal(Backoff.sameKind(.unreachable, .status(503)), false)
      r.equal(DisconnectExit.code(.status(202)), 0)
      r.equal(DisconnectExit.code(.status(404)), 3)
      r.equal(DisconnectExit.code(.status(409)), 3)
      for o in [PushOutcome.status(400), .status(401), .status(403), .status(413), .status(422)] { r.equal(DisconnectExit.code(o), 1, "\(o)") }
      for o in [PushOutcome.status(500), .status(503), .status(429), .unreachable, .noToken] { r.equal(DisconnectExit.code(o), 2, "\(o)") }
      r.equal(DisconnectExit.retry(.status(429)), 6)
      r.equal(DisconnectExit.retry(.status(422)), 6)
      for o in [PushOutcome.status(503), .unreachable, .noToken] { r.equal(DisconnectExit.retry(o), 5, "\(o)") }
      for o in [PushOutcome.status(202), .status(401), .status(400), .status(404), .status(409)] { r.equal(DisconnectExit.retry(o), nil, "\(o)") }
      for o in [PushOutcome.status(202), .status(404), .status(401), .status(503), .unreachable, .noToken] {
        r.check(sentence(DisconnectExit.message(o)), DisconnectExit.message(o))
      }
      r.equal(DisconnectExit.message(.unreachable), "Flint couldn't be told yet that Apple Calendar is disconnected, because the runtime isn't answering.")
      r.equal(DisconnectExit.message(.status(401)), "Flint couldn't be told that Apple Calendar is disconnected, because the runtime answered 401.")
    }

    r.test("--disconnect keeps trying for a minute while the runtime is down or restarting, then says it wasn't told yet") {
      /// Runs DisconnectExit.run against a scripted runtime and a fake clock: the outcomes, the waits, and the pushes made.
      func run(_ script: [PushOutcome]) -> (outcome: PushOutcome, waits: [TimeInterval], pushes: Int) {
        var clock: TimeInterval = 0, waits: [TimeInterval] = [], pushes = 0
        let o = DisconnectExit.run(send: {
          pushes += 1
          clock += 1
          return script[min(pushes, script.count) - 1]
        }, wait: { waits.append($0); clock += $0 }, elapsed: { clock })
        return (o, waits, pushes)
      }
      // A deploy restarts the runtime: two pushes find nobody, the third is taken.
      let restart = run([.unreachable, .status(503), .status(202)])
      r.equal(restart.outcome, .status(202))
      r.equal(restart.waits, [5, 5])
      // Down the whole minute: it stops trying within it, and the answer is "not yet" (2), not "refused" (1).
      let down = run([.unreachable])
      r.equal(down.outcome, .unreachable)
      r.equal(DisconnectExit.code(down.outcome), 2)
      r.check(down.waits.reduce(0, +) + Double(down.pushes) <= DisconnectExit.patience + 1, "within a minute")
      r.check(down.pushes >= 8, "tried every 5 seconds: \(down.pushes)")
      // The agent's push a moment before (422) or too soon (429): tried again; a refusal is final at once.
      r.equal(run([.status(422), .status(202)]).outcome, .status(202))
      r.equal(run([.status(429), .status(202)]).waits, [6])
      let refused = run([.status(401), .status(202)])
      r.equal(refused.outcome, .status(401))
      r.equal(refused.pushes, 1)
      r.equal(run([.status(404)]).pushes, 1)
    }

    r.test("the chooser's answers: one word each, and a failure line that is a sentence with a domain and a code only") {
      r.equal([ChooserAnswer.connected, .cancelled, .denied, .restricted, .noPrompt, .noToken].map(\.rawValue), ["connected", "cancelled", "denied", "restricted", "noprompt", "notoken"])
      r.equal(UIText.answer(.denied), .denied)
      r.equal(UIText.answer(.writeOnly), .denied)
      r.equal(UIText.answer(.restricted), .restricted)
      // Still undecided after asking: macOS never showed its prompt, so there is no switch in Settings to point to.
      r.equal(UIText.answer(.notDetermined), .noPrompt)
      r.equal(UIText.alert(.notDetermined)?.title, UIText.noPromptTitle)
      r.equal(UIText.alert(.notDetermined)?.buttons, [UIText.close])
      r.equal(UIText.alert(.denied)?.buttons, [UIText.openSettings, UIText.close])
      let line = UIText.failure(.accessRequest, domain: "EKCADErrorDomain", code: 1013)
      r.equal(line, "The access request failed with EKCADErrorDomain error 1013.")
      r.check(sentence(line), line)
      r.equal(UIText.failure(.tokenRead, domain: "NSCocoaErrorDomain", code: 257), "Reading the push token failed with NSCocoaErrorDomain error 257.")
      r.equal(UIText.failure(.tokenRead, domain: "bad domain\n<x>", code: -1), "Reading the push token failed with baddomainx error -1.")
      r.equal(UIText.failure(.tokenRead, domain: "", code: 4), "Reading the push token failed with Unknown error 4.")
    }

    r.test("the log: every line a sentence, counts and codes only") {
      let outcomes: [PushOutcome] = [.status(202), .status(404), .status(409), .status(401), .status(429), .status(422), .status(503), .unreachable, .noToken]
      for o in outcomes {
        let line = LogText.line(o, events: 23, access: .full, next: Backoff.delay(after: o, failures: 1))
        r.check(sentence(line), line)
      }
      r.equal(LogText.line(.status(202), events: 23, access: .full, next: 300), "The runtime accepted 23 events (202); the next read is in 5 minutes.")
      r.equal(LogText.line(.status(202), events: 0, access: .denied, next: 300), "Calendar access is denied, so no events were sent (202); the next read is in 5 minutes.")
      r.equal(LogText.line(.unreachable, events: 1, access: .full, next: 15), "The runtime isn't answering, so Flint Calendar tries again in 15 seconds.")
      r.equal(LogText.line(.noToken, events: 0, access: .full, next: 300), "The push token can't be read, so nothing was sent; Flint Calendar tries again in 5 minutes.")
      r.equal(LogText.duration(60), "1 minute")
    }

    r.test("the byte budget: a snapshot at every cap is cut to fit, says it is not complete, attendees go before events") {
      let full = worst()
      r.check(JSON.bytes(full) > 20 * Wire.maxBytes, "far over the budget")
      let cut = Budget.fit(full)
      r.check(JSON.bytes(cut) <= Wire.maxBytes, "within the budget")
      r.equal(cut.complete, false)
      r.check(cut.events.count > Wire.maxEvents / 2, "most events are kept")
      let withPeople = cut.events.filter { $0.attendees != nil }.map(\.start.rankKey)
      let without = cut.events.filter { $0.attendees == nil }.map(\.start.rankKey)
      r.check(!withPeople.isEmpty, "the earliest keep their attendees")
      r.check((withPeople.max() ?? "") <= (without.min() ?? "~"), "only the earliest keep their attendees")
    }

    r.test("the byte budget cuts the same way whatever the order it was given; the order kept is the one given") {
      let full = worst()
      var shuffled = full
      shuffled.events.reverse()
      let a = Budget.fit(full)
      let b = Budget.fit(shuffled)
      let shape = { (x: WireSnapshot) in x.events.map { "\($0.id):\($0.attendees != nil)" }.sorted() }
      r.equal(shape(a), shape(b))
      r.equal(b.events.map(\.id), a.events.reversed().map(\.id))
    }

    r.test("the byte budget: what fits is sent as it is; past the attendees, events go from the last-ranked") {
      let small = wireSnapshot([wireEvent("a"), wireEvent("b")])
      r.equal(Budget.fit(small), small)
      let p = plain()
      let budget = JSON.bytes(p) / 2
      let cut = Budget.fit(p, budget: budget)
      r.check(JSON.bytes(cut) <= budget, "within")
      r.check(JSON.bytes(cut) + JSON.bytes(p.events[cut.events.count]) + 1 > budget, "and exactly: one more would not fit")
      r.equal(cut.events.map(\.id), Array(p.events.prefix(cut.events.count)).map(\.id))
      r.equal(Budget.fit(p, budget: 10).events, [])
      r.equal(Budget.fit(p, budget: 10).complete, false)
    }

    r.test("a read over the budget is cut by the same rule before it is sent") {
      // 300 events of 100 attendees at the caps: well over 2 MiB as EventKit would give them.
      let events = (0..<300).map { i in
        timed("big\(i)", at(Double(i) * MS_HOUR), at(Double(i) * MS_HOUR + MS_HOUR)) {
          $0.organizerIsCurrentUser = true
          $0.title = String(repeating: "t", count: 300)
          $0.participants = (0..<100).map { j in person("\(String(repeating: "a", count: 236))\(pad6(i * 100 + j))@example.org", String(repeating: "é", count: 100)) }
        }
      }
      let s = read(events)
      r.check(JSON.bytes(s) <= Wire.maxBytes, "within the budget")
      r.equal(s.complete, false)
      r.equal(s.events.count, 300)
      r.check(s.events.first?.attendees != nil && s.events.last?.attendees == nil, "the latest lose their attendees first")
    }
  }
}
