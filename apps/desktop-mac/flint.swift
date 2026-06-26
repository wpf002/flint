import Cocoa
import WebKit

let FLINT_URL = "http://localhost:8080"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!

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
    window.setFrameAutosaveName("FlintMain")
    window.center()

    let cfg = WKWebViewConfiguration()
    web = WKWebView(frame: frame, configuration: cfg)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.autoresizingMask = [.width, .height]
    if #available(macOS 12.0, *) { web.underPageBackgroundColor = .black }
    web.load(URLRequest(url: URL(string: FLINT_URL)!))
    window.contentView = web
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
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
