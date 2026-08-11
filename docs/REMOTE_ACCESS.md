# Control Flint from your laptop (no monitor on the Studio)

Set this up on the Mac Studio during/after setup. Then you run and reprogram
Flint from your laptop anywhere, and the Studio can live headless.

## 1. Turn on remote access (on the Studio, once)
System Settings → General → Sharing → enable:
- **Remote Login** (SSH) — lets your laptop run commands / edit code.
- **Screen Sharing** — lets you see the Studio's screen from your laptop.
Or via terminal (needs your password):
```
sudo systemsetup -setremotelogin on
sudo launchctl enable system/com.apple.screensharing && \
  sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist
```

## 2. Reach it from anywhere: Tailscale (already how Flint is exposed)
Install Tailscale on the Studio and sign in (same account as your laptop):
```
brew install --cask tailscale   # then sign in via the menubar app
```
Now the Studio has a stable name on your private network (e.g. `studio`), reachable
from your laptop/phone anywhere — no port-forwarding, encrypted.

## 3. From your laptop
- **Talk to Flint (UI):** open `http://studio:8080` (or the Tailscale URL). Same
  console you use now.
- **Reprogram Flint (code):** `ssh willfoti@studio` — then edit the repo and run
  `./apps/server/install-server.sh` to rebuild/redeploy. Or point Claude Code /
  VS Code Remote-SSH at `willfoti@studio` and work as if you were sitting at it.
- **See the desktop:** open Screen Sharing.app → connect to `studio`.

## 4. Result
The Studio sits in a closet (power + network only). You run Flint, watch him,
and change his programming entirely from your laptop — exactly like this session,
just pointed at the new machine.
