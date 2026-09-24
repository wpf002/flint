#!/bin/zsh
# Run AFTER you've installed Tailscale + signed in. Exposes always-on Flint on a
# stable tailnet HTTPS name and retires the temporary cloudflared tunnel.
#
# Flint runs its own userspace tailscaled (com.flint.tailscaled) on a private socket,
# so every CLI call must pass --socket or it talks to a different (or no) daemon.
# The Tailscale.app binary is deliberately not used: it only speaks to the app's daemon.
TS_BIN="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"
TS_SOCK="$HOME/.flint/tailscaled.sock"
ts() { "$TS_BIN" --socket="$TS_SOCK" "$@"; }
if [ ! -x "$TS_BIN" ] || ! ts status >/dev/null 2>&1; then
  echo "Tailscale not ready — check com.flint.tailscaled is running and signed in ($TS_SOCK), then re-run this."; exit 1
fi
echo "Tailscale is up. Serving Flint (:8080) on the tailnet..."
ts serve --bg 8080 || { echo "serve failed — in the Tailscale admin console enable MagicDNS + HTTPS, then re-run."; exit 1; }
NAME="$(ts status --json 2>/dev/null | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)"
echo "https://$NAME" > ~/.flint/tailscale-url.txt
echo "STABLE URL: https://$NAME"
# retire the cloudflared quick tunnel (no longer needed)
TUNNEL=~/Library/LaunchAgents/com.flint.tunnel.plist
[ -f "$TUNNEL" ] && launchctl unload "$TUNNEL" 2>/dev/null && echo "cloudflared tunnel retired."
echo "Done. Reach Flint from any device on your tailnet at: https://$NAME"
