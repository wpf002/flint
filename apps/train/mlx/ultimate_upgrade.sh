#!/bin/zsh
# THE ULTIMATE UPGRADE — run once on the Mac Studio (64GB) after transfer.
# Fine-tunes a 70B on EVERY banked lesson (personal Claude data + the 50k),
# early-stops on best val loss, and has Claude judge it vs the base 70B.
# Expect an overnight run. Serve the result per docs/MAC_STUDIO_UPGRADE.md step 3.
set -e
BRAIN="$HOME/.flint/brain"; PY="$BRAIN/.venv/bin/python"; LOG="$BRAIN/history.log"
export BASE_MODEL="${FLINT_70B:-mlx-community/Qwen2.5-72B-Instruct-4bit}"
export ADAPTER="$BRAIN/adapters70b"
OLLAMA_PLIST="$HOME/Library/LaunchAgents/com.flint.ollama.plist"
TS=$(date "+%Y-%m-%d %H:%M")

echo "[$TS] ULTIMATE UPGRADE — base=$BASE_MODEL"
echo "[$TS] locking out ollama for the whole run..."
launchctl unload "$OLLAMA_PLIST" 2>/dev/null || true
sleep 3

echo "[$TS] preparing ALL banked data (personal lessons + 50k)..."
"$PY" "$BRAIN/prepare_data.py"
TRAIN_N=$(wc -l < "$BRAIN/data/train.jsonl" | tr -d ' ')

# A real fine-tune: multiple passes, early-stopped so it can't overfit.
# ~2 epochs, capped so an overnight run finishes; bump ITERS if you want more.
ITERS="${UPGRADE_ITERS:-8000}"; [ $((TRAIN_N*2)) -lt $ITERS ] && ITERS=$((TRAIN_N*2))
STEP=$(( ITERS / 10 )); [ $STEP -lt 100 ] && STEP=100

echo "[$TS] fine-tuning 70B: train_n=$TRAIN_N iters=$ITERS step=$STEP (this takes hours)"
TRAINLOG="$BRAIN/last_train_70b.log"
"$PY" -m mlx_lm lora --model "$BASE_MODEL" --train --data "$BRAIN/data" \
  --fine-tune-type lora --num-layers 16 --batch-size 1 --iters $ITERS \
  --max-seq-length 2048 --learning-rate 1e-5 --grad-checkpoint \
  --save-every $STEP --steps-per-eval $STEP \
  --adapter-path "$ADAPTER" 2>&1 | tee "$TRAINLOG"

echo "[$TS] selecting best checkpoint (early-stop)..."
"$PY" "$BRAIN/pick_best.py" "$TRAINLOG" "$ADAPTER"

echo "[$TS] judging Flint-70B vs base 70B (Claude referee)..."
RESULT=$(EVAL_N=15 "$PY" "$BRAIN/eval_judge.py" 2>&1 | grep -E "Flint wins|verdict" || echo "eval failed")

launchctl load -w "$OLLAMA_PLIST" 2>/dev/null || true
{ echo "[$TS] ULTIMATE UPGRADE 70B  train_n=$TRAIN_N iters=$ITERS"; echo "  $RESULT"; echo "------"; } >> "$LOG"
echo "=== UPGRADE COMPLETE ==="
echo "$RESULT"
echo "Next: serve adapters70b as Flint's brain (docs/MAC_STUDIO_UPGRADE.md step 3-4)."
