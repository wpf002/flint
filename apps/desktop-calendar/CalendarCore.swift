// Flint Calendar's pure core (Machine plan P2.6): everything the helper decides,
// with no EventKit and no AppKit, so a plain command-line test runner
// (CalendarCoreTests.swift) checks all of it without a permission, a window or
// a calendar. FlintCalendar.swift is only the glue: it reads EventKit into the
// protocols below, and sends what this file builds.
//
// What it builds is wire v1, the contract in apps/runtime/src/sources/apple/wire.ts
// (golden fixture: apps/runtime/test/fixtures/apple-calendar-snapshot.json):
//  - Compact JSON, keys sorted, no escaped "/", no trailing newline.
//  - Ids are sha256 hex: Apple's external id alone for a single event, and the
//    external id, "|" and the occurrence date for one occurrence of a repeating
//    event (Apple keeps the occurrence date when one occurrence is moved).
//  - Will's answer ("self") is worked out here, where EventKit knows which
//    attendee is him. Attendees are sent only for an event he organized or
//    accepted, never Will himself, never anyone's answer, and only those with a
//    mailto: address. A cancelled event carries no attendees.
//  - All-day events are local days with an exclusive end (Apple's last day ends
//    at 23:59:59). Timed events are UTC instants to the second.
//  - Copies of one event in two calendars collapse into one: the copy with
//    Will's strongest answer is kept, in the place of the first copy.
//  - Outside text (titles, names, addresses) loses its control characters
//    (a NUL would make the runtime refuse the whole snapshot); titles are clipped
//    to 300 and names to 100 UTF-16 units; an address over 254 is dropped.
//  - Over a cap (1000 events, 100 attendees) or the 2 MiB byte budget, the
//    snapshot is cut the same way every time (fitToBudget mirrors the runtime's
//    rule exactly) and says complete:false.

import CryptoKit
import Foundation

// MARK: - What EventKit gives (the glue wraps EKEvent, EKParticipant and EKCalendar in these)

enum ParticipantType: Equatable { case unknown, person, room, resource, group }
enum ParticipantStatus: Equatable { case unknown, pending, accepted, declined, tentative, delegated, completed, inProcess }
enum EventStatus: Equatable { case none, confirmed, tentative, canceled }

protocol CalendarParticipant {
  /// The participant's URL as a string ("mailto:ada@example.com"); anything but mailto: is no address.
  var urlString: String? { get }
  var displayName: String? { get }
  var status: ParticipantStatus { get }
  var type: ParticipantType { get }
  var isCurrentUser: Bool { get }
}

protocol CalendarEvent {
  /// calendarItemExternalIdentifier: the same for an event in every calendar it is in.
  var externalId: String? { get }
  /// eventIdentifier: the fallback when there is no external id.
  var eventId: String? { get }
  /// The original date of this occurrence (kept when one occurrence is moved).
  var occurrenceDate: Date? { get }
  var hasRecurrenceRules: Bool { get }
  var isDetached: Bool { get }
  var eventStatus: EventStatus { get }
  var title: String? { get }
  var isAllDay: Bool { get }
  var startDate: Date? { get }
  var endDate: Date? { get }
  var lastModifiedDate: Date? { get }
  /// nil when the event has no organizer (an event of Will's own with nobody invited).
  var organizerIsCurrentUser: Bool? { get }
  var participants: [CalendarParticipant] { get }
  var calendarId: String? { get }
}

enum CalendarKind: Equatable { case local, calDAV, exchange, subscription, birthday }
enum SourceKind: Equatable { case local, exchange, calDAV, mobileMe, subscribed, birthdays }

/// One calendar as the chooser sees it. Its title and account never leave the Mac.
struct CalendarInfo: Equatable {
  var id: String
  var title: String
  var kind: CalendarKind
  var sourceKind: SourceKind
  var sourceTitle: String
}

// MARK: - The wire (v1)

enum Wire {
  static let version = 1
  static let maxEvents = 1000
  static let maxAttendees = 100
  /// The most a body may be, in UTF-8 bytes as sent (the runtime answers 413 past it).
  static let maxBytes = 2 * 1024 * 1024
  static let titleMax = 300
  static let nameMax = 100
  static let addressMax = 254
  static let windowDays = 14
  /// The runtime listens on [::1] only; "localhost" could resolve to 127.0.0.1, where anything may listen.
  static let pushURL = "http://[::1]:8090/v1/sources/apple_calendar/snapshot"
}

