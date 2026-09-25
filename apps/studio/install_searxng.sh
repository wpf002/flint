#!/bin/zsh
# install_searxng.sh — a private, keyless search backend for Flint's web_search.
#
# Installs SearXNG from its official repo (github.com/searxng/searxng) into
# ~/searxng with a uv venv, writes a loopback-only settings.yml with a secret
# generated here, and loads a LaunchAgent (com.flint.searxng) that keeps it
# serving on 127.0.0.1:8888. Then point the web connector at it:
# SEARCH_PROVIDER=auto in ~/.flint/mcp.json (see "Keyless search" in README.md).
#
#   ./apps/studio/install_searxng.sh               install or repair, then (re)load the agent
#   ./apps/studio/install_searxng.sh --update      also pull the latest SearXNG and reinstall
#   ./apps/studio/install_searxng.sh --no-launchd  install only; prints the foreground command
#
# Idempotent: a re-run keeps the checkout, the venv and the installed packages
# when nothing changed, and NEVER touches an existing settings.yml. That file
# holds this instance's secret; delete it yourself to get a fresh one.
#
# Env: SEARXNG_HOME (default ~/searxng)  SEARXNG_PORT (default 8888)
#      SEARXNG_REPO (default https://github.com/searxng/searxng)
#      SEARXNG_PYTHON (default 3.12; uv fetches it if missing)
set -euo pipefail

STUDIO="${0:A:h}"
DIR="${SEARXNG_HOME:-$HOME/searxng}"
PORT="${SEARXNG_PORT:-8888}"
GIT_URL="${SEARXNG_REPO:-https://github.com/searxng/searxng}"
PY="${SEARXNG_PYTHON:-3.12}"
LABEL="com.flint.searxng"
SRC="$DIR/src"
VENV="$DIR/venv"
SETTINGS="$DIR/settings.yml"
RENDERED="$DIR/$LABEL.plist"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"

UPDATE=0
LAUNCHD=1
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --no-launchd) LAUNCHD=0 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

say() { print -r -- "$*"; }
die() { say "✗ $*" >&2; exit 1; }

