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
PREP=$("$PY" "$BRAIN/prepare_data.py")
echo "$PREP"   # launchd has no tty; echo rather than tee
TRAIN_N=$(wc -l < "$BRAIN/data/train.jsonl" | tr -d ' ')
# The personal/public mix, carried into history.log so a bad ratio is visible in
# the record instead of hiding inside a win/loss number.
MIX=$(echo "$PREP" | grep '^MIX ' || echo "MIX unknown")

# ~2 epochs, capped; early-stopping makes overshoot safe. The old cap was 1000,
# which at batch-size 1 meant a weekly run sampled ~1000 rows out of a 50k set —
# about fourteen of Will's own examples. Raise it so the personal rows (now
# oversampled by prepare_data.py) are actually seen.
ITERS=$(( TRAIN_N * 2 )); [ $ITERS -gt ${RETRAIN_MAX_ITERS:-4000} ] && ITERS=${RETRAIN_MAX_ITERS:-4000}; [ $ITERS -lt 100 ] && ITERS=100
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
# No EVAL_N: judge the WHOLE frozen holdout. A 10-prompt eval could not tell a
# real gain from a coin flip, which is why the history read as noise.
RESULT=$(EVAL_TS="$TS" "$PY" "$BRAIN/eval_judge.py" 2>&1 | grep -E "Flint wins|verdict|signal:" || echo "eval failed")

echo "[$TS] reloading ollama..."
/bin/launchctl load -w "$HOME/Library/LaunchAgents/com.flint.ollama.plist" 2>/dev/null || true

{
  echo "[$TS] model=$BASE_MODEL train_n=$TRAIN_N iters=$ITERS"
  echo "  $MIX"
  echo "  $RESULT"
  echo "------"
} >> "$LOG"
echo "=== RETRAIN DONE ==="
echo "$RESULT"
