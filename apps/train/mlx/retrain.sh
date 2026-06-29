#!/bin/zsh
# Flint brain retrain job (also the weekly auto-retrain). prepare -> train (with
# periodic val + checkpoints) -> early-stop pick-best -> Claude judge -> log.
set -e
BRAIN="$HOME/.flint/brain"
PY="$BRAIN/.venv/bin/python"
LOG="$BRAIN/history.log"
export BASE_MODEL="${FLINT_BRAIN_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
export ADAPTER="$BRAIN/adapters7b"
TS=$(date "+%Y-%m-%d %H:%M")

echo "[$TS] preparing data..."
"$PY" "$BRAIN/prepare_data.py"
TRAIN_N=$(wc -l < "$BRAIN/data/train.jsonl" | tr -d ' ')

# ~2 epochs, capped; early-stopping makes overshoot safe
ITERS=$(( TRAIN_N * 2 )); [ $ITERS -gt 1000 ] && ITERS=1000; [ $ITERS -lt 100 ] && ITERS=100
STEP=$(( ITERS / 6 )); [ $STEP -lt 50 ] && STEP=50

echo "[$TS] locking out ollama for the whole run (prevents mid-train OOM/kill)..."
/bin/launchctl unload "$HOME/Library/LaunchAgents/com.flint.ollama.plist" 2>/dev/null || true
sleep 3

echo "[$TS] training: model=$BASE_MODEL train_n=$TRAIN_N iters=$ITERS step=$STEP"
TRAINLOG="$BRAIN/last_train.log"
"$PY" -m mlx_lm lora --model "$BASE_MODEL" --train --data "$BRAIN/data" \
  --fine-tune-type lora --num-layers 8 --batch-size 1 --iters $ITERS \
  --max-seq-length 2048 --learning-rate 1e-5 \
  --save-every $STEP --steps-per-eval $STEP \
  --adapter-path "$ADAPTER" 2>&1 | tee "$TRAINLOG"

echo "[$TS] selecting best checkpoint (early-stop)..."
"$PY" "$BRAIN/pick_best.py" "$TRAINLOG" "$ADAPTER"

echo "[$TS] judging vs base..."
RESULT=$(EVAL_N=10 "$PY" "$BRAIN/eval_judge.py" 2>&1 | grep -E "Flint wins|verdict" || echo "eval failed")

echo "[$TS] reloading ollama..."
/bin/launchctl load -w "$HOME/Library/LaunchAgents/com.flint.ollama.plist" 2>/dev/null || true

{
  echo "[$TS] model=$BASE_MODEL train_n=$TRAIN_N iters=$ITERS"
  echo "  $RESULT"
  echo "------"
} >> "$LOG"
echo "=== RETRAIN DONE ==="
echo "$RESULT"
