#!/bin/zsh
# install-server.sh — build the Flint gateway server into a self-contained
# bundle at ~/.flint/server.mjs and reload its LaunchAgent.
#
# esbuild reads apps/server/src/index.ts directly but resolves the @flint/*
# workspace deps via their dist output, so core + persona are rebuilt first to
# fold in any provider/persona changes. Re-run after editing the server, the
# Ollama provider, or the persona.

set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$HOME/.flint"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="com.flint.server.plist"
mkdir -p "$DATA" "$AGENTS"
SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"

# Deploy events (DeployEvent in packages/policy/src/wire.ts): one JSON line per
# failed stage or finished deploy in ~/.flint/deploy-events.jsonl (0600), read
# by the runtime's `deploy` source. Ids and enums only, never log text. Writing
# it can never fail the install: errexit is off inside, and it always returns 0.
# (The same function is in apps/runtime/install-runtime.sh; a test keeps the two identical.)
deploy_event() { # <server|runtime> <gate|migrate|restart|health|deploy> <ok|failed> <sha>
  emulate -L zsh
  setopt no_err_exit no_err_return no_pipefail
  local dir="$HOME/.flint" id at
  [[ $1 == (server|runtime) && $2 == (gate|migrate|restart|health|deploy) && $3 == (ok|failed) && $4 =~ '^[0-9a-f]{40}$' ]] || return 0
  id="$(openssl rand -hex 16 2>/dev/null)"
  [[ $id =~ '^[0-9a-f]{32}$' ]] || return 0
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  [[ $at =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' ]] || return 0
  { mkdir -p -m 700 "$dir" && chmod 700 "$dir"; } 2>/dev/null || return 0
  ( umask 077; print -r -- "{\"id\":\"$id\",\"at\":\"$at\",\"component\":\"$1\",\"stage\":\"$2\",\"outcome\":\"$3\",\"sha\":\"$4\"}" >> "$dir/deploy-events.jsonl" ) 2>/dev/null || return 0
  chmod 600 "$dir/deploy-events.jsonl" 2>/dev/null
  return 0
}
# Flint Calendar's Swift checks (desktop-calendar.test.ts: the typecheck, the core
# tests, the cut against fitToBudget, the binary scan) run in the gate only when
# this deploy changes the helper or the wire it shares with the runtime since the
# last server deploy that finished, or when that deploy is unknown
# (FLINT_REQUIRE_SWIFT=1: swiftc must be there and every check must pass).
# Otherwise they are skipped (FLINT_REQUIRE_SWIFT=0), so a Swift toolchain that
# a Software Update broke never holds back a server deploy that doesn't touch the
# helper; install_calendar.sh runs the core tests and both scans again before it
# installs anything.
CALENDAR_PATHS='^(apps/desktop-calendar/|apps/runtime/src/sources/apple/|apps/runtime/src/routes/apple-calendar\.ts$|apps/runtime/src/sources/text\.ts$|apps/runtime/test/fixtures/apple-calendar-snapshot\.json$|apps/server/test/desktop-calendar\.test\.ts$)'
calendar_changed() { # 0: changed since the last finished server deploy, or that deploy is unknown; 1: not changed
  local last files
  last=$(grep -F '"component":"server"' "$DATA/deploy-events.jsonl" 2>/dev/null | grep -F '"stage":"deploy","outcome":"ok"' | tail -n 1 | sed -nE 's/.*"sha":"([0-9a-f]{40})".*/\1/p')
  [ -n "$last" ] && git -C "$REPO" cat-file -e "$last^{commit}" 2>/dev/null || return 0
  # Against the working tree, so a deploy by hand from a checkout with changes counts them too.
  files=$(git -C "$REPO" diff --name-only "$last" -- 2>/dev/null) || return 0
  print -r -- "$files" | grep -E "$CALENDAR_PATHS" >/dev/null
}
# The rebuild rehearsal (apps/studio/test/rebuild_rehearse.test.sh: a made-up Flint
# backed up and rebuilt into a scratch folder, about 45 s) runs in the gate only
# when this deploy changes something a rebuild is made of since the last server
# deploy that finished, when that deploy is unknown, or when FLINT_REHEARSE=1 asks
# for it, so a merge that touches none of it no longer waits for it. The other
# studio tests always run. It runs through apps/studio/run_rehearsal.sh, with
# FLINT_REQUIRE_REHEARSAL=1 (a missing tool fails it, never skips it), and its
# result is kept for Settings > Health. The same script runs it every week
# (com.flint.rebuild-rehearsal, below), so a rebuild that stopped working for a
# reason no deploy shows is still found.
REHEARSAL_PATHS='^(apps/studio/|docs/RECOVERY\.md$|apps/runtime/(src/backup/|src/cli\.ts$|src/config\.ts$|src/index\.ts$|scripts/bootstrap-db\.ts$|prisma/|install-runtime\.sh$|package\.json$)|apps/server/(install-server\.sh$|auto_deploy\.sh$|src/(index|internal|access|mcp-config)\.ts$|com\.flint\.deploy\.plist$)|apps/evolve/com\.flint\.evolve\.plist$|packages/policy/src/|packages/mcp/connectors/|test-support/quiet-bin/|pnpm-lock\.yaml$|package\.json$|pnpm-workspace\.yaml$)'
rehearsal_changed() { # 0: changed since the last finished server deploy, or that deploy is unknown; 1: not changed
  local last files
  last=$(grep -F '"component":"server"' "$DATA/deploy-events.jsonl" 2>/dev/null | grep -F '"stage":"deploy","outcome":"ok"' | tail -n 1 | sed -nE 's/.*"sha":"([0-9a-f]{40})".*/\1/p')
  [ -n "$last" ] && git -C "$REPO" cat-file -e "$last^{commit}" 2>/dev/null || return 0
  # Against the working tree, as calendar_changed does.
  files=$(git -C "$REPO" diff --name-only "$last" -- 2>/dev/null) || return 0
  print -r -- "$files" | grep -E "$REHEARSAL_PATHS" >/dev/null
}
# Which version each kept bundle is: one line, "<commit> <when it was installed, in
# seconds>", in server.version for server.mjs and in server.version.prev for
# server.mjs.prev. apps/studio/rollback.sh shows both before it goes back, and
# auto_deploy.sh reads the first to tell what is installed. Each line moves with
# its bundle. 0600; a line that cannot be worked out is left out, never guessed,
# and none of this can fail the install.
server_version() { # keep: the running bundle becomes .prev | set <sha>: server.mjs is this, installed now | back: .prev was put back
  emulate -L zsh
  setopt no_err_exit no_err_return no_pipefail
  local line= last sha= at= made=
  case $1 in
    keep)
      [[ -r $DATA/server.version ]] && IFS= read -r line < "$DATA/server.version"
      if [[ ! $line =~ '^[0-9a-f]{40} [0-9]{9,11}$' ]]; then
        # A bundle from before these lines were kept: it is the last server deploy that
        # finished, when that deploy ended within minutes of the bundle being written.
        line=
        last=$(grep -F '"component":"server"' "$DATA/deploy-events.jsonl" 2>/dev/null | grep -F '"stage":"deploy","outcome":"ok"' | tail -n 1)
        [[ $last =~ '"sha":"([0-9a-f]{40})"' ]] && sha=$match[1]
        [[ $last =~ '"at":"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)"' ]] && at=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$match[1]" +%s 2>/dev/null)
        made=$(stat -f %m "$DATA/server.mjs" 2>/dev/null)
        if [[ -n $sha && $at =~ '^[0-9]{9,11}$' && $made =~ '^[0-9]{9,11}$' ]] && (( at >= made - 60 && at - made <= 900 )); then line="$sha $made"; fi
      fi
      if [[ -n $line ]] && ( umask 077; print -r -- "$line" > "$DATA/server.version.prev" && chmod 600 "$DATA/server.version.prev" ) 2>/dev/null; then :; else rm -f "$DATA/server.version.prev"; fi ;;
    set)
      if [[ ${2:-} =~ '^[0-9a-f]{40}$' ]] && ( umask 077; print -r -- "$2 $(date +%s)" > "$DATA/server.version" && chmod 600 "$DATA/server.version" ) 2>/dev/null; then :; else rm -f "$DATA/server.version"; fi ;;
    back)
      if [[ -f $DATA/server.version.prev ]] && cp -p "$DATA/server.version.prev" "$DATA/server.version" 2>/dev/null; then :; else rm -f "$DATA/server.version"; fi ;;
  esac
  return 0
}
# The weekly rebuild rehearsal (apps/studio/run_rehearsal.sh, Sundays at 05:10): a
# LaunchAgent written here and (re)loaded only when its file changes, the way
# install-runtime.sh keeps the nightly database backup's. It runs from this
# checkout and on a timer only (no RunAtLoad: loading it starts nothing). The
# rehearsal keeps to scratch folders of its own, shows nothing, and leaves one
# line in ~/.flint/rehearsal-result, which Settings > Health reads.
REHEARSAL_LABEL="com.flint.rebuild-rehearsal"
install_rehearsal_agent() {
  local plist="$AGENTS/$REHEARSAL_LABEL.plist" node_bin pnpm_bin i
  node_bin="$(command -v node)" && pnpm_bin="$(command -v pnpm)" && [ -n "$node_bin" ] && [ -n "$pnpm_bin" ] || return 1
  cat > "$plist.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$REHEARSAL_LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$REPO/apps/studio/run_rehearsal.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$node_bin"):$(dirname "$pnpm_bin"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>5</integer><key>Minute</key><integer>10</integer></dict>
  <key>StandardOutPath</key><string>$DATA/rehearsal.out.log</string>
  <key>StandardErrorPath</key><string>$DATA/rehearsal.err.log</string>
</dict></plist>
PLIST
  chmod 600 "$plist.new"
  # A path that does not fit in a LaunchAgent file (a & or a < in a folder's name) is never loaded.
  plutil -lint "$plist.new" >/dev/null 2>&1 || { rm -f "$plist.new"; return 1; }
  if cmp -s "$plist.new" "$plist" && launchctl print "gui/$UID/$REHEARSAL_LABEL" >/dev/null 2>&1; then
    rm -f "$plist.new"
    return 0
  fi
  mv "$plist.new" "$plist"
  launchctl bootout "gui/$UID/$REHEARSAL_LABEL" 2>/dev/null || true
  for i in {1..20}; do launchctl print "gui/$UID/$REHEARSAL_LABEL" >/dev/null 2>&1 || break; sleep 0.25; done
  launchctl bootstrap "gui/$UID" "$plist" && echo "weekly rebuild rehearsal agent loaded (Sundays 05:10)"
}