struct WireWhen: Codable, Equatable {
  var at: String?
  var day: String?
  static func instant(_ s: String) -> WireWhen { WireWhen(at: s, day: nil) }
  static func date(_ s: String) -> WireWhen { WireWhen(at: nil, day: s) }
  /// How the cut ranks it: the instant, or the day (which sorts before the times on it).
  var rankKey: String { at ?? day ?? "" }
}

struct WireAttendee: Codable, Equatable {
  var email: String
  var kind: String
  var name: String?
}

struct WireEvent: Codable, Equatable {
  var id: String
  var recurring: Bool
  var status: String
  var title: String
  var start: WireWhen
  var end: WireWhen
  var modifiedAt: String?
  var answer: String
  var attendees: [WireAttendee]?
  enum CodingKeys: String, CodingKey {
    case id, recurring, status, title, start, end, modifiedAt, attendees
    case answer = "self"
  }
}

struct WireWindow: Codable, Equatable {
  var start: String
  var end: String
}

struct WireCalendars: Codable, Equatable {
  var count: Int
  var hash: String
}

struct WireSnapshot: Codable, Equatable {
  var v: Int
  var generatedAt: String
  var access: String
  var state: String
  var window: WireWindow
  var tz: String
  var complete: Bool
  var calendars: WireCalendars
  var events: [WireEvent]
}

enum Access: String { case full, denied, restricted, notDetermined = "not_determined", writeOnly = "write_only" }
enum HelperState: String { case live, revoked }

// MARK: - Encoding

enum JSON {
  static func encoder() -> JSONEncoder {
    let e = JSONEncoder()
    // The runtime's canonical form: by default Swift writes "America\/Chicago".
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }
  static func data<T: Encodable>(_ v: T) -> Data {
    // Every value here is plain strings, numbers and booleans: encoding cannot fail.
    (try? encoder().encode(v)) ?? Data()
  }
  static func string<T: Encodable>(_ v: T) -> String { String(decoding: data(v), as: UTF8.self) }
  /// The body's size as sent: UTF-8 bytes of the compact encoding.
  static func bytes<T: Encodable>(_ v: T) -> Int { data(v).count }
}

enum Hash {
  static func sha256(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: - Times

enum Times {
  private static func utc() -> Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
  }
  /// Whole seconds (the wire's instants carry no fraction).
  static func floorSecond(_ d: Date) -> Date { Date(timeIntervalSince1970: floor(d.timeIntervalSince1970)) }
  /// "2026-10-07T19:00:00Z".
  static func instant(_ d: Date) -> String {
    let c = utc().dateComponents([.year, .month, .day, .hour, .minute, .second], from: floorSecond(d))
    return String(format: "%04d-%02d-%02dT%02d:%02d:%02dZ", c.year!, c.month!, c.day!, c.hour!, c.minute!, c.second!)
  }
  /// The local day `d` falls on in `tz`, as a day number (days since 1970-01-01), and whether it is exactly midnight there.
  static func localDay(_ d: Date, _ tz: TimeZone) -> (day: Int, midnight: Bool) {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = tz
    let p = c.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: d)
    let midnight = p.hour == 0 && p.minute == 0 && p.second == 0 && (p.nanosecond ?? 0) < 1_000_000
    return (daysFromCivil(p.year!, p.month!, p.day!), midnight)
  }
  /// Howard Hinnant's days_from_civil: proleptic Gregorian, no time zone involved.
  static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
  }
  static func civilFromDays(_ z0: Int) -> (Int, Int, Int) {
    let z = z0 + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp + (mp < 10 ? 3 : -9)
    return (m <= 2 ? y + 1 : y, m, d)
  }
  /// "2026-10-07".
  static func dayString(_ n: Int) -> String {
    let (y, m, d) = civilFromDays(n)
    return String(format: "%04d-%02d-%02d", y, m, d)
  }
  /// An all-day event's days: its first local day, and the day after its last (exclusive), as Google writes them.
  /// Apple ends one at 23:59:59 on its last day; an end at exactly midnight is already exclusive.
  static func allDay(start: Date, end: Date, _ tz: TimeZone) -> (start: String, end: String) {
    let s = localDay(start, tz).day
    let e = localDay(end, tz)
    var last = e.midnight && end > start ? e.day : e.day + 1
    if last <= s { last = s + 1 }
    return (dayString(s), dayString(last))
  }
  /// The zone as the wire takes it: a named zone, else UTC. The runtime checks the name with Intl, which takes every
  /// name in this Mac's zone database (aliases such as Asia/Kolkata among them) but "Factory", and no fixed offset:
  /// Foundation names one "GMT+0100" (TimeZone(secondsFromGMT:), or TZ=UTC+5), and every snapshot sent with that
  /// would be refused.
  static func zoneName(_ tz: TimeZone) -> String {
    let id = tz.identifier
    let plain = !id.isEmpty && id.count <= 64 && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "_+/-".unicodeScalars.contains($0) }
    let offset = ["GMT+", "GMT-", "UTC+", "UTC-"].contains { id.hasPrefix($0) }
    let named = TimeZone(identifier: id)?.identifier == id && id != "Factory"
    return plain && !offset && named ? id : "UTC"
  }
}

