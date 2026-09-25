# Flint — native macOS app

`flint.swift` is a tiny native WKWebView wrapper that opens the Flint console
(`http://localhost:8080`) as a real macOS app — single instance, own icon, own
window, no browser. Built (not committed) into `/Applications/Flint.app`.

Build and install by hand:
```
./apps/desktop-mac/install_app.sh
```
It compiles `flint.swift`, bundles it with `Info.plist` and `flint.icns`, signs
it ad-hoc and replaces `/Applications/Flint.app`. The icon was made from
`../console/app-assets/icon.svg`.

## Updates

On the Studio, `auto_deploy.sh` runs `update_app.sh` on every tick. When this
directory changes on `main`, it rebuilds and installs the app, but only while
Flint.app is closed: if it is open you get one notification, and the first tick
after you quit installs it. A change that fails to build is skipped until the
directory changes again. The console itself is served by the server, so UI
changes reach the app without any of this.

Ad-hoc signing means macOS may ask for the microphone again after an update
that changes `flint.swift`.
