#!/bin/zsh
# setup_train_env.sh — create the training venv. Will runs this once, on purpose.
#
#   setup_train_env.sh [--download-base]
#
# Creates ~/.flint-train/venv (FLINT_TRAIN_VENV to change it) with Python 3.12 and
# the pinned mlx-lm from requirements-train.txt. It lives outside ~/.flint on
# purpose: the old venv at ~/.flint/brain/.venv has mlx-lm 0.31.3, which can't
# load muse-glimmer, and the old scripts that still sit in ~/.flint/brain use it.
#
# Downloads: the venv install fetches mlx-lm from GitHub and its wheels (~200 MB).
# The base model is NOT downloaded unless you pass --download-base, which fetches
# the default profile's base.mlx_model at its pinned revision into the Hugging Face
# cache (~19.4 GB for muse-glimmer-30b-4bit). Check free disk first: a cycle also
# needs ~20 GB for the fused candidate and ~17 GB for its Ollama copy.

setopt err_exit pipe_fail no_unset

SCRIPT_DIR=${0:A:h}
VENV=${FLINT_TRAIN_VENV:-$HOME/.flint-train/venv}
DOWNLOAD=0
[[ ${1:-} == --download-base ]] && DOWNLOAD=1

command -v uv >/dev/null || { print -u2 "setup_train_env.sh: needs uv (brew install uv)"; exit 1; }
if [[ ! -x $VENV/bin/python ]]; then
  mkdir -p "${VENV:h}"
  uv venv --python 3.12 "$VENV"
fi
uv pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements-train.txt"
"$VENV/bin/python" -c 'import mlx_lm, mlx_lm.models.muse_glimmer; print("mlx-lm", mlx_lm.__version__, "with muse_glimmer")'

if (( DOWNLOAD )); then
  MODEL=$("$VENV/bin/python" "$SCRIPT_DIR/profiles.py" get base.mlx_model)
  REV=$("$VENV/bin/python" "$SCRIPT_DIR/profiles.py" get base.mlx_revision)
  print "downloading $MODEL@$REV into the Hugging Face cache..."
  "$VENV/bin/python" -c 'import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1], revision=sys.argv[2]))' "$MODEL" "$REV"
fi

cat <<EOF
Training venv ready: $VENV
cycle.sh uses it by default (FLINT_TRAIN_PY=$VENV/bin/python to be explicit).
Next: a manual dry run, then one supervised cycle before scheduling anything:
  $SCRIPT_DIR/cycle.sh --dry-run
EOF
