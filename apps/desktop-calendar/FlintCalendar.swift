// Flint Calendar (Machine plan P2.6): the small helper that reads Will's Apple
// Calendar for Flint. It has no Dock icon (LSUIElement), runs sandboxed with
// the hardened runtime, and is signed with the stable "Flint Dev" identity, so
// macOS keeps its calendar permission across rebuilds.
//
// One binary, three ways to start:
//  - `--agent`: what the LaunchAgent com.flint.calendar runs (connect.sh loads
//    it). It never asks for anything and never shows anything. Every 300 s, and
//    5 s after the calendar store changes, it reads the next 14 days of the
//    calendars Will ticked and pushes a snapshot to the runtime. Without full
//    access it pushes only the access state. If Will opens the app while the
//    agent runs, the agent opens a fresh copy of itself for the chooser.
//  - no flag: Will opened it (connect.sh's `open`, Finder, Spotlight). The only
//    place it asks macOS for calendar access, then the chooser window. Before it
//    says connected it reads its push token, as the agent will (the sandbox lets
//    it read that one file). It prints one word for connect.sh (ChooserAnswer:
//    connected, cancelled, denied, restricted, noprompt, notoken), and on stderr
//    the error's domain and code when a request or the token read failed.
//  - `--disconnect`: disconnect.sh's. Reads no calendar: it tells the runtime
//    Will disconnected (state revoked, no events), trying for up to a minute
//    while the runtime is down, and exits as DisconnectExit says: 0 told, 3 the
//    source is off or not turned on, 2 not told yet, 1 refused.
//
// Read-only by construction: it calls no EventKit method that writes (no save,
// remove, commit or reset, no write-only or reminders request, no new event or
// calendar). install_calendar.sh refuses to install a source or a binary that
// names one, or that uses the runtime tools that could call one without naming
// it (a selector, class or function pointer made from data, a method called by
// name, another program); its header lists exactly what it checks. It listens
// on nothing: no port, no XPC service, no URL scheme, no AppleScript.
//
// Everything that decides anything is in CalendarCore.swift (pure, tested
// headless); this file only reads EventKit, draws the chooser and sends.

import AppKit
import EventKit

// MARK: - EventKit, as the core reads it

struct EKParticipantView: CalendarParticipant {
  let p: EKParticipant
  var urlString: String? { p.url.absoluteString }
  var displayName: String? { p.name }
  var isCurrentUser: Bool { p.isCurrentUser }
  var status: ParticipantStatus {
    switch p.participantStatus {
    case .pending: return .pending
    case .accepted: return .accepted
    case .declined: return .declined
    case .tentative: return .tentative
    case .delegated: return .delegated
    case .completed: return .completed
    case .inProcess: return .inProcess
    case .unknown: return .unknown
    @unknown default: return .unknown
    }
  }
  var type: ParticipantType {
    switch p.participantType {
    case .person: return .person
    case .room: return .room
    case .resource: return .resource
    case .group: return .group
    case .unknown: return .unknown
    @unknown default: return .unknown
    }
  }
}

struct EKEventView: CalendarEvent {
  let e: EKEvent
  var externalId: String? { e.calendarItemExternalIdentifier }
  var eventId: String? { e.eventIdentifier }
  var occurrenceDate: Date? { e.occurrenceDate }
  var hasRecurrenceRules: Bool { e.hasRecurrenceRules }
  var isDetached: Bool { e.isDetached }
  var title: String? { e.title }
  var isAllDay: Bool { e.isAllDay }
  var startDate: Date? { e.startDate }
  var endDate: Date? { e.endDate }
  var lastModifiedDate: Date? { e.lastModifiedDate }
  var organizerIsCurrentUser: Bool? { e.organizer.map { $0.isCurrentUser } }
  var participants: [CalendarParticipant] { (e.attendees ?? []).map(EKParticipantView.init) }
  var calendarId: String? { e.calendar?.calendarIdentifier }
  var eventStatus: EventStatus {
    switch e.status {
    case .confirmed: return .confirmed
    case .tentative: return .tentative
    case .canceled: return .canceled
    case .none: return .none
    @unknown default: return .none
    }
  }
}

