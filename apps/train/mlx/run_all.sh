#!/bin/zsh
# Flint-v0 proof-of-loop: wait for corpus -> prepare -> train (LoRA) -> eval.
set -e
BRAIN="$HOME/.flint/brain"
PY="$BRAIN/.venv/bin/python"
CORPUS="$HOME/.flint/training/corpus.jsonl"
export BASE_MODEL="mlx-community/Qwen2.5-3B-Instruct-4bit"

echo "[1/4] waiting for corpus to fill (target >=80 teacher examples)..."
for i in $(seq 1 80); do
  n=$(/usr/bin/python3 -c "import json;print(sum(1 for l in open('$CORPUS') if l.strip() and json.loads(l).get('brain')=='frontier'))" 2>/dev/null || echo 0)
  echo "  corpus teacher=$n"
  [ "$n" -ge 80 ] && break
  sleep 15
done

echo "[2/4] preparing training data..."
"$PY" "$BRAIN/prepare_data.py"

echo "[2.5] evicting ollama models to free GPU/RAM for training..."
launchctl kickstart -k gui/$(id -u)/com.flint.ollama 2>/dev/null || true
sleep 5

echo "[3/4] training Flint-v0 (LoRA on $BASE_MODEL)..."
"$PY" -m mlx_lm lora --model "$BASE_MODEL" --train --data "$BRAIN/data" \
  --fine-tune-type lora --num-layers 8 --batch-size 1 --iters 300 \
  --max-seq-length 1024 --adapter-path "$BRAIN/adapters" --save-every 150

echo "[4/4] evaluating Flint-v0 vs base vs Claude..."
"$PY" "$BRAIN/eval.py"
echo "=== PIPELINE COMPLETE ==="
