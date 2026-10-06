#!/bin/zsh
# Auto-deploy: the Mac Studio pulls the latest code from GitHub and rebuilds
# Flint whenever you push. Runs on a timer (com.flint.deploy). Your workflow:
# edit code anywhere -> git push -> within a couple minutes the Studio pulls it
# and Flint updates itself. No manual steps on the Studio.
set -e
REPO="${FLINT_REPO:-$HOME/flint}"   # the deploy-only checkout; never point this at a dev clone
cd "$REPO"

STATE="${FLINT_STATE_DIR:-$HOME/.flint}"
EVENTS="$HOME/.flint/deploy-events.jsonl"   # where the install scripts' deploy_event writes
RUNTIME_DIR="$HOME/.flint/runtime"
# A deploy that failed at its gate (typecheck and tests, before anything live is
# touched) is retried every 30 minutes, up to 6 times, without waiting for the
# next push: a flaky test or a busy test database should not strand a merge.
# Failures past the gate (a migration, a restart, a health check) are not
# retried: they need a look, and the next push deploys again. The file holds
# "<sha> <parts> <tries> <retryable>", parts the comma-joined server,runtime.
RETRY="$STATE/deploy-retry"
# "<sha> <live>": a runtime deploy that failed past its gate, and the release that
# was live then. Until a push changes the runtime's own code (HELD_PATHS, where a
# fix for a migration or a boot crash lands), later pushes leave the runtime where
# it is instead of repeating the failure (and its escalation) against the live
# database on every merge. Forgotten once a runtime deploys, or the live release
# changes some other way (a deploy by hand).
RUNTIME_HELD="$STATE/runtime-held"
# What the runtime bundle is built from: its code, the packages it imports, the lockfile.
RUNTIME_PATHS='^(apps/runtime/|packages/(policy|core)/|pnpm-lock\.yaml$)'
HELD_PATHS='^(apps/runtime/|packages/policy/)'
RETRY_EVERY_MIN=30
RETRY_MAX=6
ts() { date '+%F %T'; }

before=$(git rev-parse HEAD 2>/dev/null || echo none)
# A stalled connection used to hold the fetch ~3 minutes, past the next tick.
# Abort once the transfer drops below 1 KB/s for 20s; the next run retries.
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet origin main || { echo "$(ts) fetch failed"; exit 0; }
git reset --hard --quiet origin/main   # match GitHub exactly (Studio is deploy-only, never edited directly)
after=$(git rev-parse HEAD)

# The last deploy event of component $1 at sha $2, as "<stage> <outcome>" (empty if none).
last_event() {
  [ -f "$EVENTS" ] || return 0
  grep -F "\"component\":\"$1\"" "$EVENTS" | grep -F "\"sha\":\"$2\"" | tail -n 1 \
    | sed -nE 's/.*"stage":"([a-z]+)","outcome":"([a-z]+)".*/\1 \2/p'
}
# The runtime release that is live (its sha), empty when there is none.
runtime_live() { local l; l=$(readlink "$RUNTIME_DIR/current" 2>/dev/null) && echo "${l:t}"; }
# Is a part of $2 live? The server once it logged "deploy ok" for it (also after
# a deploy by hand); the runtime once its current release is it (install-runtime.sh
# exits 0 without deploying a sha whose migration failed before).
is_live() {
  case $1 in
    server) [ "$(last_event server "$2")" = "deploy ok" ] ;;
    runtime) [ "$(runtime_live)" = "$2" ] ;;
  esac
}
# Does the runtime need deploying at $1? Not installed yet, or what it is built
# from changed since the live release, which also carries a runtime that failed
# at its gate under an earlier sha to the next push. Held (it failed past its
# gate): only once what it is built from changed since the held sha.
runtime_wanted() {
  [ -x ./apps/runtime/install-runtime.sh ] || return 1
  local live held held_live
  live=$(runtime_live)
  [ -n "$live" ] || return 0
  [ "$live" = "$1" ] && return 1
  if [ -s "$RUNTIME_HELD" ]; then read -r held held_live < "$RUNTIME_HELD" || true; fi
  if [ -n "$held" ] && [ "$held_live" != "$live" ]; then rm -f "$RUNTIME_HELD"; held=""; fi
  if [ -n "$held" ] && git cat-file -e "$held^{commit}" 2>/dev/null; then
    [ "$held" = "$1" ] && return 1
    git diff --name-only "$held" "$1" 2>/dev/null | grep -qE "$HELD_PATHS"
    return
  fi
  git cat-file -e "$live^{commit}" 2>/dev/null || return 0
  git diff --name-only "$live" "$1" 2>/dev/null | grep -qE "$RUNTIME_PATHS"
}

