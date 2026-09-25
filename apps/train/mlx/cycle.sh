#!/bin/zsh
# cycle.sh — one training cycle for Flint's local brain, promoted only if it
# measurably improves Flint-local's standing against GPT-5.
#
#   cycle.sh [--if-due] [--force] [--dry-run] [--profile <name>]
#
#   --if-due   what the scheduled job runs: exit quietly unless cycle_state.py says
#              a cycle is due (enough new compliant data, 7+ days, kill switch off)
#   --force    run even if not due / the kill switch is on (a deliberate manual run)
#   --dry-run  print the plan and the data counts; train, package and gate nothing
#
# Steps: build data (contamination-guarded, terms-compliant) -> memcheck (fit next
# to the live model or defer) -> train_lora.py (early stopping) -> package the
# candidate into Ollama -> parity gate vs GPT-5 against the live local model ->
# unload the candidate -> record. Everything lands in ~/.flint/brain/cycles/<id>/.
#
# What it never does:
# - touch the live model or the Ollama service. No launchctl, no eviction. If
#   training can't fit next to the live model it defers (memcheck.py). Taking the
#   live model offline for training ("cover mode") is a decision for Will, see
#   README "Why no cover mode".
# - promote. A PROMOTE verdict prints the one command that serves the candidate;
#   running it is Will's step.
# - run while a local parity run (bake-off or gate) is using the GPU, or while
#   another cycle holds the lock.
#
# Exit 0 for every recorded outcome (NO_DATA, DEFER, REJECT, HOLD...): the outcome
# is in state.json and the log, and launchd shouldn't treat "nothing to do" as a
# crash. Exit 1 only for a broken setup (no training python, bad profile).

setopt pipe_fail no_unset

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h:h:h}

# Globals, so the EXIT trap can clean up whatever stage the cycle reached.
PROFILE=${FLINT_BRAIN_PROFILE:-muse-glimmer-30b}
BRAIN=${FLINT_BRAIN_DIR:-$HOME/.flint/brain}
CYCLES=$BRAIN/cycles
STATE=$CYCLES/state.json
LOCK=$BRAIN/cycle.lock.d
TRAINING_MARK=$BRAIN/TRAINING.json
PY=${FLINT_TRAIN_PY:-$HOME/.flint-train/venv/bin/python}
PROFILE_SHA=""
ID=""
DIR=""
TAG=""
HOLDS_LOCK=0

stamp() { print -r -- "[$(date '+%Y-%m-%d %H:%M')] $*"; }

record() {  # record RESULT [key=value ...]; no-op before the cycle has an id
  [[ -n $ID ]] || return 0
  local result=$1; shift
  local -a sets=(--set "profile=\"$PROFILE\"" --set "profileSha=\"$PROFILE_SHA\"")
  local kv
  for kv in "$@"; do sets+=(--set "$kv"); done
  "$PY" "$SCRIPT_DIR/cycle_state.py" --state "$STATE" record --id "$ID" --result "$result" "${sets[@]}"
}

cleanup() {
  rm -f "$TRAINING_MARK"
  if [[ -n $TAG ]] && command -v ollama >/dev/null; then ollama stop "$TAG" >/dev/null 2>&1; fi
  (( HOLDS_LOCK )) && rm -rf "$LOCK"
  return 0
}
trap cleanup EXIT
trap 'stamp "interrupted"; record ERROR reason="\"interrupted\""; exit 130' INT TERM HUP

pyget() {  # pyget '<json>' key [key...]: print one nested value
  "$PY" -c '
import json, sys
v = json.loads(sys.argv[1])
for k in sys.argv[2:]:
    v = v[k]
print(v)' "$@"
}