# The server records a failed gate (the workspace build counts: nothing deploys
# without it) and a finished deploy. Past the gate, DEPLOY_STAGE is empty.
DEPLOY_STAGE=gate
trap '[ $? = 0 ] || [ -z "$DEPLOY_STAGE" ] || deploy_event server "$DEPLOY_STAGE" failed "$SHA"' EXIT

echo "building @flint/core + @flint/persona + @flint/mcp + @flint/policy..."
# ALL FOUR. apps/server imports @flint/mcp (src/index.ts, src/actions.ts) and
# packages/mcp resolves through its dist/, which is gitignored — so on a FRESH
# CLONE (i.e. the Mac Studio) skipping this build makes both the typecheck gate
# and esbuild fail with "Cannot find module @flint/mcp", and Flint never starts.
# It only worked here because a stale dist/ happened to be on disk.
pnpm --filter @flint/core build >/dev/null
pnpm --filter @flint/persona build >/dev/null
pnpm --filter @flint/mcp build >/dev/null
# isSafeTool and the tier engine live here (moved out of apps/server in P1).
pnpm --filter @flint/policy build >/dev/null

# ---- GATE: never deploy a broken Flint -----------------------------------
# (runs AFTER the workspace build — the server typechecks against their dist
# .d.ts, so stale types would produce phantom errors.)
# This script reloads the always-on assistant. Before it does, prove the code
# typechecks and the highest-consequence logic still behaves — the routing that
# decides whether a message leaves the machine, and the gate that decides
# whether a tool runs without asking. Set FLINT_SKIP_TESTS=1 to bypass in an
# emergency, by hand only (auto_deploy.sh clears it), and then fix what you skipped.
if [ "${FLINT_SKIP_TESTS:-0}" != "1" ]; then
  echo "gate: typechecking..."
  pnpm --filter server typecheck || { echo "✗ typecheck failed — NOT deploying"; exit 1; }
  echo "gate: server policy tests (brain routing + auto-approval)..."
  if calendar_changed; then
    SWIFT_CHECKS=1; echo "gate: Flint Calendar changed since the last deploy, so its Swift checks must run"
  else
    SWIFT_CHECKS=0; echo "gate: Flint Calendar unchanged since the last deploy, so its Swift checks are skipped"
  fi
  FLINT_REQUIRE_SWIFT=$SWIFT_CHECKS pnpm --filter server test || { echo "✗ server tests failed — NOT deploying"; exit 1; }
  echo "gate: policy typecheck + tests (isSafeTool, the tier engine, approval signatures)..."
  pnpm --filter @flint/policy typecheck || { echo "✗ policy typecheck failed — NOT deploying"; exit 1; }
  pnpm --filter @flint/policy test || { echo "✗ policy tests failed — NOT deploying"; exit 1; }
  echo "gate: persona tests (voice + constitution in the prompt)..."
  pnpm --filter @flint/persona test || { echo "✗ persona tests failed — NOT deploying"; exit 1; }
  echo "gate: mcp typecheck + tests (connectors, the fetch_url guard, the approval policy)..."
  pnpm --filter @flint/mcp typecheck || { echo "✗ mcp typecheck failed — NOT deploying"; exit 1; }
  pnpm --filter @flint/mcp test || { echo "✗ mcp tests failed — NOT deploying"; exit 1; }
  # @flint/core: the provider adapters, pricing and the tier rules every brain
  # call goes through. (Its Ollama contract tests, once stale, pass again.)
  echo "gate: core tests (providers, pricing, tiers)..."
  pnpm --filter @flint/core test || { echo "✗ core tests failed — NOT deploying"; exit 1; }
  # The nightly backup runs straight from this checkout, so its tests gate too.
  echo "gate: backup tests (offsite excludes, pruning, rotation, encryption)..."
  for t in "$REPO"/apps/studio/test/*.test.sh(N); do
    [ "${t:t}" = rebuild_rehearse.test.sh ] && continue   # the rebuild rehearsal: below, and only when it is needed
    zsh "$t" || { echo "✗ $t failed — NOT deploying"; exit 1; }
  done
  if [ "${FLINT_REHEARSE:-0}" = "1" ]; then
    REHEARSE=1; echo "gate: the rebuild rehearsal was asked for (FLINT_REHEARSE=1), so it must run"
  elif rehearsal_changed; then
    REHEARSE=1; echo "gate: what a rebuild is made of changed since the last deploy, so the rebuild rehearsal must run"
  else
    REHEARSE=0; echo "gate: what a rebuild is made of is unchanged since the last deploy, so the rebuild rehearsal is skipped"
  fi
  if [ "$REHEARSE" = 1 ]; then
    FLINT_REQUIRE_REHEARSAL=1 zsh "$REPO/apps/studio/run_rehearsal.sh" || { echo "✗ the rebuild rehearsal failed — NOT deploying"; exit 1; }
  fi
fi
DEPLOY_STAGE=

# The bundle running now, kept: a new one that does not come up is replaced by it.
if [ -f "$DATA/server.mjs" ]; then
  cp -p "$DATA/server.mjs" "$DATA/server.mjs.prev"
  server_version keep
else
  rm -f "$DATA/server.version" "$DATA/server.version.prev"   # no bundle here yet: a line would be another Mac's
fi
echo "bundling server -> $DATA/server.mjs ..."
ESBUILD="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1)"
# NOTE: @anthropic-ai/sdk is bundled IN (no --external) — the server is the
# frontier-escalation host and must be self-contained at ~/.flint/server.mjs,
# which has no node_modules to resolve a peer dep from.
"$ESBUILD" "$REPO/apps/server/src/index.ts" --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$DATA/server.mjs"
server_version set "$SHA"

# ---- connectors --------------------------------------------------------------
# The MCP connectors run from their own bundles in $DATA/connectors, and this
# script never rebuilt them: a connector fix (the fetch_url guard, #33) merged,
# "deployed", and the live connector kept the old code. Rebuild every bundle that
# is installed AND has its source here, before the reload respawns them. Nothing
# new is installed. A new bundle replaces the old one only if it builds AND starts
# and lists its tools (connector-smoke.mjs, started the way the server starts it,
# with its mcp.json command, args, cwd and env): one that builds can still die at
# startup, and the server's /health would not notice its tools were gone. A build
# identical to the installed bundle is left alone, so <name>.mjs.prev keeps the
# bundle from before the last REAL change rather than a copy of the live one.
echo "rebuilding installed connectors from source..."
for bundle in "$DATA"/connectors/*-server.mjs(N); do
  name="${bundle:t:r}"
  src="$REPO/packages/mcp/connectors/$name.ts"
  [ -f "$src" ] || { echo "  = $name: no source in this repo, kept"; continue; }
  next="${bundle%.mjs}.new.mjs"   # must end in .mjs: node won't run a .new file, and *-server.mjs won't match it
  if "$ESBUILD" "$src" --bundle --platform=node --format=esm --target=node20 \
       --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
       --outfile="$next" --log-level=error; then
    if cmp -s "$next" "$bundle"; then
      rm -f "$next"
      echo "  = $name unchanged"
    elif smoke=$(node "$REPO/apps/server/connector-smoke.mjs" "$next" 10000 "$bundle" "${MCP_CONFIG:-$DATA/mcp.json}" 2>&1); then
      cp -p "$bundle" "$bundle.prev" 2>/dev/null || echo "  (could not keep $name.mjs.prev)"
      mv -f "$next" "$bundle"
      echo "  ✓ $name ($smoke)"
    else
      rm -f "$next"
      echo "  ✗ $name built but did not start ($smoke); the old bundle stays"
    fi
  else
    rm -f "$next"
    echo "  ✗ $name failed to build; the old bundle stays"
  fi
done

echo "deploying console -> $DATA/console.html ..."
# The page that was live, put back with the bundle if the new server does not come up:
# open consoles reload onto whatever page is there (GET /ui-version).
[ -f "$DATA/console.html" ] && cp -p "$DATA/console.html" "$DATA/console.html.prev"
cp "$REPO/apps/console/index.html" "$DATA/console.html"

echo "reloading com.flint.server..."
launchctl unload "$AGENTS/$PLIST" 2>/dev/null || true
launchctl load -w "$AGENTS/$PLIST"

# ---- VERIFY: did it actually come back up? -------------------------------
# A bundle that builds can still fail to boot. Poll the health endpoint the
# server already exposes rather than assuming the reload worked.
#
# The poll outlasts the boot. Before it listens the server asks Ollama twice
# (which model it has, and to embed the tools), each cut off by the clock: about
# 8 s in all (src/local-model.ts LOCAL_PICK_CAP_MS, src/router.ts
# BOOT_EMBED_WAIT_MS), plus starting node and the MCP servers. Ten tries used to
# end first, and a good bundle was thrown out because Ollama was slow.
PORT_N="${PORT:-8080}"
HEALTH_WAIT_S=60
echo "verifying http://localhost:$PORT_N/health (up to ${HEALTH_WAIT_S}s) ..."
up=0
tries=0
while [ "$tries" -lt "$HEALTH_WAIT_S" ]; do
  if curl -fsS -m 3 "http://localhost:$PORT_N/health" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
  tries=$((tries + 1))
done
if [ "$up" != 1 ]; then
  echo "✗ server did NOT come up on :$PORT_N — check $DATA/logs/server.err.log"
  deploy_event server health failed "$SHA"
  # Back to the bundle that was running (plan 3.0.6): Flint stays up on the old code.
  if [ -f "$DATA/server.mjs.prev" ]; then
    echo "  going back to the previous bundle"
    cp -p "$DATA/server.mjs.prev" "$DATA/server.mjs"
    server_version back
    [ -f "$DATA/console.html.prev" ] && cp -p "$DATA/console.html.prev" "$DATA/console.html"
    launchctl unload "$AGENTS/$PLIST" 2>/dev/null || true
    launchctl load -w "$AGENTS/$PLIST" || echo "✗ the previous bundle did not load either; load it with: launchctl load -w $AGENTS/$PLIST"
  fi
  exit 1
fi
curl -fsS -m 3 "http://localhost:$PORT_N/health"; echo
deploy_event server deploy ok "$SHA"
install_rehearsal_agent || echo "✗ the weekly rebuild rehearsal agent could not be (re)loaded (the server itself is up)" >&2

# ---- TAILNET: only `tailscale serve` may reach Flint ---------------------------
# Flint listens on ::1 (apps/server/src/access.ts): this Mac's userspace tailscaled
# forwards any tailnet peer's connection to 127.0.0.1:<port> raw, so nothing of
# Flint's may answer there, and serve must proxy to http://localhost:$PORT_N (not
# http://[::1]:..., which tailscale 1.102 saves as http://::1:... and then fails).
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT_N/health" 2>/dev/null; then
  echo "✗ WARNING: Flint answers on 127.0.0.1:$PORT_N, where tailnet peers are forwarded raw. Is BIND_HOST set?"
fi
TS_BIN="$(command -v tailscale || true)"
TS_SOCK="${FLINT_TS_SOCKET:-$DATA/tailscaled.sock}"
if [ -n "$TS_BIN" ] && [ -S "$TS_SOCK" ]; then
  want="http://localhost:$PORT_N"
  have="$("$TS_BIN" --socket "$TS_SOCK" serve status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const w=Object.entries(JSON.parse(s).Web||{}).find(([k])=>k.endsWith(":443"));process.stdout.write(w?.[1]?.Handlers?.["/"]?.Proxy??"")}catch{}})')"
  if [ -n "$have" ] && [ "$have" != "$want" ]; then
    if "$TS_BIN" --socket "$TS_SOCK" serve --bg "$want" >/dev/null 2>&1; then
      echo "tailnet: serve now proxies to $want (was $have)"
    else
      echo "✗ tailnet: could not point serve at $want (it proxies to $have); remote access may be down"
    fi
  elif [ "$have" = "$want" ]; then
    echo "tailnet: serve proxies to $want"
  fi
fi
echo "done. server bundled, reloaded and answering on :$PORT_N."
exit 0