# Deploys the given parts of $1 and leaves the ones that failed in $failed, and
# whether every failure was at the gate in $retryable.
deploy() {
  local sha=$1 parts=$2 part
  failed=""
  retryable=1
  # A pulled commit can add or bump a dependency. install-server.sh now runs a
  # gate (typecheck + tests) that needs devDependencies present, so install
  # before building or the deploy fails on a missing package rather than on
  # anything actually wrong with the code.
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || \
    echo "$(ts) WARNING: pnpm install failed; build may fail"
  # The gate is never skipped unattended: FLINT_SKIP_TESTS is for a person at the
  # keyboard, not for a timer that deploys whatever lands on main.
  unset FLINT_SKIP_TESTS
  # The server and the runtime deploy independently (Machine plan 3.0.6): either
  # can fail without stopping the other. The log lines are the ones the
  # runtime's git source reads (apps/runtime/src/sources/git.ts).
  if [[ ",$parts," == *,server,* ]]; then
    if ./apps/server/install-server.sh; then echo "$(ts) deployed $sha"
    else echo "$(ts) server deploy FAILED at $sha"; failed=server; fi
  fi
  if [[ ",$parts," == *,runtime,* ]]; then
    if ./apps/runtime/install-runtime.sh && is_live runtime "$sha"; then
      echo "$(ts) runtime deployed $sha"; rm -f "$RUNTIME_HELD"
    else
      echo "$(ts) runtime deploy FAILED at $sha (the server is unaffected)"; failed="${failed:+$failed,}runtime"
      [ "$(last_event runtime "$sha")" = "gate failed" ] || { mkdir -p "$STATE"; echo "$sha $(runtime_live)" > "$RUNTIME_HELD"; }
    fi
  fi
  for part in ${(s:,:)failed}; do
    [ "$(last_event "$part" "$sha")" = "gate failed" ] || retryable=0
  done
}
# Writes the retry file: $1 sha, $2 parts, $3 tries, $4 retryable; or removes it.
remember() {
  if [ -n "$2" ]; then mkdir -p "$STATE"; echo "$1 $2 $3 $4" > "$RETRY"; else rm -f "$RETRY"; fi
}
# What a tick with nothing to do says about $1.
quiet() {
  if [[ ",$2," == *,server,* ]]; then echo "$(ts) server deploy FAILED at $1 ($3)"; else echo "$(ts) up to date ($1)"; fi
}

failed=""
rsha="" rparts="" rtries=0 rretry=0
# A last line without a newline makes read return 1 after filling the fields: never fatal here.
if [ -s "$RETRY" ]; then read -r rsha rparts rtries rretry < "$RETRY" || true; fi
if [ "$before" != "$after" ]; then
  echo "$(ts) new code $before -> $after — redeploying Flint..."
  parts=server
  runtime_wanted "$after" && parts=server,runtime
  # Written first, so a run cut short (a restart, a logout) is retried too.
  remember "$after" "$parts" 0 1
  deploy "$after" "$parts"
  remember "$after" "$failed" 0 "$retryable"
elif [ "$rsha" = "$after" ]; then
  # What has gone live since (a deploy by hand) is no longer pending.
  left=""
  for part in ${(s:,:)rparts}; do is_live "$part" "$after" || left="${left:+$left,}$part"; done
  [[ ",$left," == *,runtime,* ]] || [[ ",$rparts," != *,runtime,* ]] || rm -f "$RUNTIME_HELD"
  if [ -z "$left" ]; then
    remember "$after" "" 0 0
    echo "$(ts) up to date ($after)"
  elif [ "$rretry" != 1 ] || [ "$rtries" -ge "$RETRY_MAX" ] 2>/dev/null; then
    [ "$left" = "$rparts" ] || remember "$after" "$left" "$rtries" "$rretry"
    quiet "$after" "$left" "waiting for the next push"
  elif [ -n "$(find "$RETRY" -mmin +$((RETRY_EVERY_MIN - 1)) 2>/dev/null)" ]; then
    echo "$(ts) retrying the failed deploy of $after ($left), attempt $((rtries + 1)) of $RETRY_MAX"
    remember "$after" "$left" $((rtries + 1)) 1
    deploy "$after" "$left"
    remember "$after" "$failed" $((rtries + 1)) "$retryable"
  else
    quiet "$after" "$left" "retrying"
  fi
else
  # No retry pending, yet the server may have failed at this commit under a run that
  # wrote none (the previous version of this script, on the tick that brought this one).
  case "$(last_event server "$after")" in
    "gate failed") remember "$after" server 0 1; quiet "$after" server "retrying" ;;
    *" failed") quiet "$after" server "waiting for the next push" ;;
    *) echo "$(ts) up to date ($after)" ;;
  esac
fi
# A failed server deploy fails this run.
[[ ",$failed," == *,server,* ]] && exit 1

# The native app is not part of the server deploy. Checked every tick, not only
# on new code; it does nothing unless apps/desktop-mac changed since it last built.
# Only once the server is live at this commit: the app and the console it shows
# come from the same commit, so a new app never opens onto an older console.
if is_live server "$after"; then
  ./apps/desktop-mac/update_app.sh || echo "$(date '+%F %T') app: update_app.sh failed"
else
  echo "$(date '+%F %T') app: waiting for the server to deploy $after"
fi

# Flint Calendar, the Apple Calendar helper (apps/desktop-calendar): the same,
# once the runtime it pushes to is live with this commit's code (its release is
# this commit, or no runtime path changed since its release), so a new wire
# format reaches the runtime before the helper sends it. A runtime held after a
# failed deploy is not current, and the helper waits for it.
runtime_current() {
  local live
  live=$(runtime_live)
  [ -n "$live" ] || return 1
  [ "$live" = "$1" ] && return 0
  git cat-file -e "$live^{commit}" 2>/dev/null || return 1
  ! git diff --name-only "$live" "$1" 2>/dev/null | grep -qE "$RUNTIME_PATHS"
}
if [ -x ./apps/desktop-calendar/update_calendar.sh ]; then
  if runtime_current "$after"; then
    ./apps/desktop-calendar/update_calendar.sh || echo "$(date '+%F %T') calendar: update_calendar.sh failed"
  else
    echo "$(date '+%F %T') calendar: waiting for the runtime to deploy $after"
  fi
fi