func calendarInfo(_ c: EKCalendar) -> CalendarInfo {
  let kind: CalendarKind
  switch c.type {
  case .local: kind = .local
  case .calDAV: kind = .calDAV
  case .exchange: kind = .exchange
  case .subscription: kind = .subscription
  case .birthday: kind = .birthday
  @unknown default: kind = .calDAV
  }
  let sourceKind: SourceKind
  switch c.source?.sourceType {
  case .some(.local): sourceKind = .local
  case .some(.exchange): sourceKind = .exchange
  case .some(.mobileMe): sourceKind = .mobileMe
  case .some(.subscribed): sourceKind = .subscribed
  case .some(.birthdays): sourceKind = .birthdays
  default: sourceKind = .calDAV
  }
  return CalendarInfo(id: c.calendarIdentifier, title: c.title, kind: kind, sourceKind: sourceKind, sourceTitle: c.source?.title ?? "")
}

/// macOS's answer for this app, read without asking (this never shows a prompt).
func currentAccess() -> Access {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .fullAccess: return .full
  case .writeOnly: return .writeOnly
  case .denied: return .denied
  case .restricted: return .restricted
  case .notDetermined: return .notDetermined
  @unknown default: return .denied
  }
}

// MARK: - Will's choice of calendars (in the app's own container; never sent, only its digest)

enum Choices {
  static let key = "ticks"
  static func load() -> [String: Bool] {
    // The chooser runs as another process: read what it last wrote.
    CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication)
    return UserDefaults.standard.dictionary(forKey: key) as? [String: Bool] ?? [:]
  }
  static func keep(_ ticks: [String: Bool]) {
    UserDefaults.standard.set(ticks, forKey: key)
    CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication)
  }
}

// MARK: - Pushing to the runtime

/// The real home: inside the sandbox NSHomeDirectory() is the app's container, and the token file's exception
/// (FlintCalendar.entitlements) is relative to the real one.
func realHome() -> String {
  if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
  return NSHomeDirectory()
}

/// The push token, read from its file on each use; or why it can't be: the read's error, or nil for a file that
/// holds no token. It goes nowhere but the Authorization header.
func readToken() -> (token: String?, error: NSError?) {
  do {
    let raw = try String(contentsOfFile: realHome() + "/.flint/tokens/apple-calendar.token", encoding: .utf8)
    return (Token.parse(raw), nil)
  } catch {
    return (nil, error as NSError)
  }
}

/// One line on stderr: the chooser's to connect.sh (`open --stderr`), the agent's to calendar.log.
func note(_ s: String) {
  FileHandle.standardError.write(Data("\(s)\n".utf8))
}

final class OutcomeBox: @unchecked Sendable {
  var value: PushOutcome = .unreachable
}

final class Pusher {
  private let session: URLSession
  init() {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 10
    c.timeoutIntervalForResource = 15
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.waitsForConnectivity = false
    session = URLSession(configuration: c)
  }

  /// One push, waited for (never on the main thread). The token is read from its file each time, and goes nowhere else.
  func send(_ s: WireSnapshot) -> PushOutcome {
    guard let token = readToken().token, let url = URL(string: Wire.pushURL) else { return .noToken }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.httpBody = JSON.data(s)
    let done = DispatchSemaphore(value: 0)
    let box = OutcomeBox()
    session.dataTask(with: req) { _, response, _ in
      if let h = response as? HTTPURLResponse { box.value = .status(h.statusCode) }
      done.signal()
    }.resume()
    done.wait()
    return box.value
  }
}

func logLine(_ s: String) {
  let f = DateFormatter()
  f.dateFormat = "yyyy-MM-dd HH:mm:ss"
  note("\(f.string(from: Date())) \(s)")
}

// MARK: - Agent (--agent: launchd's copy; never asks, never shows anything)