// MARK: - Outside text

enum Text {
  /// Control characters out: tabs and line breaks become a space, the rest (NUL among them) go.
  static func clean(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for u in s.unicodeScalars {
      switch u.value {
      case 0x09, 0x0A, 0x0B, 0x0C, 0x0D: out.append(" ")
      case 0x00...0x1F, 0x7F: continue
      default: out.append(u)
      }
    }
    return String(out)
  }
  /// At most `n` UTF-16 units, never ending in half a pair (the runtime's clip, exactly).
  static func clip(_ s: String, _ n: Int) -> String {
    let units = Array(s.utf16)
    if units.count <= n { return s }
    var cut = Array(units[0..<n])
    if let last = cut.last, (0xD800...0xDBFF).contains(last) { cut.removeLast() }
    return String(decoding: cut, as: UTF16.self)
  }
  /// A mailto: URL's address, or nil: no other scheme is an address, and one over 254 is dropped, not clipped.
  static func address(_ url: String?) -> String? {
    guard let url = url else { return nil }
    let scheme = "mailto:"
    guard url.count > scheme.count, url.lowercased().hasPrefix(scheme) else { return nil }
    var rest = String(url.dropFirst(scheme.count))
    if let q = rest.firstIndex(of: "?") { rest = String(rest[..<q]) }
    let decoded = clean(rest.removingPercentEncoding ?? rest).trimmingCharacters(in: .whitespaces)
    guard !decoded.isEmpty, decoded.contains("@"), !decoded.contains(" "), decoded.utf16.count <= Wire.addressMax else { return nil }
    return decoded
  }
}

// MARK: - Calendars: which count, and the chooser

enum CalendarSection: String, CaseIterable {
  case iCloud = "ICLOUD"
  case onMyMac = "ON MY MAC"
  case subscribed = "SUBSCRIBED"
  case otherAccounts = "OTHER ACCOUNTS"
  /// Will's own (iCloud and On My Mac) count unless he unticks them; subscriptions and other accounts only if he ticks them.
  var tickedByDefault: Bool { self == .iCloud || self == .onMyMac }
}

enum Calendars {
  /// Where a calendar is listed; nil for one never shown (Birthdays).
  static func section(_ c: CalendarInfo) -> CalendarSection? {
    if c.kind == .birthday || c.sourceKind == .birthdays { return nil }
    if c.kind == .subscription || c.sourceKind == .subscribed { return .subscribed }
    if c.kind == .local || c.sourceKind == .local { return .onMyMac }
    if c.sourceKind == .mobileMe || (c.sourceKind == .calDAV && c.sourceTitle == "iCloud") { return .iCloud }
    return .otherAccounts
  }
  /// A calendar's second key, its account and its title: EventKit gives a calendar a new id after a full sync with
  /// its server (signing out of iCloud and back in, an account rebuilt), and Will's choice must outlive that.
  static func nameKey(_ c: CalendarInfo) -> String { "name:" + Hash.sha256(c.sourceTitle + "\n" + c.title) }
  /// Whether a calendar counts: Will's tick under its id; else his tick under its name key (the same calendar with a
  /// new id); else, for a calendar he has never seen, its section's default. Birthdays never.
  static func ticked(_ c: CalendarInfo, _ ticks: [String: Bool]) -> Bool {
    guard let s = section(c) else { return false }
    return ticks[c.id] ?? ticks[nameKey(c)] ?? s.tickedByDefault
  }
  /// Will's ticks once he clicks Connect: each under its calendar's id and under its name key. Two calendars with
  /// one name key that he ticked differently leave the name key unticked, so a new id never reads one he unticked.
  static func remember(_ old: [String: Bool], _ choices: [(row: ChooserRow, on: Bool)]) -> [String: Bool] {
    var out = old
    var byName: [String: Bool] = [:]
    for c in choices {
      out[c.row.id] = c.on
      byName[c.row.nameKey] = (byName[c.row.nameKey] ?? true) && c.on
    }
    for (k, on) in byName { out[k] = on }
    return out
  }
  static func selected(_ all: [CalendarInfo], _ ticks: [String: Bool]) -> [CalendarInfo] {
    all.filter { ticked($0, ticks) }
  }
  /// What the runtime is told of the choice: a count and a digest of the ids, never a name.
  static func summary(_ selected: [CalendarInfo]) -> WireCalendars {
    let ids = Set(selected.map(\.id)).sorted()
    return WireCalendars(count: ids.count, hash: Hash.sha256(ids.joined(separator: "\n")))
  }
}

