import Cocoa
import WebKit
import CryptoKit
import LocalAuthentication

let FLINT_URL = "http://localhost:8080"

/// Will's approval key on this Mac (Machine plan 3.0.2): a P-256 key inside the
/// Secure Enclave that signs only after Touch ID or the Mac's password
/// (.userPresence: a keyboard whose Touch ID is not paired, or no fingerprint
/// enrolled, must not make the key impossible to create). The private key never leaves
/// the enclave; what is stored in ~/.flint/approval-key.se is the enclave's
/// encrypted handle, usable by this Mac's enclave alone. The console reaches it
/// through the `flintApproval` script handler, which answers only pages from
/// FLINT_URL, and every Touch ID prompt says what is being approved.
final class ApprovalKey: NSObject, WKScriptMessageHandlerWithReply {
  let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".flint/approval-key.se")

  static func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  static func unb64url(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }

  func load(_ ctx: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey? {
    guard let blob = try? Data(contentsOf: file) else { return nil }
    return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
  }

  func create() throws -> SecureEnclave.P256.Signing.PrivateKey {
    var err: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err) else {
      throw err!.takeRetainedValue() as Error
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try key.dataRepresentation.write(to: file, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    return key
  }

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    // Only the Flint console may ask.
    let origin = message.frameInfo.securityOrigin
    guard let flint = URL(string: FLINT_URL), origin.protocol == flint.scheme, origin.host == flint.host, origin.port == (flint.port ?? 0) else {
      return replyHandler(nil, "not allowed from this page")
    }
    guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return replyHandler(nil, "bad request") }
    do {
      switch op {
      case "status":
        replyHandler(["available": SecureEnclave.isAvailable, "hasKey": FileManager.default.fileExists(atPath: file.path)], nil)
      case "publicKey":
        let key = try load() ?? create()
        replyHandler(["publicKey": ApprovalKey.b64url(key.publicKey.derRepresentation)], nil)
      case "reset":
        // A lost or unwanted key is replaced here, after Touch ID or Will's
        // password; the new key still has to be enrolled (an existing key's
        // approval, or a replace code from `enroll --replace`).
        let ctx = LAContext()
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "replace Flint's approval key on this Mac") { ok, _ in
          DispatchQueue.main.async {
            guard ok else { return replyHandler(nil, "not confirmed") }
            do {
              try? FileManager.default.removeItem(at: self.file)
              let key = try self.create()
              replyHandler(["publicKey": ApprovalKey.b64url(key.publicKey.derRepresentation)], nil)
            } catch {
              replyHandler(nil, "approval key: \(error.localizedDescription)")
            }
          }
        }
      case "sign":
        guard let c = body["challenge"] as? String, let challenge = ApprovalKey.unb64url(c), challenge.count == 32 else {
          return replyHandler(nil, "bad challenge")
        }
        let what = (body["reason"] as? String).map { String($0.prefix(140)) } ?? "approve an action"
        let ctx = LAContext()
        ctx.localizedReason = what
        guard let key = try load(ctx) else { return replyHandler(nil, "no approval key on this Mac yet") }
        // CryptoKit hashes with SHA-256 and signs: what the server's verifySecureEnclave checks.
        let sig = try key.signature(for: challenge)
        replyHandler(["signature": ApprovalKey.b64url(sig.derRepresentation)], nil)
      default:
        replyHandler(nil, "unknown op")
      }
    } catch {
      replyHandler(nil, "approval key: \(error.localizedDescription)")
    }
  }
}

