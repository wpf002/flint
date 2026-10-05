# Flint — native macOS app

`flint.swift` is a tiny native WKWebView wrapper that opens the Flint console
(`http://localhost:8080`) as a real macOS app — single instance, own icon, own
window, no browser. Built (not committed) into `/Applications/Flint.app`.

Build and install by hand:
```
./apps/desktop-mac/install_app.sh
```
It compiles `flint.swift`, bundles it with `Info.plist` and `flint.icns`, signs
it with the stable "Flint Dev" identity (`create_signing_identity.sh` makes it on
first run) and replaces `/Applications/Flint.app`. The icon was made from
`../console/app-assets/icon.svg`.

## Updates

Flint keeps itself current after every merge, with nothing to quit or reload:

- **The app.** On the Studio, `auto_deploy.sh` runs `update_app.sh` on every
  tick. When this directory changes on `main`, it rebuilds and installs the app
  at once, even while it is open. The running app checks every minute whether
  the build on disk is still its own; once it is not, it restarts onto the new
  one at a quiet moment (nothing typed, no panel open, no reply or voice in
  progress, and you in another app or Flint untouched for two minutes). In the
  background it comes back behind your other windows. A change that fails to
  build is skipped until the directory changes again, and the current app is kept.
  The old app quits only once the new one has finished launching; if none comes
  up it stays on its build and tries again in 30 minutes. Each step is logged in
  `~/.flint/app-update.log`.
- **The console.** The server stamps the page's version into it and answers
  `GET /ui-version` with the deployed one. An open console (here or on the
  phone) checks every minute and reloads at a quiet moment once they differ,
  keeping the open conversation.
- **A failed deploy** is retried every 30 minutes, up to 6 times, without
  waiting for the next push (`auto_deploy.sh`, `~/.flint/deploy-retry`).

The stable signature is what keeps the microphone grant across updates: macOS
keys it to the signing certificate, and an ad-hoc signature changes with every
build.

## Approvals

Approval cards are signed with a Secure Enclave key (Touch ID, else the Mac's
password). One prompt approves a whole run of cards, and no prompt appears again
for 5 minutes after it. A card with outside text or money (`fresh: true`) always
prompts on its own. The bridge contract is in the comment above `ApprovalKey` in
`flint.swift`.
