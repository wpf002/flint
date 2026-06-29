#!/bin/zsh
# Clean full run: ollama fully UNLOADED for the whole job (so it can't reload and
# kill training), train 7B to completion w/ early-stop, judge, reload ollama.
set -e
BRAIN="$HOME/.flint/brain"; PY="$BRAIN/.venv/bin/python"; LOG="$BRAIN/history.log"
export BASE_MODEL="mlx-community/Qwen2.5-7B-Instruct-4bit"; export ADAPTER="$BRAIN/adapters7b"
OLLAMA_PLIST="$HOME/Library/LaunchAgents/com.flint.ollama.plist"
TS=$(date "+%Y-%m-%d %H:%M")

echo "[$TS] locking out ollama for the whole run..."
launchctl unload "$OLLAMA_PLIST" 2>/dev/null || true
sleep 3

"$PY" "$BRAIN/prepare_data.py"
TRAIN_N=$(wc -l < "$BRAIN/data/train.jsonl" | tr -d ' ')
ITERS=$(( TRAIN_N * 2 )); [ $ITERS -gt 1000 ] && ITERS=1000; [ $ITERS -lt 100 ] && ITERS=100
STEP=$(( ITERS / 6 )); [ $STEP -lt 50 ] && STEP=50

echo "[$TS] training full: train_n=$TRAIN_N iters=$ITERS step=$STEP seq=2048"
TRAINLOG="$BRAIN/last_train.log"
"$PY" -m mlx_lm lora --model "$BASE_MODEL" --train --data "$BRAIN/data" \
  --fine-tune-type lora --num-layers 8 --batch-size 1 --iters $ITERS \
  --max-seq-length 2048 --learning-rate 1e-5 --save-every $STEP --steps-per-eval $STEP \
  --adapter-path "$ADAPTER" 2>&1 | tee "$TRAINLOG"

"$PY" "$BRAIN/pick_best.py" "$TRAINLOG" "$ADAPTER"
RESULT=$(EVAL_N=10 "$PY" "$BRAIN/eval_judge.py" 2>&1 | grep -E "Flint wins|verdict" || echo "eval failed")

echo "[$TS] reloading ollama..."
launchctl load -w "$OLLAMA_PLIST" 2>/dev/null || true

{ echo "[$TS] FULL model=$BASE_MODEL train_n=$TRAIN_N iters=$ITERS seq=2048"; echo "  $RESULT"; echo "------"; } >> "$LOG"
echo "=== FULL RUN DONE ==="
echo "$RESULT"