/// Which build is on disk: update_app.sh installs a new one over the running app.
struct BuildStamp: Equatable {
  let file: Int
  let modified: Date
  static func current() -> BuildStamp? {
    guard let path = Bundle.main.executablePath,
          let a = try? FileManager.default.attributesOfItem(atPath: path),
          let file = (a[.systemFileNumber] as? NSNumber)?.intValue,
          let modified = a[.modificationDate] as? Date else { return nil }
    return BuildStamp(file: file, modified: modified)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!
  let approvalKey = ApprovalKey()
  /// The build this process runs, and whether it is already restarting onto a newer one.
  let launchedBuild = BuildStamp.current()
  var relaunching = false

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    let frame = NSRect(x: 0, y: 0, width: 1280, height: 860)
    window = NSWindow(contentRect: frame,
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Flint"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.backgroundColor = .black
    window.isMovableByWindowBackground = true
    // Where Will left it (centered only the first time), also after a restart onto a new build.
    if !window.setFrameUsingName("FlintMain") { window.center() }
    window.setFrameAutosaveName("FlintMain")

    let cfg = WKWebViewConfiguration()
    cfg.userContentController.addScriptMessageHandler(approvalKey, contentWorld: .page, name: "flintApproval")
    web = WKWebView(frame: frame, configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.autoresizingMask = [.width, .height]
    if #available(macOS 12.0, *) { web.underPageBackgroundColor = .black }
    web.load(URLRequest(url: URL(string: FLINT_URL)!))
    window.contentView = web
    // Restarted onto a new build: come back as the old window was (behind, minimized or
    // hidden) when Will was elsewhere, in front only when it was in front.
    let args = CommandLine.arguments
    if args.contains("--relaunched-minimized") {
      window.orderBack(nil)
      window.miniaturize(nil)
    } else if args.contains("--relaunched-hidden") {
      window.orderBack(nil)
      NSApp.hide(nil)
    } else if args.contains("--relaunched-background") {
      window.orderBack(nil)
    } else {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
    // update_app.sh reads this to know the open app restarts itself onto a new build.
    let pidFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".flint/app-pid")
    try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(to: pidFile, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pidFile.path)
    Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.checkForNewBuild() }
  }

  /// Auto-update: once the build on disk is not the one running, restart onto it at
  /// a quiet moment. Quiet is the console's flintIdle(): nothing typed or attached,
  /// no panel open, no reply, voice or approval in progress; no sheet or modal of
  /// the app's own (the file chooser) open; not full screen or on another Space;
  /// and Will in another app, or Flint untouched for two minutes. It restarts only once flintSnapshot() has kept
  /// the open conversation (localStorage, which the new instance reads).
  func checkForNewBuild() {
    guard !relaunching, let was = launchedBuild, let now = BuildStamp.current(), now != was else { return }
    guard window.attachedSheet == nil, NSApp.modalWindow == nil else { return }
    // A new window comes back as a plain one on the current Space: wait until Flint
    // is out of full screen and on this Space (or minimized or hidden, which it keeps).
    guard !window.styleMask.contains(.fullScreen), window.isOnActiveSpace || window.isMiniaturized || NSApp.isHidden else { return }
    let away = !NSApp.isActive
    let js = "typeof flintIdle==='function'&&flintIdle(\(away ? 0 : 120000))&&flintSnapshot()===true"
    web.evaluateJavaScript(js) { [weak self] result, _ in
      if (result as? Bool) == true { self?.relaunch(front: !away) }
    }
  }

  func relaunch(front: Bool) {
    guard !relaunching else { return }
    relaunching = true
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.createsNewApplicationInstance = true
    cfg.activates = front
    if window.isMiniaturized {
      cfg.arguments = ["--relaunched-minimized"]
    } else if NSApp.isHidden {
      cfg.arguments = ["--relaunched-hidden"]
    } else if !front {
      cfg.arguments = ["--relaunched-background"]
    }
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { app, _ in
      DispatchQueue.main.async {
        if app != nil { NSApp.terminate(nil) } else { self.relaunching = false }
      }
    }
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let app = NSMenu()
    app.addItem(withTitle: "About Flint", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Reload", action: #selector(reloadFlint), keyEquivalent: "r")
    app.addItem(.separator())
    app.addItem(withTitle: "Hide Flint", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(withTitle: "Quit Flint", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = app
    // Edit menu so cut/copy/paste/select-all work in the chat box.
    let editItem = NSMenuItem(); main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    NSApp.mainMenu = main
  }
  @objc func reloadFlint() { web.reload() }

  // Grant the web view microphone access so in-app voice works (the app holds
  // the NSMicrophoneUsageDescription; macOS still prompts once at the OS level).
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(.grant)
  }

  // <input type="file"> does nothing in a WKWebView on macOS unless the host
  // shows the open panel itself — this is what makes the console's paperclip
  // (attach images / PDFs / text files) work in the app, not just in Safari.
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { resp in
      completionHandler(resp == .OK ? panel.urls : nil)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { window.makeKeyAndOrderFront(nil) }
    NSApp.activate(ignoringOtherApps: true)
    return true
  }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { retry() }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { retry() }
  func retry() { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    self.web.load(URLRequest(url: URL(string: FLINT_URL)!)) } }
}

let nsapp = NSApplication.shared
let delegate = AppDelegate()
nsapp.delegate = delegate
nsapp.setActivationPolicy(.regular)
nsapp.run()
