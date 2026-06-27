#!/bin/zsh
# Cycle 2: train Flint-v1 on a 7B student, judge with Claude.
set -e
BRAIN="$HOME/.flint/brain"
PY="$BRAIN/.venv/bin/python"
export BASE_MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"
export ADAPTER="$BRAIN/adapters7b"

echo "[1/3] evicting ollama to free GPU/RAM for 7B training..."
launchctl kickstart -k gui/$(id -u)/com.flint.ollama 2>/dev/null || true
sleep 5

echo "[2/3] training Flint-v1 (LoRA on 7B, same corpus as v0)..."
"$PY" -m mlx_lm lora --model "$BASE_MODEL" --train --data "$BRAIN/data" \
  --fine-tune-type lora --num-layers 8 --batch-size 1 --iters 300 \
  --max-seq-length 1024 --adapter-path "$ADAPTER" --save-every 150

echo "[3/3] LLM-judge eval: 7B base vs Flint-v1..."
"$PY" "$BRAIN/eval_judge.py"
echo "=== CYCLE 2 COMPLETE ==="