struct ChooserRow: Equatable {
  var id: String
  /// Calendars.nameKey, where Will's tick is saved too.
  var nameKey: String
  var title: String
  /// The account, for a calendar under OTHER ACCOUNTS.
  var detail: String?
  var ticked: Bool
}

struct ChooserGroup: Equatable {
  var header: String
  var rows: [ChooserRow]
}

/// The chooser window, as data: the glue draws it and nothing else.
struct ChooserModel: Equatable {
  var windowTitle = UIText.windowTitle
  var heading = UIText.chooserHeading
  var intro = UIText.chooserIntro
  var footnote = UIText.chooserFootnote
  var empty: String?
  var cancel = UIText.cancel
  var connect = UIText.connect
  var groups: [ChooserGroup]

  static func make(_ all: [CalendarInfo], ticks: [String: Bool]) -> ChooserModel {
    var groups: [ChooserGroup] = []
    for s in CalendarSection.allCases {
      let rows = all.filter { Calendars.section($0) == s }
        .map { ChooserRow(id: $0.id, nameKey: Calendars.nameKey($0), title: $0.title.isEmpty ? UIText.untitled : $0.title, detail: s == .otherAccounts ? $0.sourceTitle : nil, ticked: Calendars.ticked($0, ticks)) }
        .sorted { ($0.title.lowercased(), $0.id) < ($1.title.lowercased(), $1.id) }
      if !rows.isEmpty { groups.append(ChooserGroup(header: s.rawValue, rows: rows)) }
    }
    return ChooserModel(empty: groups.isEmpty ? UIText.noCalendars : nil, groups: groups)
  }
  /// Connect needs at least one calendar ticked.
  static func canConnect(_ ticks: [String: Bool], rows: [ChooserRow]) -> Bool {
    rows.contains { ticks[$0.id] ?? $0.ticked }
  }
}

// MARK: - Events into the wire

enum Answer: String {
  case organizer, accepted, tentative, declined
  case needsAction = "needs_action"
  /// For collapsing copies: the copy with the strongest answer is kept.
  var strength: Int {
    switch self {
    case .organizer: return 5
    case .accepted: return 4
    case .tentative: return 3
    case .needsAction: return 2
    case .declined: return 1
    }
  }
  /// Attendees go only with an event Will organized or accepted.
  var meets: Bool { self == .organizer || self == .accepted }
}

enum Events {
  /// Will's answer: declined when his own entry says so (declined or delegated), even on an event he organized, as
  /// the runtime's Google rule has it; else the organizer; else his own entry; else, with nobody invited, his own
  /// event; else (an invitation to an address that isn't his Apple Account's) not answered, which fails safe.
  static func answer(_ e: CalendarEvent) -> Answer {
    let mine = e.participants.first(where: { $0.isCurrentUser })
    if let me = mine, me.status == .declined || me.status == .delegated { return .declined }
    if e.organizerIsCurrentUser == true { return .organizer }
    if let me = mine {
      switch me.status {
      case .accepted: return .accepted
      case .tentative: return .tentative
      case .declined, .delegated: return .declined
      case .unknown, .pending, .completed, .inProcess: return .needsAction
      }
    }
    if e.participants.isEmpty && e.organizerIsCurrentUser == nil { return .organizer }
    return .needsAction
  }

  static func id(_ e: CalendarEvent) -> String? {
    let base = [e.externalId, e.eventId].compactMap { $0 }.first { !$0.isEmpty }
    guard let base = base else { return nil }
    if e.hasRecurrenceRules || e.isDetached {
      guard let occ = e.occurrenceDate ?? e.startDate else { return nil }
      return Hash.sha256("\(base)|\(Times.instant(occ))")
    }
    return Hash.sha256(base)
  }

  static func status(_ s: EventStatus) -> String {
    switch s {
    case .none, .confirmed: return "confirmed"
    case .tentative: return "tentative"
    case .canceled: return "cancelled"
    }
  }

