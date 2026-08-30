#!/bin/zsh
# studio_roadmap.sh — runs ON the Mac Studio. Starts the roadmap that turns Flint
# from a 7B-on-Claude into a real, owned 70B AI:
#   1. launch the ultimate upgrade — an overnight QLoRA fine-tune on EVERY banked
#      lesson, early-stopped and Claude-judged — DETACHED so it survives logout/SSH.
#   2. make sure the flywheel agents (daily grow + weekly retrain) are running.
#
# The ollama 70B serving base is intentionally NOT pulled here: the fine-tune
# UNLOADS ollama for its whole multi-hour run, so a concurrent `ollama pull` would
# lose its server and fail. Pull it at SERVE time instead (step 3 below).
#
# NOT automated here (on purpose): SERVING the 70B and FLIPPING it to primary.
# Those wait on the training + eval verdict (docs/MAC_STUDIO_UPGRADE.md steps 3-4) —
# auto-promoting an unproven brain would make Flint worse, not better.
set -uo pipefail

BRAIN="$HOME/.flint/brain"
FLINT_70B="${FLINT_70B:-mlx-community/Qwen2.5-72B-Instruct-4bit}"   # MLX base: fine-tune + serve (auto-downloaded)
OLLAMA_70B="${OLLAMA_70B:-qwen2.5:72b}"                            # ollama base: pulled at serve time (option B)
export PATH="$HOME/.flint-ollama:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.flint/logs"

echo "== 1/2 launch the ultimate upgrade (overnight fine-tune), detached"
if [ ! -x "$BRAIN/.venv/bin/python" ]; then
  echo "   ! brain venv missing — run studio_bootstrap.sh first. Not starting training."
  exit 1
fi
if [ ! -f "$BRAIN/ultimate_upgrade.sh" ]; then
  echo "   ! $BRAIN/ultimate_upgrade.sh not found — did ~/.flint/brain sync over? Aborting."
  exit 1
fi
chmod +x "$BRAIN/ultimate_upgrade.sh" 2>/dev/null || true
nohup env FLINT_70B="$FLINT_70B" /bin/zsh "$BRAIN/ultimate_upgrade.sh" > "$BRAIN/upgrade.out" 2>&1 &
echo "   training started (pid $!) — watch: tail -f ~/.flint/brain/upgrade.out"

echo "== 2/2 flywheel agents (daily grow + weekly retrain)"
UID_N="$(id -u)"
for a in com.flint.grow com.flint.retrain; do
  P="$HOME/Library/LaunchAgents/$a.plist"
  if [ -e "$P" ]; then
    launchctl bootstrap "gui/$UID_N" "$P" 2>/dev/null || true
    echo "   ✓ $a"
  else
    echo "   ! $a.plist not found (install it to keep the flywheel turning)"
  fi
done

cat <<'EOF'

== ROADMAP STARTED ==
Running now, hands-off:
  - 70B base downloading
  - overnight fine-tune on every banked lesson (Claude judges it vs the base 70B)
  - grow (daily) + retrain (weekly) keep the corpus and model improving

WHEN THE UPGRADE FINISHES — check the verdict in ~/.flint/brain/history.log — do the
two human-gated steps that make Flint his own AI:
  3. SERVE Flint-70B   — docs/MAC_STUDIO_UPGRADE.md step 3
       (for the ollama serving path, pull the base now that training is done:
        ollama pull qwen2.5:72b)
  4. FLIP to primary   — docs/MAC_STUDIO_UPGRADE.md step 4 (judgeBrain: local-first, Claude backup)
EOF
