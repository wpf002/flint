#!/bin/zsh
# studio_bootstrap.sh — runs ON the Mac Studio (invoked by migrate_to_studio.sh, or
# by hand). Installs the toolchain, clones/refreshes the repo, rebuilds Flint's
# server, and loads every agent. Idempotent — safe to re-run.
#
# End state: Flint is LIVE on the Studio, answering on the Claude teacher. The 70B
# takeover happens later (studio_roadmap.sh + docs/MAC_STUDIO_UPGRADE.md steps 3-4).
#
# Env in:  REPO_URL (git origin), FLINT_BRANCH (default main).
set -uo pipefail

REPO_URL="${REPO_URL:-https://github.com/wpf002/flint.git}"
BRANCH="${FLINT_BRANCH:-main}"
# Deploy-only checkout: com.flint.deploy hard-resets it to origin every 2 min.
# Do dev work in a separate clone (~/Documents/GitHub/flint), never here.
REPO="$HOME/flint"
NODE_VERSION="v24.15.0"          # matches the PATH baked into the LaunchAgents
ok(){ echo "  ✓ $*"; }
step(){ echo; echo "== $*"; }
have(){ command -v "$1" >/dev/null 2>&1; }

step "1/8 Homebrew"
if ! have brew; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || true)"
ok "brew $(brew --version 2>/dev/null | head -1)"

step "2/8 node $NODE_VERSION (nvm)"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] || curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null 2>&1 || true
nvm alias default "$NODE_VERSION" >/dev/null 2>&1 || true
nvm use "$NODE_VERSION" >/dev/null 2>&1 || true
ok "node $(node -v 2>/dev/null || echo '?')"

step "3/8 pnpm"
have pnpm || corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1 || true
ok "pnpm $(pnpm -v 2>/dev/null || echo '?')"

step "4/8 uv (python env for training)"
have uv || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
ok "uv $(uv --version 2>/dev/null || echo '?')"

step "5/8 ollama"
# This used to print "ollama present" unconditionally, including when the install
# had failed, and the server then booted and hung waiting on embeddings with no
# obvious cause. Verify instead of announcing.
if ! have ollama && [ ! -x "$HOME/.flint-ollama/ollama" ]; then
  brew install ollama 2>&1 | tail -3
fi
OLLAMA_BIN="$(command -v ollama || echo "$HOME/.flint-ollama/ollama")"
[ -x "$OLLAMA_BIN" ] || { echo "  ✗ ollama not installed — run: brew install ollama"; exit 1; }
ok "ollama at $OLLAMA_BIN"

step "5b/8 point the ollama agent at THIS machine's binary"
# com.flint.ollama.plist rsyncs from the old Mac, where ollama lived in
# ~/.flint-ollama. On a fresh Mac it's a Homebrew path, so the agent silently
# fails to launch, the server starts, hangs on embeddings, and /health never
# answers. Rewrite the path to whatever this machine actually has.
OP="$HOME/Library/LaunchAgents/com.flint.ollama.plist"
if [ -f "$OP" ] && ! grep -q "$OLLAMA_BIN" "$OP"; then
  /usr/bin/sed -i "" "s#<string>[^<]*/ollama</string>#<string>$OLLAMA_BIN</string>#" "$OP"
  /usr/bin/sed -i "" "s#<string>/Users/[^<]*/.flint-ollama</string>#<string>$HOME</string>#" "$OP"
  plutil -lint "$OP" >/dev/null && ok "ollama agent repointed at $OLLAMA_BIN"
fi

step "6/8 clone/refresh repo -> $REPO"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --quiet origin "$BRANCH" && git -C "$REPO" reset --hard --quiet "origin/$BRANCH" \
    || { echo "  ✗ git fetch/reset failed"; exit 1; }
else
  mkdir -p "$(dirname "$REPO")"
  git clone --quiet "$REPO_URL" "$REPO" || { echo "  ✗ git clone failed ($REPO_URL)"; exit 1; }
  git -C "$REPO" checkout --quiet "$BRANCH" 2>/dev/null || true
fi
( cd "$REPO" && pnpm install --silent ) || { echo "  ✗ pnpm install failed (is node/pnpm on PATH?)"; exit 1; }
ok "repo at $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"