  static func kind(_ t: ParticipantType) -> String {
    switch t {
    case .unknown: return "unknown"
    case .person: return "person"
    case .room: return "room"
    case .resource: return "resource"
    case .group: return "group"
    }
  }

  /// One event on the wire, and whether anything of it was cut (attendees over the cap); nil when it can't be read.
  static func wire(_ e: CalendarEvent, tz: TimeZone) -> (event: WireEvent, cut: Bool)? {
    guard let id = id(e), let start = e.startDate, let end0 = e.endDate else { return nil }
    let answer = answer(e)
    let status = status(e.eventStatus)
    let (s, en): (WireWhen, WireWhen)
    if e.isAllDay {
      let d = Times.allDay(start: start, end: end0, tz)
      (s, en) = (.date(d.start), .date(d.end))
    } else {
      let end = end0 < start ? start : end0
      (s, en) = (.instant(Times.instant(start)), .instant(Times.instant(end)))
    }
    var attendees: [WireAttendee]?
    var cut = false
    if answer.meets && status != "cancelled" {
      var people: [WireAttendee] = []
      for p in e.participants where !p.isCurrentUser {
        guard let email = Text.address(p.urlString) else { continue }
        let name = p.displayName.map { Text.clip(Text.clean($0), Wire.nameMax) }
        people.append(WireAttendee(email: email, kind: kind(p.type), name: (name?.isEmpty ?? true) ? nil : name))
      }
      if people.count > Wire.maxAttendees {
        people = Array(people.prefix(Wire.maxAttendees))
        cut = true
      }
      attendees = people.isEmpty ? nil : people
    }
    let event = WireEvent(
      id: id, recurring: e.hasRecurrenceRules || e.isDetached, status: status,
      title: Text.clip(Text.clean(e.title ?? ""), Wire.titleMax), start: s, end: en,
      modifiedAt: e.lastModifiedDate.map(Times.instant), answer: answer.rawValue, attendees: attendees)
    return (event, cut)
  }

  /// The cut's order: by start, then id (plain character order, as the runtime compares).
  static func ranksBefore(_ a: WireEvent, _ b: WireEvent) -> Bool {
    a.start.rankKey != b.start.rankKey ? a.start.rankKey < b.start.rankKey : a.id < b.id
  }
}

/// What one read gives the core.
struct ReadInput {
  var now: Date
  var timeZone: TimeZone
  var access: Access
  var state: HelperState = .live
  /// Every calendar the store has (empty without full access).
  var calendars: [CalendarInfo] = []
  var ticks: [String: Bool] = [:]
  /// What EventKit returned for the window and the selected calendars.
  var events: [CalendarEvent] = []
  /// The last generatedAt sent, so each is strictly newer than the one before.
  var lastGeneratedAt: Date?
}

enum Snapshots {
  /// Now, to the second, and always after the last one sent.
  static func generatedAt(now: Date, last: Date?) -> Date {
    let t = Times.floorSecond(now)
    guard let last = last, t <= last else { return t }
    return Times.floorSecond(last).addingTimeInterval(1)
  }
  /// The window EventKit is asked for: now to 14 days on.
  static func window(_ at: Date) -> (start: Date, end: Date) {
    (at, at.addingTimeInterval(TimeInterval(Wire.windowDays * 86_400)))
  }

  static func build(_ r: ReadInput) -> WireSnapshot {
    let at = generatedAt(now: r.now, last: r.lastGeneratedAt)
    let w = window(at)
    let live = r.state == .live && r.access == .full
    let chosen = live ? Calendars.selected(r.calendars, r.ticks) : []
    let chosenIds = Set(chosen.map(\.id))
    var complete = true
    var events: [WireEvent] = []
    var place: [String: Int] = [:]
    if live {
      for e in r.events {
        // Only the calendars Will chose, whatever the query returned.
        guard let cal = e.calendarId, chosenIds.contains(cal) else { continue }
        guard let read = Events.wire(e, tz: r.timeZone) else { complete = false; continue }
        let x = read.event
        if read.cut { complete = false }
        if let i = place[x.id] {
          // The same event in two calendars: Will's strongest answer wins, in the first copy's place.
          if (Answer(rawValue: x.answer)?.strength ?? 0) > (Answer(rawValue: events[i].answer)?.strength ?? 0) { events[i] = x }
        } else {
          place[x.id] = events.count
          events.append(x)
        }
      }
      if events.count > Wire.maxEvents {
        // The earliest 1000 (by start, then id), in the order they came.
        let keep = Set(events.sorted(by: Events.ranksBefore).prefix(Wire.maxEvents).map(\.id))
        events = events.filter { keep.contains($0.id) }
        complete = false
      }
    }
    let s = WireSnapshot(
      v: Wire.version, generatedAt: Times.instant(at), access: r.access.rawValue, state: r.state.rawValue,
      window: WireWindow(start: Times.instant(w.start), end: Times.instant(w.end)), tz: Times.zoneName(r.timeZone),
      complete: complete, calendars: Calendars.summary(chosen), events: events)
    return Budget.fit(s)
  }
}