final class Agent: NSObject, NSApplicationDelegate {
  /// Every EventKit call and every push happens on this queue, one at a time.
  private let work = DispatchQueue(label: "com.flint.calendar.read")
  private let pusher = Pusher()
  /// Only touched on `work`: one long-lived store, made once access is full, and made again when access changes.
  private var store: EKEventStore?
  private var storeAccess: Access?
  /// Main thread from here on.
  private var lastGeneratedAt: Date?
  private var lastOutcome: PushOutcome?
  private var failures = 0
  private var next: Timer?
  private var debounce: Timer?
  private var nextAt = Date.distantPast
  private var running = false
  private var again = false
  private var lastLogged: (String, Date)?
  private var activity: NSObjectProtocol?
  private var observer: NSObjectProtocol?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Keeps App Nap from stretching the 5-minute timer of a process with no windows; idle sleep is still allowed.
    activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Flint Calendar reads the calendar every 5 minutes.")
    observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
      self?.storeChanged()
    }
    logLine("Flint Calendar started in the background.")
    schedule(after: 2)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  /// Will opened Flint Calendar while this copy runs: the chooser opens in a fresh copy (no --agent), never here.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    let c = NSWorkspace.OpenConfiguration()
    c.createsNewApplicationInstance = true
    c.activates = true
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: c, completionHandler: nil)
    return false
  }

  /// A change in the calendar store: one push 5 s after the last of a burst, unless the runtime said to stay away.
  private func storeChanged() {
    if let o = lastOutcome, !Backoff.changesPushSooner(after: o), Date() < nextAt { return }
    debounce?.invalidate()
    debounce = Timer.scheduledTimer(withTimeInterval: Backoff.debounce, repeats: false) { [weak self] _ in self?.pushNow() }
  }

  private func schedule(after seconds: TimeInterval) {
    next?.invalidate()
    let t = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in self?.pushNow() }
    t.tolerance = min(60, seconds / 10)
    RunLoop.main.add(t, forMode: .common)
    next = t
    nextAt = Date().addingTimeInterval(seconds)
  }

  private func pushNow() {
    debounce?.invalidate()
    debounce = nil
    if running {
      again = true
      return
    }
    running = true
    let ticks = Choices.load()
    let at = Snapshots.generatedAt(now: Date(), last: lastGeneratedAt)
    work.async { [weak self] in
      guard let self = self else { return }
      let (snapshot, access) = self.read(at: at, ticks: ticks)
      let outcome = self.pusher.send(snapshot)
      DispatchQueue.main.async { self.finished(at: at, events: snapshot.events.count, access: access, outcome: outcome) }
    }
  }

  /// On `work`. Only the calendars Will ticked, from now to 14 days on; without full access, only the access state.
  private func read(at: Date, ticks: [String: Bool]) -> (WireSnapshot, Access) {
    let access = currentAccess()
    guard access == .full else {
      store = nil
      storeAccess = access
      return (Snapshots.build(ReadInput(now: at, timeZone: .current, access: access)), access)
    }
    if store == nil || storeAccess != .full { store = EKEventStore() }
    storeAccess = access
    guard let store = store else { return (Snapshots.build(ReadInput(now: at, timeZone: .current, access: .denied)), .denied) }
    let all = store.calendars(for: .event)
    let infos = all.map(calendarInfo)
    let chosen = Set(Calendars.selected(infos, ticks).map(\.id))
    let calendars = all.filter { chosen.contains($0.calendarIdentifier) }
    let w = Snapshots.window(at)
    // No calendars chosen is no events (an empty list would not be read as "none").
    let events = calendars.isEmpty ? [] : store.events(matching: store.predicateForEvents(withStart: w.start, end: w.end, calendars: calendars))
    let input = ReadInput(now: at, timeZone: .current, access: .full, calendars: infos, ticks: ticks, events: events.map(EKEventView.init))
    return (Snapshots.build(input), .full)
  }

  private func finished(at: Date, events: Int, access: Access, outcome: PushOutcome) {
    running = false
    lastGeneratedAt = at
    if Backoff.ok(outcome) {
      failures = 0
    } else if let prev = lastOutcome, Backoff.sameKind(prev, outcome) {
      failures += 1
    } else {
      failures = 1
    }
    lastOutcome = outcome
    let delay = Backoff.delay(after: outcome, failures: failures)
    // One line when something changes, else at most one an hour.
    let kind = "\(outcome) \(access.rawValue)"
    if lastLogged.map({ $0.0 != kind || Date().timeIntervalSince($0.1) > 3600 }) ?? true {
      logLine(LogText.line(outcome, events: events, access: access, next: delay))
      lastLogged = (kind, Date())
    }
    if again && Backoff.changesPushSooner(after: outcome) {
      again = false
      schedule(after: Backoff.debounce)
    } else {
      again = false
      schedule(after: delay)
    }
  }
}