step "7/8 python venv for the brain (mlx-lm)"
BRAIN="$HOME/.flint/brain"
if [ -d "$BRAIN" ] && [ ! -x "$BRAIN/.venv/bin/python" ]; then
  ( cd "$BRAIN" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python mlx-lm datasets )
fi
[ -x "$BRAIN/.venv/bin/python" ] && ok "brain venv ready" || echo "  ! brain venv missing (did ~/.flint/brain sync over?)"
# That venv's mlx-lm (0.31.3) can't load muse-glimmer. The training cycle uses its
# own pinned venv, created on purpose by apps/train/mlx/setup_train_env.sh, not here.

step "7b/9 clone + build trident (4 of Flint's tools come from it)"
# ~/.flint/mcp.json runs trident's MCP server from
# ~/Documents/GitHub/trident/packages/mcp-server/dist/index.js. That repo is NOT
# this one and bootstrap used to skip it, so gmail/gcal/gdrive/perplexity_search
# would fail on the Studio. dist/ is gitignored, so it has to be built here.
TRIDENT="$HOME/Documents/GitHub/trident"
if [ -d "$TRIDENT/.git" ]; then
  git -C "$TRIDENT" pull --quiet --ff-only 2>/dev/null || true
else
  git clone --quiet https://github.com/wpf002/trident.git "$TRIDENT" || echo "  ! trident clone failed"
fi
if [ -d "$TRIDENT" ]; then
  ( cd "$TRIDENT" && npm install --silent && npm run build --silent ) \
    && ok "trident MCP server built" \
    || echo "  ! trident build failed — gmail/gcal/gdrive tools will be offline"
fi

step "8/9 install agents that live in the repo but aren't running on the old Mac"
# migrate_to_studio.sh rsyncs only the plists ALREADY INSTALLED on the laptop.
# Several agents ship in the repo and are deliberately not running there —
# com.flint.deploy (the git auto-pull that IS the Studio's whole update path).
# Without this step they would simply not exist on the Studio and nothing would say so.
# Not the training schedule: com.flint.retrain ships disabled and is enabled by
# hand after a supervised cycle (apps/train/mlx/README.md "Scheduling"), and the
# daily com.flint.grow is retired.
for src in \
  "$REPO/apps/server/com.flint.deploy.plist" \
  "$REPO/apps/studio/com.flint.backup.plist"; do
  [ -f "$src" ] || continue
  dst="$HOME/Library/LaunchAgents/$(basename "$src")"
  if [ -f "$dst" ]; then
    ok "$(basename "$src") already present (transferred) — keeping it"
  else
    cp "$src" "$dst" && ok "installed $(basename "$src") from the repo"
  fi
done

step "9/9 build server + load agents"
( cd "$REPO" && ./apps/server/install-server.sh ) || { echo "  ✗ server build/deploy failed — see output above"; exit 1; }
UID_N="$(id -u)"
# (N) null_glob so an absent class (e.g. no com.nexus.*) doesn't abort the script.
# bootstrap into gui/$UID explicitly (install-server.sh's legacy `load -w` targets
# the wrong domain over SSH); kickstart -k restarts it if it's already loaded.
for p in "$HOME"/Library/LaunchAgents/com.flint.*.plist(N) "$HOME"/Library/LaunchAgents/com.nexus.*.plist(N); do
  # Training jobs are never loaded as a side effect of a bootstrap: a transferred
  # com.flint.retrain may still point at the retired ~/.flint/brain/retrain.sh,
  # which unloads Ollama. Enabling training is a deliberate step (apps/train/mlx/README.md).
  case "$(basename "$p" .plist)" in
    com.flint.retrain|com.flint.grow) echo "  - skipped $(basename "$p") (training is enabled by hand)"; continue ;;
  esac
  launchctl bootstrap "gui/$UID_N" "$p" 2>/dev/null || \
    launchctl kickstart -k "gui/$UID_N/$(basename "$p" .plist)" 2>/dev/null || true
  ok "loaded $(basename "$p")"
done

echo; echo "== health check"
sleep 3
curl -s -m 5 http://127.0.0.1:8080/health || echo "  ! server not up yet — see ~/.flint/logs/server.err.log"
echo; echo "== BOOTSTRAP COMPLETE — Flint is live on the Studio (Claude teacher). =="