// MARK: - The byte budget (the runtime's fitToBudget, mirrored exactly)

enum Budget {
  /// A snapshot that fits is sent as it is. One that does not says complete:false and is cut the same way every
  /// time: ranked by start, then id; from the last-ranked back, each event's attendees go (all of them, one event
  /// at a time) until it fits; then, if it still does not, the last-ranked events go until it does. What is left
  /// keeps its order.
  static func fit(_ s: WireSnapshot, budget: Int = Wire.maxBytes) -> WireSnapshot {
    if JSON.bytes(s) <= budget { return s }
    var events = s.events
    // Last-ranked first; equal ranks keep their order, as the runtime's stable sort does.
    let cut = events.indices.sorted { a, b in
      if Events.ranksBefore(events[b], events[a]) { return true }
      if Events.ranksBefore(events[a], events[b]) { return false }
      return a < b
    }
    var empty = s
    empty.complete = false
    empty.events = []
    let base = JSON.bytes(empty)
    var size = events.map { JSON.bytes($0) }
    var kept = events.count
    // The body is the envelope, each event, and a comma between two.
    var total = base + size.reduce(0, +) + max(0, kept - 1)
    for i in cut {
      if total <= budget { break }
      if events[i].attendees == nil { continue }
      events[i].attendees = nil
      let n = JSON.bytes(events[i])
      total += n - size[i]
      size[i] = n
    }
    var dropped = Set<Int>()
    for i in cut {
      if total <= budget { break }
      dropped.insert(i)
      total -= size[i] + (kept > 1 ? 1 : 0)
      kept -= 1
    }
    var out = s
    out.complete = false
    out.events = events.indices.filter { !dropped.contains($0) }.map { events[$0] }
    return out
  }
}

// MARK: - Pushing: the token, what each answer means, and when to try again

enum Token {
  /// The push token as install-runtime.sh writes it: 64 hex digits (a newline after is fine).
  static func parse(_ raw: String?) -> String? {
    guard let t = raw?.trimmingCharacters(in: .whitespacesAndNewlines), t.count == 64,
          t.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else { return nil }
    return t
  }
}

enum PushOutcome: Equatable {
  /// The runtime answered with this status.
  case status(Int)
  /// No answer: the runtime is restarting, or not running.
  case unreachable
  /// Nothing was sent: the token file is missing or not a token.
  case noToken
}

enum Backoff {
  /// The steps for a runtime that is down or failing: 15 s, 30 s, 60 s, then up to 5 minutes.
  static let ladder: [TimeInterval] = [15, 30, 60, 120, 240, 300]
  static let heartbeat: TimeInterval = 300
  static let debounce: TimeInterval = 5

  /// How long until the next push, after `outcome`, the `failures`-th in a row of its kind (1 for the first).
  static func delay(after outcome: PushOutcome, failures: Int) -> TimeInterval {
    let step = ladder[min(max(failures, 1), ladder.count) - 1]
    switch outcome {
    case .noToken: return heartbeat
    case .unreachable: return step
    case .status(let code):
      switch code {
      case 200..<300: return heartbeat
      // Not turned on yet: keep the 5-minute pushes, so the first run after Will approves the card has a snapshot.
      case 409: return heartbeat
      // The source is off, or a runtime that is restarting to turn it on still answered: try again as usual.
      case 404: return heartbeat
      // The token was refused: install-runtime.sh may be writing a new one; it is read again on each push.
      case 401, 403: return 30 * 60
      case 429: return 10
      // A body the runtime would not take: the next read may differ.
      case 400, 413, 422: return heartbeat
      case 500..<600: return step
      default: return heartbeat
      }
    }
  }
  /// Whether a calendar change may push before the delay is up (not while the runtime refuses the token).
  static func changesPushSooner(after outcome: PushOutcome) -> Bool {
    if case .status(let code) = outcome { return ![401, 403].contains(code) }
    return true
  }
  /// Two outcomes are the same kind of failure (for counting failures in a row).
  static func sameKind(_ a: PushOutcome, _ b: PushOutcome) -> Bool {
    switch (a, b) {
    case (.unreachable, .unreachable), (.noToken, .noToken): return true
    case (.status(let x), .status(let y)): return (500..<600).contains(x) ? (500..<600).contains(y) : x == y
    default: return false
    }
  }
  static func ok(_ o: PushOutcome) -> Bool {
    if case .status(let code) = o { return (200..<300).contains(code) }
    return false
  }
}

