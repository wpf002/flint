#!/bin/zsh
# package_candidate.sh — turn a trained adapter into an Ollama model the gate can run.
#
#   package_candidate.sh --adapter <cycle>/adapter --out <cycle>/fused --tag flint-muse:c<id>
#                        [--profile muse-glimmer-30b] [--dry-run]
#
# Route A from the research (the only one that fits next to the live model):
#   1. mlx_lm fuse the adapter into the 4-bit MLX base (stays 4-bit, ~17 GB);
#   2. make the config text-only: mlx-lm's muse_glimmer port drops the vision
#      tower on load, so the fused weights have none, and a config that still
#      declares vision_config describes weights that aren't there;
#   3. `ollama create <tag>` FROM that directory, with the live model's
#      PARAMETERs (num_ctx etc.) so the candidate differs only in its weights.
#
# Ollama 0.34.2 can't do it any other way: it rejects LoRA ADAPTERs on GGUF
# models ("LoRA adapters are no longer supported") and no longer converts
# safetensors to GGUF. Its MLX importer runs the result on the MLX engine, so
# the attribution baseline is <family>:30b-mlx, not the GGUF live model
# (README "Reading a verdict").
#
# UNVERIFIED until the first real run (do it on a scratch cycle first):
# - that Ollama's importer accepts the text-only config (step 2), and
# - that it accepts mlx-lm's weight names (model.layers.*; the original
#   checkpoint nests them under model.language_model.*).
# A failure here is PACKAGE_FAILED in the cycle, never a change to the live model.
#
# It never touches the live model's tag, and never deletes anything but its own --out.

setopt pipe_fail no_unset err_exit

SCRIPT_DIR=${0:A:h}
PROFILE=${FLINT_BRAIN_PROFILE:-muse-glimmer-30b}
PY=${FLINT_TRAIN_PY:-$HOME/.flint-train/venv/bin/python}
ADAPTER="" OUT="" TAG="" DRY=0
while (( $# )); do
  case $1 in
    --adapter) shift; ADAPTER=$1 ;;
    --out) shift; OUT=$1 ;;
    --tag) shift; TAG=$1 ;;
    --profile) shift; PROFILE=$1 ;;
    --dry-run) DRY=1 ;;
    *) print -u2 "package_candidate.sh: unknown flag $1"; exit 2 ;;
  esac
  shift
done
[[ -n $ADAPTER && -n $OUT && -n $TAG ]] || { print -u2 "usage: package_candidate.sh --adapter DIR --out DIR --tag NAME:TAG"; exit 2; }
[[ -x $PY ]] || { (( DRY )) && PY=$(command -v python3) || { print -u2 "no training python at $PY (setup_train_env.sh)"; exit 2; }; }

P() { "$PY" "$SCRIPT_DIR/profiles.py" --profile "$PROFILE" get "$1"; }
MLX_MODEL=$(P base.mlx_model)
MLX_REV=$(P base.mlx_revision)
LIVE=$(P base.ollama_live)
THINK=$(P serve.think)
if (( DRY )); then
  BASE_DIR="<HF cache snapshot of $MLX_MODEL@$MLX_REV>"
else
  # The same pinned snapshot train_lora.py trained on; offline, never a download.
  BASE_DIR=$("$PY" -c 'import os, sys
from huggingface_hub import snapshot_download
m, rev = sys.argv[1], sys.argv[2]
print(m if os.path.isdir(m) else snapshot_download(m, revision=rev or None, local_files_only=True))' "$MLX_MODEL" "$MLX_REV")
fi

if [[ $TAG == "$LIVE" || $TAG != *:c* ]]; then
  print -u2 "package_candidate.sh: refusing tag $TAG (must be a new <prefix>:c<id> tag, never the live $LIVE)"
  exit 2
fi
if [[ -e $ADAPTER/NO_CANDIDATE || ! -f $ADAPTER/adapters.safetensors ]]; then
  print -u2 "package_candidate.sh: $ADAPTER has no candidate adapter"
  exit 2
fi

run() { print -r -- "+ $*"; (( DRY )) || "$@"; }

# 1. fuse (offline: the base must already be in the HF cache from training)
run env HF_HUB_OFFLINE=1 "$PY" -m mlx_lm fuse --model "$BASE_DIR" --adapter-path "$ADAPTER" --save-path "$OUT"

# 2. text-only config (the original is kept as config.full.json)
run "$PY" - "$OUT" <<'PYCODE'
import json, os, sys
out = sys.argv[1]
path = os.path.join(out, "config.json")
cfg = json.load(open(path))
json.dump(cfg, open(os.path.join(out, "config.full.json"), "w"), indent=2)
dropped = [k for k in list(cfg) if k == "vision_config" or k.startswith(("projector_", "image_", "video_")) or k == "out_hidden_size"]
for k in dropped:
    cfg.pop(k)
json.dump(cfg, open(path, "w"), indent=2)
for f in ("processor_config.json", "preprocessor_config.json"):
    p = os.path.join(out, f)
    if os.path.exists(p):
        os.remove(p)
print(f"text-only config: dropped {dropped}")
PYCODE

# 3. Modelfile: the fused weights + the live model's parameters
MODELFILE=$OUT/Modelfile
if (( DRY )); then
  print -r -- "+ ollama show --parameters $LIVE > PARAMETER lines in $MODELFILE"
else
  {
    print -r -- "FROM $OUT"
    ollama show --parameters "$LIVE" | awk 'NF >= 2 { $1 = $1; print "PARAMETER " $0 }'
  } > "$MODELFILE"
  print -r -- "Modelfile:"; cat "$MODELFILE"
fi
run ollama create "$TAG" -f "$MODELFILE"

# 4. it must exist and be able to do what the live model is served with
if (( ! DRY )); then
  CAPS=$(ollama show "$TAG" 2>/dev/null) || { print -u2 "package_candidate.sh: ollama show $TAG failed after create"; exit 1; }
  if [[ $THINK == true && $CAPS != *thinking* ]]; then
    print -u2 "package_candidate.sh: $TAG lost the thinking capability the live model is served with; not gating it"
    ollama rm "$TAG" >/dev/null 2>&1 || true
    exit 1
  fi
  print -r -- "packaged $TAG"
fi
