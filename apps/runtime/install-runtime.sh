#!/bin/zsh
# install-runtime.sh: build and (re)start com.flint.runtime (Machine plan 3.0.6).
#
# Independent of the server's deploy: auto_deploy.sh runs this only when runtime
# paths changed, and a failure here never stops a server deploy (nor the other
# way round). Steps:
#   1. refuse any migration without a down.sql;
#   2. skip a SHA whose migration already failed (one escalation, not one every
#      2 minutes; Will runs the down.sql and deletes the marker);
#   3. gate: typecheck + runtime tests (they use the flint_test scratch database);
#   4. pg_dump -Fc as flint_backup to ~/FlintBackups/pre-migrate/<sha>.dump (0600);
#   5. prisma migrate deploy as flint_owner;
#   6. bundle into ~/.flint/runtime/releases/<sha>, repoint `current`, restart,
#      and poll /health; on failure, go back to the previous release.
# Secrets are read key by key from ~/.flint/secrets.env and never echoed.

set -e
setopt pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RT_SRC="$REPO/apps/runtime"
DATA="$HOME/.flint"
RT="$DATA/runtime"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.flint.runtime"
SHA="$(git -C "$REPO" rev-parse HEAD)"
PORT="${RUNTIME_PORT:-8090}"
mkdir -p "$RT/releases" "$DATA/tokens" "$HOME/FlintBackups/pre-migrate"
chmod 700 "$RT" "$DATA/tokens" "$HOME/FlintBackups" "$HOME/FlintBackups/pre-migrate"

secret() { # one key from secrets.env, quotes stripped
  sed -nE "s/^(export[[:space:]]+)?$1=//p" "$DATA/secrets.env" | tail -1 | sed -E 's/^["'\'']//; s/["'\'']$//'
}
die() { echo "✗ $*"; exit 1; }