/// What --disconnect exits with, for disconnect.sh: 0 told (202); 3 nothing to tell (the source is off or not
/// turned on, so Flint holds no Apple events to archive); 2 not told yet (the runtime was down, restarting or
/// failing for the whole minute, or the token couldn't be read), so the source stays on and Will runs it again;
/// 1 refused (the runtime said no to the token or the snapshot), so his Apple events stay as they were last read.
enum DisconnectExit {
  /// How long --disconnect keeps trying before it gives up for now.
  static let patience: TimeInterval = 60

  static func code(_ o: PushOutcome) -> Int32 {
    if Backoff.ok(o) { return 0 }
    if case .status(let code) = o, code == 404 || code == 409 { return 3 }
    return notYet(o) ? 2 : 1
  }
  /// A push that may land if it is tried again later: no answer, no token read, a 5xx, or a 429.
  static func notYet(_ o: PushOutcome) -> Bool {
    switch o {
    case .unreachable, .noToken: return true
    case .status(let code): return code == 429 || (500..<600).contains(code)
    }
  }
  /// How long to wait before the revoked push is tried again, or nil to stop: 5 s while the runtime is down, failing
  /// or restarting, and 6 s after a 429 or a 422 (a push the agent made a moment before).
  static func retry(_ o: PushOutcome) -> TimeInterval? {
    if case .status(let code) = o, code == 429 || code == 422 { return 6 }
    return notYet(o) ? 5 : nil
  }
  /// The revoked push, tried again while retry says so and the next try still starts within `patience`. The push,
  /// the wait and the clock are given, so the core tests run it with fakes.
  static func run(send: () -> PushOutcome, wait: (TimeInterval) -> Void, elapsed: () -> TimeInterval) -> PushOutcome {
    var outcome = send()
    while let pause = retry(outcome), elapsed() + pause <= patience {
      wait(pause)
      outcome = send()
    }
    return outcome
  }
  /// What disconnect.sh shows Will.
  static func message(_ o: PushOutcome) -> String {
    switch code(o) {
    case 0: return "Flint was told that Apple Calendar is disconnected."
    case 3: return "The Apple Calendar source is off in Flint, so there was nothing to tell it."
    case 2: return "Flint couldn't be told yet that Apple Calendar is disconnected, because \(LogText.reason(o))."
    default: return "Flint couldn't be told that Apple Calendar is disconnected, because \(LogText.reason(o))."
    }
  }
}

// MARK: - Words (Will's rule: titles and buttons in Title Case; every other line a complete, concise sentence)

enum UIText {
  static let windowTitle = "Flint Calendar"
  static let chooserHeading = "Choose Your Calendars"
  static let chooserIntro = "Flint reads the next two weeks of the calendars you tick. It never changes your events."
  static let chooserFootnote = "Calendar names stay on this Mac."
  static let noCalendars = "This Mac has no calendars yet. Turn on Calendars for iCloud in System Settings, then open Flint Calendar again."
  static let untitled = "Untitled"
  static let cancel = "Cancel"
  static let connect = "Connect"
  static let ok = "OK"
  static let close = "Close"
  static let openSettings = "Open Settings"

  static let connectedTitle = "Apple Calendar Is Connected"
  static let connectedText = "Flint reads the calendars you ticked every 5 minutes and whenever they change."
  static let accessOffTitle = "Calendar Access Is Off"
  static let accessOffText = "Flint Calendar can't read your calendar until you turn it on in System Settings > Privacy & Security > Calendars."
  static let writeOnlyTitle = "Full Access Is Needed"
  static let writeOnlyText = "Flint Calendar can only add events right now, so it can't read them. Choose Full Access for it in System Settings > Privacy & Security > Calendars."
  static let restrictedTitle = "Calendar Access Is Restricted"
  static let restrictedText = "This Mac's settings don't let Flint Calendar read calendars."
  /// macOS answered the request without showing its prompt, so Flint Calendar isn't listed in Settings either.
  static let noPromptTitle = "The Calendar Prompt Didn't Appear"
  static let noPromptText = "Flint Calendar asked for access to your calendar, but macOS didn't show its prompt."
  /// The sandbox kept Flint Calendar from reading its push token (its one file outside the sandbox).
  static let noTokenTitle = "Flint Calendar Can't Read Its Token"
  static let noTokenText = "Flint Calendar can't read the token it needs to send your calendar to Flint."