[[ "$PORT" == <1024-65535> ]] || die "SEARXNG_PORT must be a port number (got $PORT)"
UV="$(command -v uv || true)"
[ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
[ -n "$UV" ] || die "uv not found: brew install uv (or https://docs.astral.sh/uv/)"
command -v git >/dev/null || die "git not found"
command -v openssl >/dev/null || die "openssl not found"
mkdir -p "$DIR/logs"
CHANGED=0

# ---- 1. source -------------------------------------------------------------
if [ -d "$SRC/.git" ]; then
  if [ "$UPDATE" = 1 ]; then
    before="$(git -C "$SRC" rev-parse --short HEAD)"
    git -C "$SRC" fetch --quiet --depth 1 origin HEAD
    # checkout (not reset): refuses rather than discarding any local edits.
    git -C "$SRC" checkout --quiet --detach FETCH_HEAD
    after="$(git -C "$SRC" rev-parse --short HEAD)"
    say "✓ updated SearXNG $before → $after"
  else
    say "= kept SearXNG checkout at $(git -C "$SRC" rev-parse --short HEAD) (--update pulls the latest)"
  fi
elif [ -e "$SRC" ]; then
  die "$SRC exists but isn't a git checkout; move it aside and re-run"
else
  git clone --quiet --depth 1 "$GIT_URL" "$SRC"
  say "✓ cloned $GIT_URL at $(git -C "$SRC" rev-parse --short HEAD) → $SRC"
fi

# ---- 2. venv + packages (the official steps: utils/searxng.sh, installation-searxng.rst)
if [ -x "$VENV/bin/python" ]; then
  say "= kept venv $VENV ($("$VENV/bin/python" -V))"
else
  "$UV" venv --quiet --python "$PY" "$VENV"
  say "✓ created venv $VENV ($("$VENV/bin/python" -V))"
fi
STAMP="$VENV/.flint-installed-$(git -C "$SRC" rev-parse HEAD)"
if [ -f "$STAMP" ]; then
  say "= packages already installed for this checkout"
else
  "$UV" pip install --quiet --python "$VENV/bin/python" -U setuptools wheel pyyaml msgspec typing-extensions pybind11
  "$UV" pip install --quiet --python "$VENV/bin/python" --no-build-isolation -e "$SRC"
  # granian: the WSGI server SearXNG's own container runs (pinned by upstream).
  "$UV" pip install --quiet --python "$VENV/bin/python" -r "$SRC/requirements-server.txt"
  rm -f "$VENV"/.flint-installed-*(N)
  touch "$STAMP"
  CHANGED=1
  say "✓ installed SearXNG + granian into the venv"
fi

# ---- 3. settings: written once, never overwritten (it holds the secret) ----
if [ -f "$SETTINGS" ]; then
  say "= kept $SETTINGS (existing secret untouched; delete the file to regenerate it)"
  grep -q 'ultrasecretkey' "$SETTINGS" && say "! $SETTINGS still has SearXNG's placeholder secret; SearXNG will refuse to start"
else
  SECRET="$(openssl rand -hex 32)"
  (
    umask 077
    cat >"$SETTINGS" <<EOF
# SearXNG for Flint: loopback-only, keyless metasearch behind web_search.
# Written once by apps/studio/install_searxng.sh, which never overwrites it.
# Everything not set here is SearXNG's default: https://docs.searxng.org/admin/settings/
use_default_settings:
  engines:
    keep_only: [duckduckgo, brave, bing, mojeek, wikipedia, qwant]

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en"
  formats: [html, json]   # json is what web_search reads

server:
  bind_address: "127.0.0.1"
  port: $PORT
  secret_key: "$SECRET"
  # The limiter (and the valkey it needs) fends off bots on public instances.
  # This one only listens on loopback for one user.
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"

outgoing:
  request_timeout: 5.0    # per engine; web_search waits 10s for the whole answer

# bing and qwant ship disabled, and mojeek inactive, in SearXNG's defaults.
engines:
  - name: bing
    disabled: false
  - name: qwant
    disabled: false
  - name: mojeek
    inactive: false
    disabled: false
EOF
  )
  unset SECRET
  CHANGED=1
  say "✓ wrote $SETTINGS (mode 600, new secret, 127.0.0.1:$PORT, json on, limiter off)"
fi

# ---- 4. LaunchAgent ----------------------------------------------------------
sed -e "s#__SEARXNG_HOME__#$DIR#g" -e "s#__PORT__#$PORT#g" "$STUDIO/$LABEL.plist" >"$RENDERED.tmp"
plutil -lint -s "$RENDERED.tmp" >/dev/null || die "rendered plist failed plutil -lint: $RENDERED.tmp"
mv "$RENDERED.tmp" "$RENDERED"

if [ "$LAUNCHD" = 0 ]; then
  say "- LaunchAgent not installed (--no-launchd); rendered it at $RENDERED"
  say "  run in the foreground with:"
  say "    cd $SRC && SEARXNG_SETTINGS_PATH=$SETTINGS GRANIAN_INTERFACE=wsgi GRANIAN_HOST=127.0.0.1 GRANIAN_PORT=$PORT $VENV/bin/granian searx.webapp:app"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
if [ "$CHANGED" = 0 ] && cmp -s "$RENDERED" "$AGENT" && launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  say "= $LABEL already loaded and unchanged"
else
  cp "$RENDERED" "$AGENT"
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$AGENT"
  say "✓ loaded $LABEL ($AGENT)"
fi

# ---- 5. prove it answers JSON ----------------------------------------------
URL="http://127.0.0.1:$PORT"
for _ in {1..30}; do
  curl -fsS -m 10 "$URL/search?q=searxng&format=json" -o "$DIR/logs/check.json" 2>/dev/null && break
  sleep 1
done
[ -s "$DIR/logs/check.json" ] || die "no JSON from $URL/search after 30s; see $DIR/logs/searxng.err.log"
"$VENV/bin/python" - "$DIR/logs/check.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
res = d.get("results", [])
engines = sorted({e for r in res for e in r.get("engines", [])})
print(f"✓ answering JSON: {len(res)} results for 'searxng' via {', '.join(engines) or 'no engines'}")
bad = d.get("unresponsive_engines") or []
if bad:
    print("  unresponsive: " + ", ".join(": ".join(map(str, e)) for e in bad))
PY
rm -f "$DIR/logs/check.json"
say ""
say "Next: in ~/.flint/mcp.json, set the web server's env to"
say "  \"SEARCH_PROVIDER\": \"auto\"   (keep SEARCH_API_KEY: it stays primary while it works)"
[ "$PORT" = 8888 ] || say "  \"SEARXNG_URL\": \"$URL\""
say "then rebuild the web connector bundle and restart Flint (apps/studio/README.md, Keyless search)."