# 1. every migration is reversible
for dir in "$RT_SRC"/prisma/migrations/*/(N); do
  [ -f "$dir/migration.sql" ] || continue
  [ -f "$dir/down.sql" ] || die "$(basename "$dir") has no down.sql — NOT deploying the runtime"
done

# 2. a SHA whose migration failed is not retried every tick
if [ -f "$RT/migrate-failed" ] && grep -qx "$SHA" "$RT/migrate-failed"; then
  echo "runtime: migration for $SHA failed before; skipping (run its down.sql, then delete $RT/migrate-failed)"
  exit 0
fi

# 3. gate
echo "runtime: building @flint/policy and the Prisma client..."
pnpm --filter @flint/policy build >/dev/null
(cd "$RT_SRC" && ./node_modules/.bin/prisma generate >/dev/null)
if [ "${FLINT_SKIP_TESTS:-0}" != "1" ]; then
  echo "gate: runtime typecheck + tests (scratch database flint_test)..."
  pnpm --filter @flint/runtime typecheck || die "runtime typecheck failed — NOT deploying the runtime"
  # The tests read the scratch database's URLs themselves (secrets.env, backup.env);
  # FLINT_REQUIRE_DB makes a missing database a failure, never a silent skip.
  FLINT_REQUIRE_DB=1 pnpm --filter @flint/runtime test || die "runtime tests failed — NOT deploying the runtime"
fi

OWNER_URL="$(secret FLINT_DB_OWNER_URL)"
BACKUP_URL="$(secret FLINT_DB_BACKUP_URL)"
APP_URL="$(secret FLINT_DB_URL)"
[ -n "$OWNER_URL" ] && [ -n "$BACKUP_URL" ] && [ -n "$APP_URL" ] || die "FLINT_DB_OWNER_URL, FLINT_DB_BACKUP_URL and FLINT_DB_URL must be in secrets.env"

# 4. pre-migrate dump (only when a migration is pending)
PENDING="$(cd "$RT_SRC" && DATABASE_URL="$OWNER_URL" ./node_modules/.bin/prisma migrate status 2>&1 || true)"
if print -r -- "$PENDING" | grep -qiE "have not yet been applied|not yet been applied|following migration"; then
  echo "runtime: migrations pending; dumping first..."
  PG_DUMP=/opt/homebrew/opt/postgresql@17/bin/pg_dump
  # The URL (it carries a password) goes through the environment, never argv.
  BU="$BACKUP_URL" node -e '
    const u = new URL(process.env.BU);
    process.stdout.write([u.hostname.replace(/^\[|\]$/g, ""), u.port || "5432", decodeURIComponent(u.username), u.pathname.slice(1)].join("\n"));
  ' | { read -r H; read -r P; read -r U; read -r D;
    DUMP="$HOME/FlintBackups/pre-migrate/$SHA.dump"
    PGPASSWORD="$(BU="$BACKUP_URL" node -e 'process.stdout.write(decodeURIComponent(new URL(process.env.BU).password))')" \
      "$PG_DUMP" -Fc -h "$H" -p "$P" -U "$U" -d "$D" -f "$DUMP.partial" && mv "$DUMP.partial" "$DUMP" && chmod 600 "$DUMP"; } \
    || die "pre-migrate dump failed — NOT migrating"

  # 5. migrate
  echo "runtime: prisma migrate deploy (as flint_owner)..."
  if ! (cd "$RT_SRC" && DATABASE_URL="$OWNER_URL" ./node_modules/.bin/prisma migrate deploy); then
    echo "$SHA" >> "$RT/migrate-failed"
    die "migration failed for $SHA; dump at ~/FlintBackups/pre-migrate/$SHA.dump. Fix, run the down.sql, delete $RT/migrate-failed"
  fi
fi

# 6. bundle the release
REL="$RT/releases/$SHA"
rm -rf "$REL.partial" && mkdir -p "$REL.partial/node_modules"
ESBUILD="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1)"
"$ESBUILD" "$RT_SRC/src/index.ts" --bundle --platform=node --format=esm --target=node20 \
  --external:@prisma/client --external:.prisma \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$REL.partial/runtime.mjs" >/dev/null
# The Prisma client and its query engine, copied out of the pnpm store.
CLIENT_PKG="$(cd "$RT_SRC/node_modules/@prisma/client" && pwd -P)"
cp -RL "$CLIENT_PKG" "$REL.partial/node_modules/@prisma-client" && mkdir -p "$REL.partial/node_modules/@prisma" \
  && mv "$REL.partial/node_modules/@prisma-client" "$REL.partial/node_modules/@prisma/client"
cp -RL "$(dirname "$(dirname "$CLIENT_PKG")")/.prisma" "$REL.partial/node_modules/.prisma"
rm -rf "$REL" && mv "$REL.partial" "$REL"

# The server's token for the runtime, and the runtime's env file (0600; no vendor keys).
TOKEN_FILE="$DATA/tokens/runtime.token"
if ! grep -qE '^[0-9a-f]{64}$' "$TOKEN_FILE" 2>/dev/null; then
  ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" )
fi
chmod 600 "$TOKEN_FILE"
TOKEN_SHA="$(tr -d '\n' < "$TOKEN_FILE" | shasum -a 256 | cut -d' ' -f1)"
# The runtime's token for calling back into the server's [::1]:8081 listener;
# the server keeps only its digest (apps/server/src/internal.ts).
INTERNAL_FILE="$DATA/tokens/internal.token"
if ! grep -qE '^[0-9a-f]{64}$' "$INTERNAL_FILE" 2>/dev/null; then
  ( umask 077; openssl rand -hex 32 > "$INTERNAL_FILE" )
fi
chmod 600 "$INTERNAL_FILE"
# The runtime MCP connector's own token (packages/mcp/connectors/runtime-server.ts):
# world:read and ledger only, never the server's grant. Its bundle is built here
# once; install-server.sh keeps it current after that. Adding `runtime` to
# ~/.flint/mcp.json stays Will's step (its tools ask for approval until he
# promotes them, so it is not switched on behind his back).
MCP_TOKEN_FILE="$DATA/tokens/runtime-mcp.token"
if ! grep -qE '^[0-9a-f]{64}$' "$MCP_TOKEN_FILE" 2>/dev/null; then
  ( umask 077; openssl rand -hex 32 > "$MCP_TOKEN_FILE" )
fi
chmod 600 "$MCP_TOKEN_FILE"
MCP_TOKEN_SHA="$(tr -d '\n' < "$MCP_TOKEN_FILE" | shasum -a 256 | cut -d' ' -f1)"
CONNECTOR="$DATA/connectors/runtime-server.mjs"
if [ ! -f "$CONNECTOR" ]; then
  ESBUILD="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f | head -1)"
  mkdir -p "$DATA/connectors"
  if [ -n "$ESBUILD" ] && "$ESBUILD" "$REPO/packages/mcp/connectors/runtime-server.ts" --bundle --platform=node --format=esm --target=node20 \
       --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
       --outfile="$CONNECTOR" --log-level=error; then
    echo "runtime: built the runtime MCP connector. To use it, add this to the \"servers\" list in ~/.flint/mcp.json"
    echo "  (the name must be \"runtime\": the tier engine and the taint rules know it by that name):"
    echo "  {\"name\": \"runtime\", \"command\": \"$(command -v node)\", \"args\": [\"$CONNECTOR\"]}"
  else
    echo "runtime: could not build the runtime MCP connector (the runtime itself is unaffected)"
  fi
fi
ENVF="$DATA/runtime.env"
{
  echo "DATABASE_URL=$APP_URL"
  echo "RUNTIME_PORT=$PORT"
  # ${...}: a bare "$TOKEN_SHA:e..." is zsh's :e modifier and would eat the digest.
  echo "RUNTIME_TOKENS=server:${TOKEN_SHA}:events|audit|proposals|world:read|ledger|counters,runtime-mcp:${MCP_TOKEN_SHA}:world:read|ledger"
  # The server's days and months (FLINT_USER_TZ, default America/Chicago): the spend source must agree.
  echo "FLINT_TZ=$(plutil -extract EnvironmentVariables.FLINT_USER_TZ raw "$AGENTS/com.flint.server.plist" 2>/dev/null || echo America/Chicago)"
  echo "RUNTIME_GIT_SHA=${SHA}"
  echo "SERVER_INTERNAL_URL=http://[::1]:8081"
  echo "SERVER_INTERNAL_TOKEN=$(tr -d '\n' < "$INTERNAL_FILE")"
  # The spend caps are numbers, copied from the server's plist; no keys.
  # (|| true: under pipefail a missing plist or file must not stop the install.)
  { plutil -p "$AGENTS/com.flint.server.plist" 2>/dev/null | sed -nE 's/^ *"(FLINT_BUDGET_[A-Z]+_(DAILY|MONTHLY)_USD)" => "([0-9.]+)"$/\1=\3/p'; } || true
  TS_URL="$(head -1 "$DATA/tailscale-url.txt" 2>/dev/null || true)"
  if [ -n "$TS_URL" ]; then
    echo "FLINT_RP_ID=$(print -r -- "$TS_URL" | sed -E 's#^https://##; s#[:/].*$##')"
    echo "FLINT_RP_ORIGINS=$(print -r -- "$TS_URL" | sed -E 's#^(https://[^/]+).*$#\1#')"
  fi
} > "$ENVF.new"
chmod 600 "$ENVF.new" && mv "$ENVF.new" "$ENVF"

# The LaunchAgent: node on the current release; no secrets in the plist.
NODE="$(command -v node)"
cat > "$AGENTS/$LABEL.plist.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$RT/current/runtime.mjs</string></array>
  <key>WorkingDirectory</key><string>$RT/current</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DATA/runtime.out.log</string>
  <key>StandardErrorPath</key><string>$DATA/runtime.err.log</string>
</dict></plist>
PLIST
chmod 600 "$AGENTS/$LABEL.plist.new"
mv "$AGENTS/$LABEL.plist.new" "$AGENTS/$LABEL.plist"

# (Re)start the agent. `bootout` returns before the old agent is gone, and a
# bootstrap that lands too soon fails with "5: Input/output error": wait for it
# to unload, then try a few times. A failure returns non-zero instead of ending
# the script, so the rollback below still runs (it did not, on 2026-10-02, and
# the runtime stayed down until it was started by hand).
restart_agent() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  for i in {1..40}; do launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break; sleep 0.25; done
  for i in 1 2 3 4 5; do
    launchctl bootstrap "gui/$UID" "$AGENTS/$LABEL.plist" 2>/dev/null && return 0
    sleep 2
  done
  echo "✗ runtime: launchctl bootstrap kept failing" >&2
  return 1
}

PREV="$(readlink "$RT/current" 2>/dev/null || true)"
ln -sfn "$REL" "$RT/current"
restart_agent || true

for i in {1..30}; do
  if curl -fsS -m 2 "http://[::1]:$PORT/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "runtime: $SHA is up on [::1]:$PORT"
    # Keep the three newest releases.
    ls -1dt "$RT"/releases/*(/N) | tail -n +4 | while read -r old; do [ "$old" = "$REL" ] || rm -rf "$old"; done
    exit 0
  fi
  sleep 1
done
echo "✗ runtime $SHA did not report healthy; going back to ${PREV:-nothing}"
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$RT/current"
  # Loaded or not (a failed bootstrap leaves it unloaded): the same restart.
  restart_agent || echo "✗ runtime: the previous release did not start either; start it with: launchctl bootstrap gui/$UID $AGENTS/$LABEL.plist" >&2
fi
exit 1
