# Flint — native macOS app

`flint.swift` is a tiny native WKWebView wrapper that opens the Flint console
(`http://localhost:8080`) as a real macOS app — single instance, own icon, own
window, no browser. Built (not committed) into `/Applications/Flint.app`.

Build:
```
swiftc -O -o flint flint.swift -framework Cocoa -framework WebKit
# then drop `flint` into Flint.app/Contents/MacOS/, add Info.plist + flint.icns, codesign --sign -
```
Icons come from `../console/app-assets/icon.svg`. The full deploy (icons + bundle
+ launchd services) lives in `~/.flint` on the host.
