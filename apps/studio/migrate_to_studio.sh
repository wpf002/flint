#!/bin/zsh
# migrate_to_studio.sh — ONE COMMAND, run from your LAPTOP, to move Flint onto the
# Mac Studio and start the roadmap that turns him into a real, owned 70B AI.
#
# It does three things, in order:
#   1. carries Flint's LIFE over  — memory, the banked training corpus, secrets,
#      the brain (training) harness + data, and the LaunchAgents.
#   2. bootstraps the Studio       — toolchain, clones the repo, rebuilds the server,
#      loads every agent, so Flint is LIVE on the new machine (still on the Claude
#      teacher for now).
#   3. starts the roadmap          — pulls the 70B and launches the overnight
#      fine-tune, detached, plus the daily/weekly flywheel.
#
# PREREQ (do once, on the Studio — see docs/REMOTE_ACCESS.md):
#   - Remote Login (SSH) = ON   (System Settings > General > Sharing)
#   - Tailscale installed + signed in with the SAME account as this laptop,
#     so `studio` is reachable from anywhere.
#
# USAGE:
#   STUDIO=willfoti@studio ./apps/studio/migrate_to_studio.sh      # full run
#   ./apps/studio/migrate_to_studio.sh --dry-run                   # show, change nothing
#   ./apps/studio/migrate_to_studio.sh --with-models               # also copy ollama blobs (~40GB)
#   ./apps/studio/migrate_to_studio.sh --no-roadmap                # migrate only, don't start training
#   ./apps/studio/migrate_to_studio.sh --studio=willfoti@100.x.y.z # explicit host
#
set -uo pipefail

STUDIO="${STUDIO:-willfoti@studio}"
DRY=0; WITH_MODELS=0; ROADMAP=1
for a in "$@"; do
  case "$a" in
    --dry-run)      DRY=1 ;;
    --with-models)  WITH_MODELS=1 ;;
    --no-roadmap)   ROADMAP=0 ;;
    --studio=*)     STUDIO="${a#--studio=}" ;;
    -h|--help)      sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a (try --help)"; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_URL="$(git -C "$REPO" remote get-url origin)"
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
SSH_OPTS=(-o ConnectTimeout=10 -o BatchMode=yes)
say(){ echo; echo "== $*"; }

say "target=$STUDIO  repo=$REPO_URL@$BRANCH  dry=$DRY with_models=$WITH_MODELS roadmap=$ROADMAP"

# ---- 0. preflight: can we reach the Studio over SSH? ----------------------
say "preflight — SSH to $STUDIO"
if ! ssh "${SSH_OPTS[@]}" "$STUDIO" 'echo ok' >/dev/null 2>&1; then
  cat <<EOF
  ✗ CANNOT SSH to $STUDIO.
  On the Mac Studio, do the one-time setup (docs/REMOTE_ACCESS.md):
    1. System Settings > General > Sharing > Remote Login = ON
    2. Install Tailscale, sign in with the SAME account as this laptop
    3. Confirm the name:  ping studio   (or pass --studio=willfoti@100.x.y.z)
  Then re-run this.
EOF
  exit 1
fi
echo "  ✓ reachable"

# The Studio clones code from GitHub, so unpushed local commits won't be there.
if [ -n "$(git -C "$REPO" log --oneline "origin/$BRANCH..HEAD" 2>/dev/null)" ]; then
  echo "  ! WARNING: you have local commits not on origin/$BRANCH."
  echo "            push first so the Studio gets them:  git push origin $BRANCH"
fi

# NO --info=progress2: macOS ships openrsync ("rsync version 2.6.9 compatible"),
# which rejects that flag, copies ZERO files, and — with no set -e — lets the
# script sail on and report success. Verified on macOS 26.6.2. Plain -aH is
# portable across openrsync and real rsync.
RSYNC=(rsync -aH \
  --exclude '.venv' --exclude 'logs/' --exclude '*.log' \
  --exclude 'server.mjs' --exclude '.DS_Store')
[ "$DRY" = 1 ] && RSYNC+=(-n)

# ---- 1. carry Flint's LIFE over -------------------------------------------
say "1/3 sync ~/.flint  (memory + training corpus + secrets + brain harness/data)"
"${RSYNC[@]}" "$HOME/.flint/" "$STUDIO:.flint/" || {
  echo "  ✗ ~/.flint sync FAILED — this is the whole migration (memory, corpus,"
  echo "    secrets, brain). Aborting rather than leaving a half-built Studio."
  exit 1
}
if [ "$DRY" != 1 ]; then
  # Prove it actually landed. openrsync failing silently is exactly how this
  # would otherwise "succeed" with an empty ~/.flint on the Studio.
  for must in secrets.env training/corpus.jsonl memory/knowledge.json brain/prepare_data.py; do
    ssh "${SSH_OPTS[@]}" "$STUDIO" "test -e \$HOME/.flint/$must" || {
      echo "  ✗ ~/.flint/$must is missing on the Studio after sync — aborting."; exit 1; }
  done
  echo "  ✓ verified secrets, corpus, memory and brain landed"
fi