  /// Every title and button, for the Title Case check.
  static let titles = [windowTitle, chooserHeading, untitled, cancel, connect, ok, close, openSettings, connectedTitle, accessOffTitle, writeOnlyTitle, restrictedTitle, noPromptTitle, noTokenTitle]
  /// Every secondary line, for the sentence check.
  static let sentences = [chooserIntro, chooserFootnote, noCalendars, connectedText, accessOffText, writeOnlyText, restrictedText, noPromptText, noTokenText]

  /// The alert Will sees for each access state when he opens Flint Calendar; nil for full access (the chooser shows).
  /// Still undecided after the request means macOS never asked: there is no switch in Settings to send him to.
  static func alert(_ a: Access) -> (title: String, text: String, buttons: [String])? {
    switch a {
    case .full: return nil
    case .denied: return (accessOffTitle, accessOffText, [openSettings, close])
    case .notDetermined: return (noPromptTitle, noPromptText, [close])
    case .writeOnly: return (writeOnlyTitle, writeOnlyText, [openSettings, close])
    case .restricted: return (restrictedTitle, restrictedText, [close])
    }
  }
  /// The word the chooser prints for an access state it can't read with.
  static func answer(_ a: Access) -> ChooserAnswer {
    switch a {
    case .restricted: return .restricted
    case .notDetermined: return .noPrompt
    case .full, .denied, .writeOnly: return .denied
    }
  }
  /// What failed, for one line on the chooser's stderr (connect.sh shows it): an error's domain and code, never more.
  enum Failure: String {
    case accessRequest = "The access request"
    case tokenRead = "Reading the push token"
  }
  static func failure(_ what: Failure, domain: String, code: Int) -> String {
    let d = String(String.UnicodeScalarView(domain.unicodeScalars.filter { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "_" || $0 == "." }).prefix(100))
    return "\(what.rawValue) failed with \(d.isEmpty ? "Unknown" : d) error \(code)."
  }
}

/// The one word Flint Calendar prints when Will closes the chooser, for connect.sh (`open -o` writes it to a file).
enum ChooserAnswer: String {
  case connected, cancelled, denied, restricted
  /// macOS answered the request without asking Will.
  case noPrompt = "noprompt"
  /// The sandbox kept Flint Calendar from reading its push token.
  case noToken = "notoken"
}

/// The helper's log (~/.flint/calendar.log): one sentence a push, with counts, the access state and HTTP codes,
/// never a title, a name, an address or the token.
enum LogText {
  static func duration(_ t: TimeInterval) -> String {
    let s = Int(t.rounded())
    if s < 60 { return s == 1 ? "1 second" : "\(s) seconds" }
    let m = s / 60
    return m == 1 ? "1 minute" : "\(m) minutes"
  }

  /// Why a push did not land, in a few words.
  static func reason(_ o: PushOutcome) -> String {
    switch o {
    case .noToken: return "the push token can't be read"
    case .unreachable: return "the runtime isn't answering"
    case .status(let code): return "the runtime answered \(code)"
    }
  }

  static func line(_ o: PushOutcome, events: Int, access: Access, next: TimeInterval) -> String {
    let again = duration(next)
    let what = events == 1 ? "1 event" : "\(events) events"
    switch o {
    case .noToken:
      return "The push token can't be read, so nothing was sent; Flint Calendar tries again in \(again)."
    case .unreachable:
      return "The runtime isn't answering, so Flint Calendar tries again in \(again)."
    case .status(let code):
      switch code {
      case 200..<300:
        return access == .full
          ? "The runtime accepted \(what) (\(code)); the next read is in \(again)."
          : "Calendar access is \(access.rawValue.replacingOccurrences(of: "_", with: " ")), so no events were sent (\(code)); the next read is in \(again)."
      case 404: return "The runtime has the Apple Calendar source off (404), so Flint Calendar tries again in \(again)."
      case 409: return "The Apple Calendar source isn't turned on yet (409), so Flint Calendar tries again in \(again)."
      case 401, 403: return "The runtime refused the push token (\(code)), so Flint Calendar tries again in \(again)."
      case 429: return "The runtime asked Flint Calendar to slow down (429), so it tries again in \(again)."
      case 400, 413, 422: return "The runtime refused the snapshot (\(code)), so Flint Calendar reads again in \(again)."
      default: return "The runtime answered \(code), so Flint Calendar tries again in \(again)."
      }
    }
  }
}