main() {
  local IF_DUE=0 FORCE=0 DRY=0
  while (( $# )); do
    case $1 in
      --if-due) IF_DUE=1 ;;
      --force) FORCE=1 ;;
      --dry-run) DRY=1 ;;
      --profile) shift; PROFILE=$1 ;;
      -h|--help) sed -n '2,29p' "$SCRIPT_DIR/cycle.sh"; return 0 ;;
      *) print -u2 "cycle.sh: unknown flag $1"; return 1 ;;
    esac
    shift
  done

  if [[ ! -x $PY ]]; then
    if (( DRY )) && command -v python3 >/dev/null; then
      PY=$(command -v python3)
    else
      print -u2 "cycle.sh: no training python at $PY. Run apps/train/mlx/setup_train_env.sh (or set FLINT_TRAIN_PY)."
      return 1
    fi
  fi
  cd "$SCRIPT_DIR" || return 1

  P() { "$PY" "$SCRIPT_DIR/profiles.py" --profile "$PROFILE" get "$1"; }
  PROFILE_SHA=$("$PY" -c 'import sys; sys.path.insert(0, sys.argv[1]); from profiles import load_profile; print(load_profile(sys.argv[2])["_sha256"])' "$SCRIPT_DIR" "$PROFILE") \
    || { print -u2 "cycle.sh: bad profile $PROFILE"; return 1; }
  local MIN_TRAIN PREFIX THINK VARIANT MAX_HOURS
  MIN_TRAIN=$(P train.min_train); PREFIX=$(P base.candidate_prefix); THINK=$(P serve.think)
  VARIANT=$(P serve.variant); MAX_HOURS=$(P early_stop.max_hours)

  # --- never compete with a local parity run for the GPU (its latencies would be wrong too)
  if pgrep -f 'cli\.ts run.*--(flint-local|local-model)|gate-cli\.ts' >/dev/null 2>&1; then
    stamp "a local parity run (bake-off or gate) is active: not training now"
    (( DRY )) || return 0
  fi

  # --- is a cycle due?
  local COUNT WHY
  COUNT=$("$PY" build_data.py --profile "$PROFILE" --count-only) || { print -u2 "cycle.sh: build_data --count-only failed"; return 1; }
  stamp "data: $COUNT"
  if (( IF_DUE && ! FORCE )); then
    WHY=$("$PY" cycle_state.py --state "$STATE" due --count-json "$COUNT" --profile-sha "$PROFILE_SHA" --min-train "$MIN_TRAIN")
    if (( $? != 0 )); then
      stamp "not due: $WHY"
      return 0
    fi
    stamp "due: $WHY"
  fi

  if (( DRY )); then
    stamp "dry run: would build data, memcheck, train ($PROFILE), package ${PREFIX}:c<id>, gate it (think=$THINK variant=${VARIANT:-live}) and record. Nothing else ran."
    return 0
  fi

  # --- one cycle at a time (mkdir is atomic; a dead holder's lock is reclaimed)
  mkdir -p "$CYCLES"
  if ! mkdir "$LOCK" 2>/dev/null; then
    local HOLDER
    HOLDER=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [[ -n $HOLDER ]] && kill -0 "$HOLDER" 2>/dev/null; then
      stamp "another cycle (pid $HOLDER) holds $LOCK"
      return 0
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" || return 1
  fi
  HOLDS_LOCK=1
  print $$ > "$LOCK/pid"

  ID=$(date +%Y%m%d-%H%M)
  DIR=$CYCLES/$ID
  mkdir -p "$DIR"
  ln -sfn "$DIR" "$CYCLES/latest"
  # From here on everything is also in the cycle's own log (training_status reads it).
  exec > >(tee -a "$DIR/cycle.log") 2>&1

  stamp "cycle $ID: profile=$PROFILE"
  record STARTED

  # 1. data
  local -a LOCAL_PROMPT_ARGS=()
  if [[ -n ${FLINT_LOCAL_PROMPT:-} && -f ${FLINT_LOCAL_PROMPT:-} ]]; then LOCAL_PROMPT_ARGS=(--local-prompt "$FLINT_LOCAL_PROMPT"); fi
  "$PY" build_data.py --profile "$PROFILE" --out "$DIR/data" "${LOCAL_PROMPT_ARGS[@]}"
  case $? in
    0) ;;
    4) stamp "NO_DATA (see $DIR/data/manifest.json)"; record NO_DATA; return 0 ;;
    3) stamp "CONTAMINATED: eval prompts survived filtering; nothing trained"; record CONTAMINATED; return 0 ;;
    *) stamp "build_data failed"; record ERROR reason='"build_data"'; return 0 ;;
  esac
  local TARGETS
  TARGETS=$(pyget "$(cat "$DIR/data/manifest.json")" counts targets)

  # 2. memory: fit next to the live model, or defer
  local MEM MEMRC
  MEM=$("$PY" memcheck.py --profile "$PROFILE" --cycles-dir "$CYCLES")
  MEMRC=$?
  print -r -- "$MEM" > "$DIR/memcheck.json"
  if (( MEMRC != 0 )); then
    stamp "DEFER: $MEM"; record DEFER targets=$TARGETS; return 0
  fi
  local SEQ LAYERS BUDGET HOURS
  SEQ=$(pyget "$MEM" maxSeqLength); LAYERS=$(pyget "$MEM" numLayers); BUDGET=$(pyget "$MEM" memBudgetGb)

  # Training ends by 07:00 local (Will's day), and never runs past the profile's limit.
  HOURS=$("$PY" -c '
import datetime as d, sys
now = d.datetime.now(); stop = now.replace(hour=7, minute=0, second=0, microsecond=0)
if stop <= now: stop += d.timedelta(days=1)
print(round(min(float(sys.argv[1]), (stop - now).total_seconds() / 3600), 2))' "$MAX_HOURS")
  if "$PY" -c 'import sys; sys.exit(0 if float(sys.argv[1]) < 0.5 else 1)' "$HOURS"; then
    stamp "DEFER: only ${HOURS}h left before 07:00"; record DEFER targets=$TARGETS; return 0
  fi

  # 3. train (background priority; the callback preempts on memory pressure)
  print -r -- "{\"pid\": $$, \"cycle\": \"$ID\", \"since\": \"$(date -u +%FT%TZ)\"}" > "$TRAINING_MARK"
  stamp "training: footprint ${SEQ}x${LAYERS}, budget ${BUDGET} GB, up to ${HOURS} h"
  taskpolicy -b "$PY" train_lora.py --profile "$PROFILE" --data "$DIR/data" --out "$DIR/adapter" \
    --max-seq-length "$SEQ" --num-layers "$LAYERS" --mem-budget-gb "$BUDGET" --max-hours "$HOURS"
  local TRC=$?
  rm -f "$TRAINING_MARK"
  case $TRC in
    0) ;;
    10) stamp "NO_CANDIDATE: no eval beat the base"; record NO_CANDIDATE targets=$TARGETS; return 0 ;;
    75) stamp "PREEMPTED: yielded to the live model"; record PREEMPTED targets=$TARGETS; return 0 ;;
    *) stamp "train_lora failed (exit $TRC)"; record ERROR targets=$TARGETS reason='"train_lora"'; return 0 ;;
  esac

  # 4. package into Ollama under a new tag (never the live model's)
  TAG="${PREFIX}:c${ID}"
  if ! "$SCRIPT_DIR/package_candidate.sh" --profile "$PROFILE" --adapter "$DIR/adapter" --out "$DIR/fused" --tag "$TAG"; then
    stamp "PACKAGE_FAILED"; record PACKAGE_FAILED targets=$TARGETS; TAG=""; return 0
  fi

  # 5. the gate: candidate vs GPT-5, compared with the live local model vs GPT-5
  stamp "judging candidate $TAG against GPT-5 through the parity gate..."
  local THINK_FLAG=off
  [[ $THINK == true ]] && THINK_FLAG=on
  local -a GATE_ARGS=(--candidate "$TAG" --candidate-think "$THINK_FLAG" --manifest "$DIR/data/manifest.json" --verdict-out "$DIR/gate.json" --budget-usd "${FLINT_GATE_BUDGET_USD:-30}")
  [[ -n $VARIANT ]] && GATE_ARGS+=(--candidate-variant "$VARIANT")
  ( cd "$REPO_ROOT" && pnpm --silent --filter @flint/parity gate "${GATE_ARGS[@]}" )
  local GRC=$? RESULT
  case $GRC in
    0) RESULT=PROMOTE ;;
    1) RESULT=REJECT ;;
    3) RESULT=HOLD ;;
    *) RESULT=GATE_ERROR ;;
  esac
  ollama stop "$TAG" >/dev/null 2>&1
  record "$RESULT" targets=$TARGETS candidate="\"$TAG\"" gate="\"$DIR/gate.json\""
  stamp "verdict: $RESULT"
  case $RESULT in
    PROMOTE)
      cat <<EOF
Candidate $TAG beat the live local model against GPT-5 (details: $DIR/gate.json).
Promotion is yours to run (nothing here changes what Flint serves):
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:OLLAMA_MODEL $TAG" ~/Library/LaunchAgents/com.flint.server.plist
  launchctl kickstart -k gui/\$(id -u)/com.flint.server
EOF
      ;;
    REJECT)
      # Nothing will ever serve it: free the disk (the Ollama copy; the fused weights below).
      ollama rm "$TAG" >/dev/null 2>&1
      ;;
    HOLD)
      print -r -- "HOLD keeps $TAG in Ollama for a re-gate by hand (see $DIR/gate.json for why); \`ollama rm $TAG\` when done with it."
      ;;
  esac
  # Ollama holds its own copy and adapter/ can be re-fused: the ~17 GB fused dir is never needed again.
  rm -rf "$DIR/fused"
  TAG=""
  stamp "=== CYCLE DONE ==="
  return 0
}

main "$@"