// MARK: - Chooser (no flag: Will opened Flint Calendar; the only place it asks for access)

final class Chooser: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var store: EKEventStore?
  private var window: NSWindow?
  private var boxes: [(row: ChooserRow, box: NSButton)] = []
  private var connectButton: NSButton?
  private var done = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    NSApp.activate()
    let access = currentAccess()
    if access == .notDetermined {
      askForAccess()
    } else {
      show(access)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  /// macOS's own prompt, once, because Will opened Flint Calendar to connect it. Full access to events only.
  /// Refused and still undecided means macOS never asked: the error goes to stderr for connect.sh, by domain and code.
  private func askForAccess() {
    let s = EKEventStore()
    store = s
    s.requestFullAccessToEvents { [weak self] granted, error in
      DispatchQueue.main.async {
        let access = granted ? Access.full : currentAccess()
        if !granted, access == .notDetermined, let e = error as NSError? {
          note(UIText.failure(.accessRequest, domain: e.domain, code: e.code))
        }
        self?.show(access)
      }
    }
  }

  private func show(_ access: Access) {
    NSApp.activate()
    if let a = UIText.alert(access) {
      let alert = NSAlert()
      alert.messageText = a.title
      alert.informativeText = a.text
      for b in a.buttons { alert.addButton(withTitle: b) }
      if alert.runModal() == .alertFirstButtonReturn && a.buttons.first == UIText.openSettings,
         let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars") {
        NSWorkspace.shared.open(url)
      }
      finish(UIText.answer(access))
      return
    }
    // A store made after access was given sees every calendar.
    let s = EKEventStore()
    store = s
    let model = ChooserModel.make(s.calendars(for: .event).map(calendarInfo), ticks: Choices.load())
    present(model)
  }

  private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false, wraps: Bool = false) -> NSTextField {
    let l = wraps ? NSTextField(wrappingLabelWithString: text) : NSTextField(labelWithString: text)
    l.font = .systemFont(ofSize: size, weight: weight)
    if secondary { l.textColor = .secondaryLabelColor }
    return l
  }

  private func present(_ m: ChooserModel) {
    let width: CGFloat = 400
    let list = NSStackView()
    list.orientation = .vertical
    list.alignment = .leading
    list.spacing = 6
    for g in m.groups {
      let header = label(g.header, size: 11, weight: .semibold, secondary: true)
      list.addArrangedSubview(header)
      for row in g.rows {
        let title = row.detail.map { "\(row.title) (\($0))" } ?? row.title
        let box = NSButton(checkboxWithTitle: title, target: self, action: #selector(toggled(_:)))
        box.state = row.ticked ? .on : .off
        list.addArrangedSubview(box)
        boxes.append((row, box))
      }
      if let last = list.arrangedSubviews.last { list.setCustomSpacing(16, after: last) }
    }
    if let empty = m.empty {
      let text = label(empty, wraps: true)
      text.preferredMaxLayoutWidth = width
      list.addArrangedSubview(text)
    }

    // Many calendars scroll; a few do not.
    list.translatesAutoresizingMaskIntoConstraints = false
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    let clip = FlippedClipView()
    clip.drawsBackground = false
    scroll.contentView = clip
    scroll.documentView = list
    NSLayoutConstraint.activate([
      list.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
      list.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
      list.topAnchor.constraint(equalTo: clip.topAnchor),
    ])
    list.layoutSubtreeIfNeeded()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      scroll.widthAnchor.constraint(equalToConstant: width),
      scroll.heightAnchor.constraint(equalToConstant: min(max(list.fittingSize.height, 24), 320)),
    ])

    let cancel = NSButton(title: m.cancel, target: self, action: #selector(cancelled(_:)))
    cancel.keyEquivalent = "\u{1b}"
    let connect = NSButton(title: m.connect, target: self, action: #selector(connected(_:)))
    connect.keyEquivalent = "\r"
    connect.isEnabled = ChooserModel.canConnect([:], rows: boxes.map(\.row))
    connectButton = connect
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let buttons = NSStackView(views: [spacer, cancel, connect])
    buttons.orientation = .horizontal
    buttons.spacing = 8
    buttons.translatesAutoresizingMaskIntoConstraints = false
    buttons.widthAnchor.constraint(equalToConstant: width).isActive = true

    let heading = label(m.heading, size: 15, weight: .bold)
    let intro = label(m.intro, secondary: true, wraps: true)
    intro.preferredMaxLayoutWidth = width
    let footnote = label(m.footnote, size: 11, secondary: true, wraps: true)
    footnote.preferredMaxLayoutWidth = width
    let page = NSStackView(views: [heading, intro, scroll, footnote, buttons])
    page.orientation = .vertical
    page.alignment = .leading
    page.spacing = 12
    page.setCustomSpacing(18, after: intro)
    page.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width + 40, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    w.title = m.windowTitle
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.contentView = page
    w.setContentSize(page.fittingSize)
    w.center()
    window = w
    w.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  @objc private func toggled(_ sender: NSButton) {
    connectButton?.isEnabled = boxes.contains { $0.box.state == .on }
  }

  @objc private func cancelled(_ sender: Any?) {
    finish(.cancelled)
  }

  /// Connect: the token first, read here as the agent will read it (the same app, the same sandbox), so connect.sh
  /// never turns on a source the agent could never push to. Then Will's ticks, under each id and name key.
  @objc private func connected(_ sender: Any?) {
    window?.orderOut(nil)
    let read = readToken()
    guard read.token != nil else {
      if let e = read.error { note(UIText.failure(.tokenRead, domain: e.domain, code: e.code)) }
      tell(UIText.noTokenTitle, UIText.noTokenText)
      finish(.noToken)
      return
    }
    Choices.keep(Calendars.remember(Choices.load(), boxes.map { (row: $0.row, on: $0.box.state == .on) }))
    tell(UIText.connectedTitle, UIText.connectedText)
    finish(.connected)
  }

  private func tell(_ title: String, _ text: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.addButton(withTitle: UIText.ok)
    alert.runModal()
  }

  func windowWillClose(_ notification: Notification) {
    finish(.cancelled)
  }

  /// One word for connect.sh (`open -o` sends it to a file), then quit.
  private func finish(_ answer: ChooserAnswer) {
    guard !done else { return }
    done = true
    print(answer.rawValue)
    fflush(stdout)
    NSApp.terminate(nil)
  }
}

final class FlippedClipView: NSClipView {
  override var isFlipped: Bool { true }
}

// MARK: - Disconnect (--disconnect: disconnect.sh's; reads no calendar)

enum Disconnect {
  static func run() -> Int32 {
    let pusher = Pusher()
    let started = Date()
    var last: Date?
    let outcome = DisconnectExit.run(send: {
      let at = Snapshots.generatedAt(now: Date(), last: last)
      last = at
      return pusher.send(Snapshots.build(ReadInput(now: at, timeZone: .current, access: currentAccess(), state: .revoked)))
    }, wait: { Thread.sleep(forTimeInterval: $0) }, elapsed: { Date().timeIntervalSince(started) })
    print(DisconnectExit.message(outcome))
    return DisconnectExit.code(outcome)
  }
}

// MARK: - Start

@main
struct FlintCalendarMain {
  static func main() {
    let args = CommandLine.arguments
    if args.contains("--disconnect") { exit(Disconnect.run()) }
    let app = NSApplication.shared
    let delegate: NSApplicationDelegate = args.contains("--agent") ? Agent() : Chooser()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
