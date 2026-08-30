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
REPO="$HOME/Documents/GitHub/flint"
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
if [ ! -x "$HOME/.flint-ollama/ollama" ] && ! have ollama; then
  brew install ollama >/dev/null 2>&1 || echo "  ! install ollama by hand: brew install ollama"
fi
ok "ollama present"

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

step "8/8 build server + load agents"
( cd "$REPO" && ./apps/server/install-server.sh ) || { echo "  ✗ server build/deploy failed — see output above"; exit 1; }
UID_N="$(id -u)"
# (N) null_glob so an absent class (e.g. no com.nexus.*) doesn't abort the script.
# bootstrap into gui/$UID explicitly (install-server.sh's legacy `load -w` targets
# the wrong domain over SSH); kickstart -k restarts it if it's already loaded.
for p in "$HOME"/Library/LaunchAgents/com.flint.*.plist(N) "$HOME"/Library/LaunchAgents/com.nexus.*.plist(N); do
  launchctl bootstrap "gui/$UID_N" "$p" 2>/dev/null || \
    launchctl kickstart -k "gui/$UID_N/$(basename "$p" .plist)" 2>/dev/null || true
  ok "loaded $(basename "$p")"
done

echo; echo "== health check"
sleep 3
curl -s -m 5 http://127.0.0.1:8080/health || echo "  ! server not up yet — see ~/.flint/logs/server.err.log"
echo; echo "== BOOTSTRAP COMPLETE — Flint is live on the Studio (Claude teacher). =="
