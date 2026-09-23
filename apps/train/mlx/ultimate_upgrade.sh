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

# macOS lets the GPU wire only ~75% of RAM by default: ~48GB on a 64GB Studio.
# The 72B 4-bit base is ~41GB before activations, LoRA state and the eval pass,
# so a QLoRA run at the default limit OOMs or swaps. sysctl reports 0 for "default".
# Raise it once per boot (resets on reboot):  sudo sysctl iogpu.wired_limit_mb=57344
WIRED_MB=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
if [ "${FLINT_SKIP_WIRED_CHECK:-0}" != 1 ] && [ "$WIRED_MB" -lt "${FLINT_MIN_WIRED_MB:-56000}" ]; then
  echo "✗ GPU wired limit is ${WIRED_MB}MB (0 = macOS default, ~48GB on 64GB)."
  echo "  A 72B QLoRA run needs ~56GB. Run this, then retry:"
  echo "    sudo sysctl iogpu.wired_limit_mb=57344"
  exit 1
fi

echo "[$TS] ULTIMATE UPGRADE — base=$BASE_MODEL"
echo "[$TS] locking out ollama for the whole run..."
launchctl unload "$OLLAMA_PLIST" 2>/dev/null || true
sleep 3

echo "[$TS] preparing ALL banked data (personal lessons + 50k)..."
"$PY" "$BRAIN/prepare_data.py"
TRAIN_N=$(wc -l < "$BRAIN/data/train.jsonl" | tr -d ' ')

# A real fine-tune: multiple passes, early-stopped so it can't overfit.
# ~2 epochs, capped so an overnight run finishes; bump ITERS if you want more.
# 8000 was far too many. Measured on the first real 72B run (2026-09-22):
# val loss bottomed at iter 800 (1.403) and rose steadily to 2.02 by 7200, so
# 7200 iterations were actively harmful and only pick_best rescued the result.
# Early stopping still protects overshoot; this just stops burning 7 hours.
ITERS="${UPGRADE_ITERS:-2000}"; [ $((TRAIN_N*2)) -lt $ITERS ] && ITERS=$((TRAIN_N*2))
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
# No EVAL_N cap. This used to be 15, which cannot separate a real gain from a
# coin flip — the first 72B run came back 4-4-7 and said "roughly even" when it
# had measured nothing. Judge the whole frozen holdout.
RESULT=$(EVAL_TS="$TS" "$PY" "$BRAIN/eval_judge.py" 2>&1 | grep -E "Flint wins|verdict|signal:" || echo "eval failed")

launchctl load -w "$OLLAMA_PLIST" 2>/dev/null || true
{ echo "[$TS] ULTIMATE UPGRADE 70B  train_n=$TRAIN_N iters=$ITERS"; echo "  $RESULT"; echo "------"; } >> "$LOG"
echo "=== UPGRADE COMPLETE ==="
echo "$RESULT"
echo "Next: serve adapters70b as Flint's brain (docs/MAC_STUDIO_UPGRADE.md step 3-4)."