say "1/3 sync LaunchAgents (com.flint.* + com.nexus.*)"
# (N) = zsh null_glob: an unmatched pattern expands to nothing instead of aborting
# the script (zsh's default NOMATCH would kill the run here).
plists=( "$HOME"/Library/LaunchAgents/com.flint.*.plist(N) "$HOME"/Library/LaunchAgents/com.nexus.*.plist(N) )
if (( ${#plists} == 0 )); then
  echo "  ! no agent plists matched (ok if none yet)"
elif [ "$DRY" = 1 ]; then
  echo "  [dry] rsync ${#plists} plist(s) -> $STUDIO:Library/LaunchAgents/"
else
  rsync -aH "${plists[@]}" "$STUDIO:Library/LaunchAgents/"
fi

if [ "$WITH_MODELS" = 1 ]; then
  # The weights live in ~/.ollama/models (~38GB), NOT ~/.flint-ollama — that dir
  # only holds the runtime bits. Copying the latter moved zero model bytes.
  say "1/3 sync ollama models (~$(du -sh "$HOME/.ollama/models" 2>/dev/null | cut -f1) — large, be patient)"
  "${RSYNC[@]}" "$HOME/.ollama/" "$STUDIO:.ollama/" || echo "  ! model sync failed; the Studio can re-pull instead"
  [ -d "$HOME/.flint-ollama" ] && "${RSYNC[@]}" "$HOME/.flint-ollama/" "$STUDIO:.flint-ollama/"
else
  echo "  (skipping ollama model blobs — the Studio re-pulls them; use --with-models to copy)"
fi

# ---- 2. bootstrap the Studio ----------------------------------------------
say "2/3 bootstrap the Studio (toolchain + clone + build + load agents)"
if [ "$DRY" = 1 ]; then
  echo "  [dry] scp studio_bootstrap.sh; ssh REPO_URL=$REPO_URL FLINT_BRANCH=$BRANCH zsh /tmp/studio_bootstrap.sh"
else
  scp "${SSH_OPTS[@]}" "$REPO/apps/studio/studio_bootstrap.sh" "$STUDIO:/tmp/studio_bootstrap.sh"
  ssh "${SSH_OPTS[@]}" "$STUDIO" "REPO_URL='$REPO_URL' FLINT_BRANCH='$BRANCH' /bin/zsh /tmp/studio_bootstrap.sh"
fi

# ---- 2b. secrets the clone cannot carry -----------------------------------
# apps/responder/.env is gitignored, so GitHub does not have it, and it lives
# outside ~/.flint, so the rsync above does not either. It holds the three Nexus
# tokens AND the only copy of PERPLEXITY_API_KEY. Without it com.nexus.responder
# throws on an unset token and relaunches every 60s forever.
if [ -f "$REPO/apps/responder/.env" ]; then
  say "2b/3 carry apps/responder/.env (Nexus tokens + Perplexity key)"
  if [ "$DRY" = 1 ]; then
    echo "  [dry] rsync apps/responder/.env -> $STUDIO:flint/apps/responder/.env"
  else
    rsync -aH "$REPO/apps/responder/.env" "$STUDIO:flint/apps/responder/.env" \
      && echo "  ✓ responder secrets carried" \
      || echo "  ! could not copy apps/responder/.env — Nexus responder will not start"
  fi
fi

# trident/.env is gitignored too and holds its Google OAuth credentials.
if [ -f "$HOME/Documents/GitHub/trident/.env" ]; then
  say "2b/3 carry trident/.env (Google OAuth for gmail/gcal/gdrive)"
  if [ "$DRY" = 1 ]; then
    echo "  [dry] rsync trident/.env -> $STUDIO:Documents/GitHub/trident/.env"
  else
    ssh "${SSH_OPTS[@]}" "$STUDIO" 'mkdir -p $HOME/Documents/GitHub/trident' 2>/dev/null || true
    rsync -aH "$HOME/Documents/GitHub/trident/.env" "$STUDIO:Documents/GitHub/trident/.env" \
      && echo "  ✓ trident secrets carried" || echo "  ! trident/.env not copied"
  fi
fi

# ---- 3. start the roadmap -------------------------------------------------
if [ "$ROADMAP" = 1 ]; then
  say "3/3 start the roadmap (pull 70B + launch the overnight fine-tune, detached)"
  if [ "$DRY" = 1 ]; then
    echo "  [dry] ssh zsh ~/flint/apps/studio/studio_roadmap.sh"
  else
    ssh "${SSH_OPTS[@]}" "$STUDIO" '/bin/zsh $HOME/flint/apps/studio/studio_roadmap.sh'
  fi
else
  echo "  (--no-roadmap: skipped training kickoff — run studio_roadmap.sh on the Studio when ready)"
fi

say "DONE — Flint is live on the Studio (Claude teacher for now)."
cat <<EOF
  Talk to him:     http://studio:8080
  Watch training:  ssh $STUDIO 'tail -f ~/.flint/brain/upgrade.out'
  When it finishes and evals well, SERVE the 70B and FLIP to primary:
    docs/MAC_STUDIO_UPGRADE.md steps 3-4  (human-gated on the eval verdict —
    that's the moment Flint becomes his own AI).
EOF
