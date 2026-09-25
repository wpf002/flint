#!/bin/zsh
# studio_roadmap.sh — runs ON the Mac Studio. Reports where Flint's local brain
# stands and what a training cycle would do. It starts nothing.
#
# It used to launch an overnight QLoRA fine-tune of Qwen2.5-72B and bootstrap the
# daily-grow / weekly-retrain agents. All three are retired (apps/train/mlx/HISTORY.md):
# - the 72B fine-tune never beat its own base (31-34 of 150, noise), and nothing
#   ever measured it against a frontier model;
# - both agents trained on Claude's answers, which Anthropic's terms prohibit as
#   training targets, and the retrain unloaded Ollama (taking memory recall and
#   embeddings down for every frontier turn too).
#
# What replaced them is apps/train/mlx/cycle.sh: a candidate ships only if the
# parity gate shows it makes Flint-local measurably better against GPT-5. Its
# schedule (com.flint.retrain) ships disabled; see apps/train/mlx/README.md
# "Scheduling" before enabling it.
set -uo pipefail

REPO="${FLINT_REPO:-$HOME/flint}"
MLX="$REPO/apps/train/mlx"
export PATH="$HOME/.flint-ollama:/opt/homebrew/bin:$HOME/.local/bin:$PATH"

echo "== local brain"
curl -s -m 5 http://127.0.0.1:8080/health | /usr/bin/python3 -c 'import json,sys; h=json.load(sys.stdin); print(f"   serving: {h.get(\"provider\")}:{h.get(\"model\")}")' 2>/dev/null \
  || echo "   ! server not answering on :8080"

echo "== scheduled training (com.flint.retrain)"
if launchctl print-disabled "gui/$(id -u)" 2>/dev/null | grep -q '"com.flint.retrain" => disabled'; then
  echo "   disabled (as shipped)"
else
  echo "   ! not marked disabled: check it runs $MLX/cycle.sh, not ~/.flint/brain/retrain.sh"
fi

echo "== what a cycle would do now (dry run: builds nothing, trains nothing)"
if [ -x "$MLX/cycle.sh" ]; then
  /bin/zsh "$MLX/cycle.sh" --dry-run --if-due
else
  echo "   ! $MLX/cycle.sh not found — is $REPO the deploy checkout?"
fi

cat <<'EOF'

Next steps are in apps/train/mlx/README.md: set up the training venv
(setup_train_env.sh), get terms-compliant training data, run ONE supervised
cycle, and only then enable the schedule. Promotion stays a manual step.
EOF
