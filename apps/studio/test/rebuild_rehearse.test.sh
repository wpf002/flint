#!/bin/zsh
# The rebuild, rehearsed end to end: a made-up "old Mac" is backed up with the
# real backup code and a throwaway age key, and rebuild.sh --rehearse brings it
# back into a scratch home folder and a scratch database. Then every way a
# rebuild must refuse. Run: zsh apps/studio/test/rebuild_rehearse.test.sh
#
# Nothing here touches the real ~/.flint, ~/flint, ~/Library/LaunchAgents, the
# real databases, launchd, iCloud or the screen: the old Mac is a fixture with
# its own throwaway Postgres, and the rehearsal keeps to its scratch folder
# (rebuild.sh, "the rehearsal starts over in an environment of its own").
# Everything is removed at the end, pass or fail.
#
# FLINT_REHEARSAL_DIR names where the scratch folders go (default: a new temp
# folder). It needs a Mac with Postgres 17, age, node and pnpm; without them it
# says what is missing and is skipped.
set -u
here=${0:A:h}
studio=${here:h}
repo=${studio:h:h}
source "$studio/recovery_lib.sh"
rebuild="$studio/rebuild.sh"
TMP="${${TMPDIR:-/tmp}%/}"

skip() { print -r -- "skipped: $1"; exit 0; }
[[ "$(uname -s)" == Darwin ]] || skip "the rebuild is for a Mac"
for t in age age-keygen node pnpm; do
  whence -p $t >/dev/null 2>&1 || [[ -x /opt/homebrew/bin/$t ]] || skip "this Mac has no $t"
done
PGBIN=/opt/homebrew/opt/postgresql@17/bin
[[ -x $PGBIN/initdb ]] || skip "this Mac has no Postgres 17"
[[ -d $repo/node_modules && -x $repo/apps/runtime/node_modules/.bin/tsx ]] || skip "the repo's packages are not installed (pnpm install)"
AGE="$(whence -p age || print /opt/homebrew/bin/age)"
AGE_KEYGEN="$(whence -p age-keygen || print /opt/homebrew/bin/age-keygen)"
TSX="$repo/apps/runtime/node_modules/.bin/tsx"
me="$(id -un)"

root="${FLINT_REHEARSAL_DIR:-$(mktemp -d "$TMP/flint-rr.XXXXXX")}"
mkdir -p "$root" || { print -r -- "FAIL could not make $root"; exit 1; }
fx="${root:A}/rr.$$"
mkdir -m 700 "$fx" || { print -r -- "FAIL could not make $fx"; exit 1; }
oldsock="$(mktemp -d "$TMP/flint-ro.XXXXXX")"
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }
cleanup() {
  for d in "$fx"/new "$fx"/r*(N/); do [[ -f $d/.flint-rehearsal ]] && /bin/zsh "$rebuild" --stop "$d" >/dev/null 2>&1; done
  [[ -f $fx/old/pg/postmaster.pid ]] && "$PGBIN/pg_ctl" -D "$fx/old/pg" -m immediate -w -t 20 stop >/dev/null 2>&1
  rm -rf "${fx:?}" "${oldsock:?}"
  [[ -n ${FLINT_REHEARSAL_DIR:-} ]] || rmdir "$root" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT TERM
typeset -F SECONDS
t_start=$SECONDS

# The install scripts a rehearsal runs must reach launchctl by name alone (so the rehearsal's
# stand-in answers) and must never set PATH themselves.
check "the installers call launchctl by its bare name" '! grep -nE "(/bin|/usr/bin)/launchctl" "$repo/apps/server/install-server.sh" "$repo/apps/runtime/install-runtime.sh"'
check "the installers never set PATH" '! grep -nE "^[[:space:]]*(export[[:space:]]+)?PATH=" "$repo/apps/server/install-server.sh" "$repo/apps/runtime/install-runtime.sh"'
check "the stand-in refuses to work outside a rehearsal" '! env -u FLINT_REHEARSAL_STATE /bin/zsh "$studio/rehearsal/launchctl" list >/dev/null 2>&1'

# ==== the old Mac: a made-up ~/.flint, LaunchAgents and database, backed up by the real backup code ====
old="$fx/old"; ohome="$old/home"; odata="$ohome/.flint"; oagents="$ohome/Library/LaunchAgents"
# Its iCloud Drive folder, where iCloud Drive really is: in the home folder, with a space in its path.
icloud="$ohome/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups"
mkdir -p "$odata"/{memory,training,eval,bin,runtime,connectors,tokens,google,brain/adapters} "$oagents" "$icloud" "$old/local"
chmod 700 "$odata"
key="$fx/backup-key.txt"
"$AGE_KEYGEN" -o "$key" >/dev/null 2>&1 && chmod 600 "$key"
recipient="$("$AGE_KEYGEN" -y "$key")"
KEY_SECRET="$(grep '^AGE-SECRET-KEY-1' "$key")"   # a throwaway: looked for wherever the key must never be
print -r -- "$recipient" > "$odata/backup-age-recipient"

# Its database: a throwaway cluster shaped like the Studio's, with Flint's roles, migrations and a few rows.
LC_ALL=C "$PGBIN/initdb" -D "$old/pg" --locale=C -E UTF-8 --auth-local=peer --auth-host=scram-sha-256 >/dev/null 2>&1
oport="$(node -e 'const s=require("net").createServer();s.listen(0,"::1",()=>{console.log(s.address().port);s.close()})')"
print -r -- "listen_addresses = '::1'
port = $oport
unix_socket_directories = '$oldsock'" >> "$old/pg/postgresql.conf"
LC_ALL=C "$PGBIN/pg_ctl" -D "$old/pg" -l "$old/pg.log" -w -t 60 start >/dev/null 2>&1
check "the old Mac's database started" '"$PGBIN/pg_isready" -q -h "$oldsock" -p "$oport"'
(( fail )) && { print -r -- "FAIL the fixture could not be made, so nothing else was tried"; tail -n 5 "$old/pg.log" 2>/dev/null; exit 1; }
( cd "$repo/apps/runtime" && HOME="$ohome" PGHOST="$oldsock" PGPORT="$oport" PGUSER="$me" PGDATABASE=postgres "$TSX" scripts/bootstrap-db.ts --port "$oport" ) >/dev/null 2>"$fx/old-bootstrap.err"
check "the old Mac's database has its roles" '[ -s "$odata/secrets.env" ] && [ -s "$odata/backup.env" ]'
env_value "$odata/secrets.env" FLINT_DB_OWNER_URL; old_owner_url=$REPLY
env_value "$odata/secrets.env" FLINT_DB_URL; old_app_url=$REPLY
old_db_password=${${old_app_url#*://flint_app:}%%@*}
( cd "$repo/apps/runtime" && DATABASE_URL="$old_owner_url" PRISMA_HIDE_UPDATE_MESSAGE=1 ./node_modules/.bin/prisma migrate deploy ) >/dev/null 2>"$fx/old-migrate.err"
opsql() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$oldsock" -p "$oport" -U "$me" -d flint "$@"; }
for id in rehearsal_a rehearsal_b rehearsal_c; do
  opsql -c "INSERT INTO \"Proposal\" (id, kind, origin, action, args, \"argsDigest\", \"argsProvenance\", \"expiresAt\") VALUES ('$id', 'tool_call', 'console', 'world.sync.github', '{\"a\":1}', repeat('a', 64), '{}', now() + interval '1 hour')" >/dev/null
done
check "the old Mac's database is migrated and holds the made-up rows" '[ "$(opsql -c "SELECT count(*) FROM \"Proposal\"")" = 3 ]'

# Its secrets. None of these may come back.
OLD_TOKEN="$(openssl rand -hex 32)"
FAKE_VENDOR_KEY="sk-ant-api03-REHEARSALNOTAREALKEY0000000000000000"
FAKE_SEARCH_KEY="tvly-REHEARSALNOTAREALKEY000000000000000000"
{
  print -r -- "FLINT_TOKEN=$OLD_TOKEN"
  print -r -- "ANTHROPIC_API_KEY=$FAKE_VENDOR_KEY"
  print -r -- "FLINT_RUNTIME_URL=http://[::1]:8090"
  print -r -- "FLINT_TAILNET_USER=someone@example.com"
  print -r -- "FLINT_TIER_HARD=openai:gpt-5"
  print -r -- "FLINT_WORLD_NOW=1"
} >> "$odata/secrets.env"
print -r -- "FLINT_OFFSITE_DIR=$icloud/pg" >> "$odata/backup.env"
print -r -- "FLINT_RUNTIME_TRIAGE=off
FLINT_SOURCE_GOOGLE_CALENDAR=off" > "$odata/runtime.override.env"
print -r -- "DATABASE_URL=$old_app_url
RUNTIME_PORT=8090" > "$odata/runtime.env"
print -r -- "$OLD_TOKEN" > "$odata/tokens/runtime.token"
print -r -- "$OLD_TOKEN" > "$odata/token"
print -r -- "$OLD_TOKEN" > "$odata/nexus-admin-token.txt"
print -r -- '{"refresh_token":"'"$OLD_TOKEN"'"}' > "$odata/google/token.json"
print -r -- "aaaa-bbbb-cccc-dddd replace" > "$odata/enroll-code"
print -r -- '{"servers":[{"name":"web","command":"node","env":{"SEARCH_API_KEY":"'"$FAKE_SEARCH_KEY"'"}},{"name":"runtime","command":"node"}]}' > "$odata/mcp.json"
print -r -- "old-machine-state" > "$odata/tailscaled.state"
chmod 600 "$odata"/*.env "$odata/token" "$odata/tokens/runtime.token"
# Its memory and files. These must come back.
print -r -- '{"schemaVersion":1,"savedAt":0,"conversations":{}}' > "$odata/memory/conversations.json"
print -r -- '{"savedAt":0,"seq":1,"facts":[{"id":"f1","text":"A made-up fact for the rebuild rehearsal.","vector":[]}],"rejected":[]}' > "$odata/memory/knowledge.json"
print -r -- '{"q":"first","a":"one"}' > "$odata/training/corpus.jsonl"
print -r -- '{"prompt":"p"}' > "$odata/eval/parity_prompts.jsonl"
print -r -- '{"r":8}' > "$odata/brain/adapters/adapter_config.json"
print -r -- '[]' > "$odata/notifications.json"
# Things a rebuild must not carry over as they are: a script that could run, a link out of the
# folder, the old Mac's hardware key, its tailnet name, and connector code.
print -r -- '#!/bin/sh
echo should-never-run' > "$odata/bin/tool.sh"; chmod 755 "$odata/bin/tool.sh"
ln -s /nonexistent/releases/abc "$odata/runtime/current"
print -r -- "old-hardware-key" > "$odata/approval-key.se"
print -r -- "https://old-mac.example.ts.net" > "$odata/tailscale-url.txt"
print -r -- "restored-bundle-not-from-the-repo" > "$odata/connectors/web-server.mjs"
print -r -- "restored-bundle-with-no-source" > "$odata/connectors/ghost-server.mjs"
# Its LaunchAgents, with the settings a rebuild restores.
render_template "$studio/templates/com.flint.server.plist.tmpl" "$oagents/com.flint.server.plist" NODE=/usr/local/bin/node NODE_DIR=/usr/local/bin HOME="$ohome" PORT=8080
plist_set_env "$oagents/com.flint.server.plist" OLLAMA_MODEL 'fixture-model:1b'
plist_set_env "$oagents/com.flint.server.plist" OLLAMA_NUM_CTX 4096
plist_set_env "$oagents/com.flint.server.plist" FLINT_BUDGET_ANTHROPIC_DAILY_USD 5
render_template "$studio/templates/com.flint.ollama.plist.tmpl" "$oagents/com.flint.ollama.plist" OLLAMA=/opt/homebrew/bin/ollama HOME="$ohome"
plist_set_env "$oagents/com.flint.ollama.plist" OLLAMA_KEEP_ALIVE 24h

# The nightly files backup, as launchd runs it: the real script, real age, the throwaway key.
backup() { env -i HOME="$ohome" PATH=/usr/bin:/bin:/usr/sbin:/sbin FLINT_BACKUP_DIR="$old/local" FLINT_BACKUP_OFFSITE="$icloud" FLINT_BACKUP_MANIFEST="$old/offsite.txt" FLINT_AGE_BIN="$AGE" FLINT_BACKUP_TS="$1" /bin/zsh "$studio/backup_flint.sh" >>"$old/backup.out" 2>>"$old/backup.err"; }
backup 20261011-0230
check "the nightly backup wrote an encrypted archive offsite" '[ -s "$icloud/flint-20261011-0230.tar.gz.age" ]'
check "and saved the settings snapshot first" '[ -s "$odata/settings-snapshot.tsv" ]'
# The next night's archive, the one the rebuild uses, is made the way a LOCAL snapshot is: with every
# secret in it. A rebuild must leave them all out even so.
print -r -- '{"q":"second","a":"two"}' >> "$odata/training/corpus.jsonl"
excludes=("${(@f)$(FLINT_BACKUP_DEFINE_ONLY=1 /bin/zsh -c 'source "$1" && print -rl -- "${EXCLUDES[@]}"' _ "$studio/backup_flint.sh")}")
tar -czf - -C "$odata" "${excludes[@]}" . | "$AGE" -r "$recipient" -o "$icloud/flint-20261012-0230.tar.gz.age"
check "the newest archive carries the secrets a rebuild must leave out" '"$AGE" -d -i "$key" "$icloud/flint-20261012-0230.tar.gz.age" | tar -tzf - | grep -qx "./secrets.env"'
# The database's nightly dump and its encrypted copy: the runtime's own commands.
cli() { ( cd "$repo/apps/runtime" && env -i HOME="$ohome" PATH="${$(whence -p node):h}:/usr/bin:/bin" "$TSX" src/cli.ts "$@" ) >>"$old/cli.out" 2>>"$old/cli.err"; }
cli backup; cli offsite
dump_age=("$icloud"/pg/flint-*.dump.age(N))
check "the runtime's backup and offsite commands left one encrypted dump offsite" '(( ${#dump_age} == 1 ))'
dump_name=${${dump_age[1]:t}%.age}
check "the dump has its fingerprint beside it on the old Mac" '[ -s "$ohome/FlintBackups/pg/$dump_name.sha256" ]'
# Its row counts, sent offsite the same way (the health-checks work adds this to the nightly job).
"$AGE" -r "$recipient" -o "$icloud/pg/$dump_name.counts.json.age" "$ohome/FlintBackups/pg/$dump_name.counts.json"
check "nothing offsite is plaintext" '! find "$icloud" -type f ! -name "*.age" | grep -q .'
"$PGBIN/pg_ctl" -D "$old/pg" -m fast -w -t 20 stop >/dev/null 2>&1
t_fixture=$SECONDS

# ==== 1. the rehearsal, end to end ====
new="$fx/new"
out="$(/bin/zsh "$rebuild" --rehearse "$new" --offsite "$icloud" --key "$key" --keep-running 2>"$fx/rehearse.err")"; st=$?
t_rehearsal=$SECONDS
if [[ $st != 0 ]]; then
  print -r -- "FAIL the rehearsal did not pass (exit $st). What it said:"
  print -r -- "$out"; cat "$fx/rehearse.err"
  for f in "$new".failed-log/*(N); do print -r -- "---- ${f:t}"; tail -n 15 "$f"; done
  rm -rf "${new:?}.failed-log"
  exit 1
fi
[[ -n ${FLINT_REHEARSAL_SHOW:-} ]] && print -r -- "$out"   # what the owner would read
check "it printed nothing on stderr" '[ ! -s "$fx/rehearse.err" ]'
bad_lines="$(print -r -- "$out" | grep -vE "^[A-Z].*[.:]$|^  [A-Z].*\.$|^  [a-z~/].*$" || true)"
check "every line it printed is a sentence, or a command on its own line" '[[ -z $bad_lines ]]'
[[ -n $bad_lines ]] && print -r -- "$bad_lines"
check "it says it passed, and how long it took" '[[ "$out" == *"The rehearsal passed in "*" seconds: the backups opened, the files and the database came back and passed their checks, and both services answered."* ]]'
check "it opened the newest of each backup" '[[ "$out" == *"Flint opened the files backup from 2026-10-12 at 02:30."* && "$out" == *"Flint opened the database backup from "* ]]'

report="$new/report.tsv"
val() { awk -F'\t' -v k="$1" '$1 == k { print $2 }' "$report"; }
check "it left a report of its ports and timings" '[ -s "$report" ] && [[ "$(val seconds_total)" =~ "^[0-9]+\.[0-9]$" ]]'
sport="$(val server_port)" rport="$(val runtime_port)" pport="$(val pg_port)" psock="$(val pg_socket)"
nhome="$new/home"; ndata="$nhome/.flint"; nagents="$nhome/Library/LaunchAgents"

# Both services answer, on the rehearsal's own ports and never the real ones.
check "its ports are its own" '[[ $sport != 8080 && $rport != 8090 && $pport != 5432 && $(val internal_port) != 8081 ]]'
check "the rebuilt server answers" 'curl -fsS -m 5 "http://[::1]:$sport/health" | grep -q "\"ok\":true"'
check "the rebuilt runtime answers, with its database up" 'curl -fsS -m 5 "http://[::1]:$rport/health" | grep -q "\"ok\":true,\"db\":\"up\""'
check "the server is the one from the rendered LaunchAgent, with the restored model" 'curl -fsS -m 5 "http://[::1]:$sport/health" | grep -q "\"model\":\"fixture-model:1b\""'
env_value "$ndata/secrets.env" FLINT_TOKEN; NEW_TOKEN=$REPLY
check "the server takes the new access token and refuses the old one" '[ "$(curl -s -m 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $NEW_TOKEN" "http://[::1]:$sport/actions")" = 200 ] && [ "$(curl -s -m 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $OLD_TOKEN" "http://[::1]:$sport/actions")" = 401 ]'

# The database: what the backup held, owned and granted as Flint's rules say.
npsql() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$psock" -p "$pport" -U "$me" -d "${2:-flint}" -c "$1"; }
check "every row is back" '[ "$(npsql "SELECT count(*) FROM \"Proposal\"")" = 3 ] && [ "$(npsql "SELECT string_agg(id, chr(44) ORDER BY id) FROM \"Proposal\"")" = "rehearsal_a,rehearsal_b,rehearsal_c" ]'
check "the restore wrote its audit entry, as a rebuild" '[ "$(npsql "SELECT inputs->>'"'"'mode'"'"' FROM \"AuditEntry\" WHERE action = '"'"'restore.production'"'"'")" = rebuild ]'
check "its row counts were compared with the backup's own" '[[ "$out" == *"tables match the backup'"'"'s own counts."* ]]'
check "everything is owned by the migration owner" '[ "$(npsql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('"'"'public'"'"', '"'"'flint_part'"'"', '"'"'pgboss'"'"') AND pg_get_userbyid(c.relowner) <> '"'"'flint_owner'"'"'")" = 0 ]'
check "the runtime's role can write the audit trail and cannot change it" '[ "$(npsql "SELECT has_table_privilege('"'"'flint_app'"'"', '"'"'\"AuditEntry\"'"'"', '"'"'INSERT'"'"') AND NOT has_table_privilege('"'"'flint_app'"'"', '"'"'\"AuditEntry\"'"'"', '"'"'UPDATE'"'"') AND NOT has_table_privilege('"'"'flint_app'"'"', '"'"'\"AuditEntry\"'"'"', '"'"'DELETE'"'"')")" = t ]'
check "only the approver's role can create an approval" '[ "$(npsql "SELECT has_table_privilege('"'"'flint_approver'"'"', '"'"'\"Approval\"'"'"', '"'"'INSERT'"'"') AND NOT has_table_privilege('"'"'flint_app'"'"', '"'"'\"Approval\"'"'"', '"'"'INSERT'"'"')")" = t ]'
check "no application role may make temporary tables" '[ "$(npsql "SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('"'"'flint_app'"'"', '"'"'flint_approver'"'"', '"'"'flint_backup'"'"') AND has_database_privilege(r.oid, '"'"'flint'"'"', '"'"'TEMP'"'"')")" = 0 ]'
check "the five roles exist, none a superuser or able to make roles" '[ "$(npsql "SELECT count(*) FILTER (WHERE NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls) || chr(47) || count(*) FROM pg_roles WHERE rolname LIKE '"'"'flint\\_%'"'"'")" = 5/5 ]'
check "the migrations are all applied" '[ "$(npsql "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")" = "$(ls -d "$repo"/apps/runtime/prisma/migrations/2*/ | wc -l | tr -d " ")" ]'
check "the database takes passwords only on this Mac's own address" 'grep -q "^host    all   all   ::1/128          scram-sha-256" "$new/pg/pg_hba.conf" && ! grep -Eq "^host.*(trust|0\.0\.0\.0|127\.0\.0\.1)" "$new/pg/pg_hba.conf" && grep -q "listen_addresses = .::1." "$new/pg/flint.conf"'
check "the test database for the deploy gate is there too" '[ "$(npsql "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '"'"'flint_test'"'"'" postgres)" = flint_owner ]'

# The files: back, private, and not runnable.
check "the newest files are back, byte for byte" 'cmp -s "$odata/training/corpus.jsonl" "$ndata/training/corpus.jsonl" && cmp -s "$odata/eval/parity_prompts.jsonl" "$ndata/eval/parity_prompts.jsonl" && cmp -s "$odata/brain/adapters/adapter_config.json" "$ndata/brain/adapters/adapter_config.json"'
check "memory is back" 'grep -q "A made-up fact for the rebuild rehearsal." "$ndata/memory/knowledge.json"'
check "the data folder and everything secret in it is its owner's alone" '[ "$(stat -f %Lp "$ndata")" = 700 ] && [ "$(stat -f %Lp "$ndata/secrets.env")" = 600 ] && [ "$(stat -f %Lp "$ndata/backup.env")" = 600 ] && [ "$(stat -f %Lp "$ndata/runtime.env")" = 600 ] && [ "$(stat -f %Lp "$ndata/tokens")" = 700 ] && [ "$(stat -f %Lp "$ndata/enroll-code")" = 600 ]'
check "every settings and token file is its owner's alone" '! find "$ndata" -maxdepth 1 -name "*.env" -perm +077 | grep -q . && ! find "$ndata/tokens" -type f -perm +077 | grep -q .'
check "a restored script cannot run" '[ -f "$ndata/bin/tool.sh" ] && [ ! -x "$ndata/bin/tool.sh" ]'
check "no link from the backup was kept" '[ ! -e "$ndata/runtime/current" ] || [[ "$(readlink "$ndata/runtime/current")" == "$ndata/runtime/releases/"* ]]'
check "the old Mac's hardware key and tailnet name are gone" '[ ! -e "$ndata/approval-key.se" ] && [ ! -e "$ndata/tailscale-url.txt" ]'
check "a connector with source in the repo is rebuilt from the repo" '[ -s "$ndata/connectors/web-server.mjs" ] && ! grep -q "restored-bundle" "$ndata/connectors/web-server.mjs"'
check "a connector with no source is left out, and named" '[ ! -e "$ndata/connectors/ghost-server.mjs" ] && [[ "$out" == *"Flint left out 1 connector(s) it has no source for: ghost-server."* ]]'
check "the rebuild is marked finished" '[ ! -e "$ndata/.rebuild-in-progress" ]'

# Secrets: every one Flint can make is new, and nothing of the old Mac's came back.
env_value "$ndata/secrets.env" FLINT_DB_URL; new_db_password=${${REPLY#*://flint_app:}%%@*}
check "the access token is new" '[[ $NEW_TOKEN =~ "^[0-9a-f]{64}$" && $NEW_TOKEN != $OLD_TOKEN ]]'
check "the database passwords are new" '[[ $new_db_password =~ "^[0-9a-f]{48}$" && $new_db_password != $old_db_password ]]'
check "the runtime's tokens are new" '[[ "$(<"$ndata/tokens/runtime.token")" =~ "^[0-9a-f]{64}$" && "$(<"$ndata/tokens/runtime.token")" != $OLD_TOKEN ]]'
for secret in "$OLD_TOKEN" "$old_db_password" "$FAKE_VENDOR_KEY" "$FAKE_SEARCH_KEY" old-machine-state old-hardware-key "$KEY_SECRET"; do
  check "nothing secret from the old Mac, nor the backup key, is anywhere in the rebuilt home (${secret[1,12]}...)" '! grep -rqF -- "$secret" "$nhome" "$new/log" "$new/state"'
done
for gone in mcp.json token nexus-admin-token.txt google tailscaled.state; do
  check "a secret file in the archive is never unpacked: $gone" '[ ! -e "$ndata/$gone" ]'
done
check "the enrolment code is new, replaces every old key, and was not shown" '[[ "$(<"$ndata/enroll-code")" =~ "^[0-9a-f-]{27} replace$" && "$(<"$ndata/enroll-code")" != aaaa-* ]] && [[ "$out" != *"${$(<"$ndata/enroll-code")%% *}"* ]]'
for secret in "$NEW_TOKEN" "$new_db_password" "$OLD_TOKEN" "$old_db_password" "$FAKE_VENDOR_KEY" "$(<"$ndata/tokens/runtime.token")" postgresql:// "$KEY_SECRET" AGE-SECRET-KEY; do
  check "no secret reached the screen (${secret[1,12]}...)" '[[ "$out" != *"$secret"* ]]'
done
check "no new secret is in the rehearsal's logs" '! grep -rqF -- "$NEW_TOKEN" "$new/log" && ! grep -rqF -- "$new_db_password" "$new/log"'

# Settings: the switches are back; the addresses and ports are the rehearsal's own.
pget() { /usr/bin/plutil -extract "EnvironmentVariables.$2" raw -o - "$1" 2>/dev/null; }
check "your switches are back in the server's settings" 'grep -qx "FLINT_TAILNET_USER=someone@example.com" "$ndata/secrets.env" && grep -qx "FLINT_TIER_HARD=openai:gpt-5" "$ndata/secrets.env" && grep -qx "FLINT_WORLD_NOW=1" "$ndata/secrets.env"'
check "and in the runtime's" 'grep -qx "FLINT_RUNTIME_TRIAGE=off" "$ndata/runtime.override.env" && grep -qx "FLINT_SOURCE_GOOGLE_CALENDAR=off" "$ndata/runtime.override.env" && [ "$(stat -f %Lp "$ndata/runtime.override.env")" = 600 ]'
check "and in the server's LaunchAgent" '[ "$(pget "$nagents/com.flint.server.plist" OLLAMA_MODEL)" = "fixture-model:1b" ] && [ "$(pget "$nagents/com.flint.server.plist" OLLAMA_NUM_CTX)" = 4096 ] && [ "$(pget "$nagents/com.flint.server.plist" FLINT_BUDGET_ANTHROPIC_DAILY_USD)" = 5 ]'
check "and in the local model's" '[ "$(pget "$nagents/com.flint.ollama.plist" OLLAMA_KEEP_ALIVE)" = 24h ]'
check "the runtime got the restored model and spend cap through its installer" 'grep -qx "FLINT_TRIAGE_MODEL=fixture-model:1b" "$ndata/runtime.env" && grep -qx "FLINT_BUDGET_ANTHROPIC_DAILY_USD=5" "$ndata/runtime.env"'
check "a rehearsal never points at the real Flint: its server port, runtime and model address are its own" '[ "$(pget "$nagents/com.flint.server.plist" PORT)" = "$sport" ] && grep -qx "FLINT_RUNTIME_URL=http://\[::1\]:$rport" "$ndata/secrets.env" && [ "$(pget "$nagents/com.flint.server.plist" OLLAMA_HOST)" = "http://127.0.0.1:9" ] && ! grep -q "8090" "$ndata/secrets.env"'
check "the backup settings are back, with this home folder in the path" 'grep -qxF "FLINT_OFFSITE_DIR=$nhome/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg" "$ndata/backup.env"'
check "it says how many settings it put back" '[[ "$out" == *"Flint put back "*" of your settings."* ]]'
check "it names the outside account that had a key, and where to revoke it" '[[ "$out" == *"Anthropic: revoke the old key at console.anthropic.com"* && "$out" == *"Connectors: the list of connectors holds keys"* ]]'
check "it does not name accounts that were never set up" '[[ "$out" != *"OpenAI:"* && "$out" != *"Tavily:"* ]]'
check "it names the connectors that were set up" '[[ "$out" == *"The connectors that were set up on the old Mac: web, runtime."* ]]'
check "it gives the model commands, each on its own line" '[[ "$out" == *$'"'"'\n'"'"'"  ollama pull fixture-model:1b"$'"'"'\n'"'"'"  ollama pull nomic-embed-text"* ]]'

# LaunchAgents: every one written from the repo, valid, private, and for this home folder.
for label in com.flint.server com.flint.ollama com.flint.tailscaled com.flint.runtime com.flint.runtime-backup com.flint.backup com.flint.evolve com.flint.deploy; do
  check "$label has a valid LaunchAgent file, 0600" '/usr/bin/plutil -lint "$nagents/$label.plist" >/dev/null && [ "$(stat -f %Lp "$nagents/$label.plist")" = 600 ]'
done
check "the LaunchAgent files kept in the repo were written for this home folder, not the Studio's" '! grep -l "/Users/willfoti" "$nagents/com.flint.backup.plist" "$nagents/com.flint.evolve.plist" "$nagents/com.flint.deploy.plist"'
check "the deploy job would run from this home folder's checkout" 'grep -q "<string>$nhome/flint/apps/server/auto_deploy.sh</string>" "$nagents/com.flint.deploy.plist"'
check "tailscaled's socket and state are in this data folder" 'grep -q "<string>--socket=$ndata/tailscaled.sock</string>" "$nagents/com.flint.tailscaled.plist"'
# launchd: the install scripts' calls all went to the rehearsal's stand-in.
check "the installers loaded the server and the runtime through the stand-in" 'grep -q "^load -w $nagents/com.flint.server.plist" "$new/state/calls.log" && grep -q "^bootstrap gui/[0-9]* $nagents/com.flint.runtime.plist" "$new/state/calls.log"'
check "only what a rehearsal loads was loaded: the server, the runtime and its nightly backup" '[ "$(ls "$new/state/loaded" | sort | tr "\n" " ")" = "com.flint.runtime com.flint.runtime-backup com.flint.server " ]'
check "the nightly backup job is recorded and was not run" '[ ! -e "$new/state/pids/com.flint.runtime-backup" ]'
check "the rehearsal never asked to install, sign in or reach another machine" '! grep -rq "does not run" "$new/log"'

# ==== 2. stopping it removes everything ====
stop_out="$(/bin/zsh "$rebuild" --stop "$new" 2>&1)"; st=$?
check "--stop succeeds and says so" '[ "$st" = 0 ] && [[ "$stop_out" == "The rehearsal is stopped and its folder is removed." ]]'
check "the rehearsal's folder is gone" '[ ! -e "$new" ]'
check "its database's socket folder is gone" '[ ! -e "$psock" ]'
check "nothing of the rehearsal is still running" '! pgrep -f "$new/" >/dev/null'
check "its ports are closed" '! curl -s -m 2 -o /dev/null "http://[::1]:$sport/health" && ! curl -s -m 2 -o /dev/null "http://[::1]:$rport/health"'
check "--stop leaves alone a folder that is not a rehearsal" '! /bin/zsh "$rebuild" --stop "$fx/old" >/dev/null 2>&1 && [ -d "$fx/old/home" ]'

# ==== 2b. no database backup offsite (true until the first offsite dump), and a rebuild started over ====
# The files come back, Flint starts with an empty database that the installer migrates, and a
# rebuild that stopped part-way is simply run again: what it left is cleared and it starts over.
ic4="$fx/icloud4/FlintBackups"; mkdir -p "${ic4:h}"; cp -R "$icloud" "$ic4"; rm -rf "${ic4:?}/pg"
/bin/zsh "$rebuild" --unseal "$fx/nodb" --offsite "$ic4" --key "$key" --without-database >/dev/null 2>&1
r0="$fx/r0"
r_out="$(FLINT_REHEARSAL_EXISTING=resume /bin/zsh "$rebuild" --rehearse "$r0" --bundle "$fx/nodb" --keep-running 2>&1)"; st=$?
check "a rebuild with no database backup passes its rehearsal" '[ "$st" = 0 ] && [[ "$r_out" == *"The rehearsal passed in "* ]]'
[[ $st == 0 ]] || { print -r -- "$r_out"; for f in "$r0".failed-log/*(N); do print -r -- "---- ${f:t}"; tail -n 12 "$f"; done; rm -rf "${r0:?}.failed-log"; }
check "it says the database starts empty" '[[ "$r_out" == *"No database backup was restored, so Flint starts with an empty database."* ]]'
check "it says it is starting a stopped rebuild over" '[[ "$r_out" == *"An earlier rebuild stopped part-way on this Mac. Flint is starting it over."* ]]'
if [[ $st == 0 ]]; then
  check "what the first try left is gone, and the rebuild is marked finished" '[ ! -e "$r0/home/.flint/left-by-the-first-try" ] && [ ! -e "$r0/home/.flint/.rebuild-in-progress" ]'
  check "the files still came back" 'cmp -s "$odata/training/corpus.jsonl" "$r0/home/.flint/training/corpus.jsonl"'
  r0sock="$(awk -F'\t' '$1 == "pg_socket" { print $2 }' "$r0/report.tsv")"; r0port="$(awk -F'\t' '$1 == "pg_port" { print $2 }' "$r0/report.tsv")"
  r0psql() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$r0sock" -p "$r0port" -U "$me" -d flint -c "$1"; }
  check "the empty database was migrated by the runtime's installer" '[ "$(r0psql "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")" = "$(ls -d "$repo"/apps/runtime/prisma/migrations/2*/ | wc -l | tr -d " ")" ] && [ "$(r0psql "SELECT count(*) FROM \"Proposal\"")" = 0 ]'
  check "and a copy was taken before migrating, as on every runtime update" '[ -n "$(ls "$r0/home/FlintBackups/pre-migrate" 2>/dev/null)" ]'
  /bin/zsh "$rebuild" --stop "$r0" >/dev/null 2>&1
fi
check "nothing of it is left" '[ ! -e "$r0" ] && ! pgrep -f "$r0/" >/dev/null'
t_stop=$SECONDS

# ==== 3. refusals: each one stops before anything is restored, and leaves nothing behind ====
refused() { # <name> <words it must say> <rebuild.sh arguments...>: exits 1, says the words, leaves no rehearsal folder
  local name=$1 words=$2 r_out r_st dir
  shift 2
  r_out="$(/bin/zsh "$rebuild" "$@" 2>&1)"; r_st=$?
  if [[ $r_st == 1 && $r_out == *"$words"* ]]; then :; else print -r -- "FAIL $name (exit $r_st): $r_out"; fail=1; fi
  for dir in "$fx"/r*(N/); do
    [[ -e $dir/.flint-rehearsal ]] && { print -r -- "FAIL $name left its rehearsal folder behind"; fail=1; /bin/zsh "$rebuild" --stop "$dir" >/dev/null 2>&1; }
  done
  rm -rf "$fx"/r*.failed-log(N)
  return 0
}
# The wrong key.
wrong="$fx/wrong-key.txt"; "$AGE_KEYGEN" -o "$wrong" >/dev/null 2>&1; chmod 600 "$wrong"
refused "the wrong key is refused" "This key does not open the backups. They were made for a different key." --rehearse "$fx/r1" --offsite "$icloud" --key "$wrong"
refused "the wrong key is refused when only opening" "This key does not open the backups." --unseal "$fx/b-wrong" --offsite "$icloud" --key "$wrong"
check "a refused opening leaves no folder of opened backups" '[ ! -e "$fx/b-wrong" ]'
# A key that is not private, or not a key.
loose="$fx/loose-key.txt"; cp "$key" "$loose"; chmod 644 "$loose"
refused "a key others can read is refused" "Others on this Mac can read your backup key." --unseal "$fx/b-loose" --offsite "$icloud" --key "$loose"
print -r -- "not a key" > "$fx/not-a-key.txt"; chmod 600 "$fx/not-a-key.txt"
refused "a file that is not a key is refused" "That file is not an age key." --unseal "$fx/b-notkey" --offsite "$icloud" --key "$fx/not-a-key.txt"
refused "a missing key is refused" "The backup key file is not there." --unseal "$fx/b-nokey" --offsite "$icloud" --key "$fx/nope.txt"
refused "a missing backup folder is refused" "The backup folder is not there." --unseal "$fx/b-nodir" --offsite "$fx/nowhere" --key "$key"

# A damaged archive: the one before it is used, and it says so. When none opens, it stops.
ic2="$fx/icloud2/FlintBackups"; mkdir -p "${ic2:h}"; cp -R "$icloud" "$ic2"
head -c 400 "$icloud/flint-20261012-0230.tar.gz.age" > "$ic2/flint-20261012-0230.tar.gz.age"
u_out="$(/bin/zsh "$rebuild" --unseal "$fx/b2" --offsite "$ic2" --key "$key" 2>&1)"; st=$?
check "a damaged newest archive is passed over for the one before it" '[ "$st" = 0 ] && [[ "$u_out" == *"The files backup from 2026-10-12 at 02:30 is damaged, so Flint is using the one before it."* && "$u_out" == *"Flint opened the files backup from 2026-10-11 at 02:30."* ]]'
check "the opened folder says which archive it came from" 'grep -qx "files=flint-20261011-0230.tar.gz.age" "$fx/b2/bundle.info"'
check "the opened folder is its owner's alone, and so is every file in it" '[ "$(stat -f %Lp "$fx/b2")" = 700 ] && ! find "$fx/b2" -type f -perm +077 | grep -q .'
check "the backup key is not in the opened folder" '! grep -rqF -- "$KEY_SECRET" "$fx/b2" && ! grep -rq "AGE-SECRET-KEY" "$fx/b2"'
check "the archive made by the nightly backup holds no secret file" '! tar -tzf "$fx/b2/files.tar.gz" | grep -E "secrets\.env|/tokens/|mcp\.json|^\./token$|google/|enroll-code|tailscaled\.state"'
head -c 400 "$icloud/flint-20261011-0230.tar.gz.age" > "$ic2/flint-20261011-0230.tar.gz.age"
refused "when no files archive opens, it stops" "There is no files backup Flint can open in that folder." --unseal "$fx/b2b" --offsite "$ic2" --key "$key"
# A damaged database dump (bytes changed in the middle: the encryption catches it).
ic3="$fx/icloud3/FlintBackups"; mkdir -p "${ic3:h}"; cp -R "$icloud" "$ic3"
size=$(stat -f %z "$ic3/pg/$dump_name.age")
printf 'XXXXXXXXXXXXXXXX' | dd of="$ic3/pg/$dump_name.age" bs=1 seek=$(( size / 2 )) conv=notrunc 2>/dev/null
refused "a damaged database backup is refused when there is no other" "There is no database backup Flint can open in that folder. To rebuild with your files and an empty database, add --without-database." --unseal "$fx/b3" --offsite "$ic3" --key "$key"
check "and it said the dump was damaged" '/bin/zsh "$rebuild" --unseal "$fx/b3x" --offsite "$ic3" --key "$key" 2>&1 | grep -q "The database backup from .* is damaged"'
# No database backup offsite at all: refused, unless the owner says to go on with an empty one.
refused "no database backup offsite is refused" "add --without-database" --unseal "$fx/b4" --offsite "$ic4" --key "$key"
u_out="$(/bin/zsh "$rebuild" --unseal "$fx/b4" --offsite "$ic4" --key "$key" --without-database 2>&1)"; st=$?
check "with --without-database it opens the files and says the database starts empty" '[ "$st" = 0 ] && [[ "$u_out" == *"There is no database backup offsite, so the rebuilt Flint starts with an empty database."* ]] && grep -qx "database=none" "$fx/b4/bundle.info"'
# An archive whose members would land outside the data folder, or that holds a hard link.
ic5="$fx/icloud5/FlintBackups"; mkdir -p "$ic5" "$fx/evil/inside"
print -r -- x > "$fx/evil/inside/file"
tar -czf - -C "$fx/evil" -s ',^inside,../outside,' inside | "$AGE" -r "$recipient" -o "$ic5/flint-20261012-0230.tar.gz.age"
refused "an archive that would write outside the data folder is refused" "There is no files backup Flint can open in that folder." --unseal "$fx/b5" --offsite "$ic5" --key "$key" --without-database
rm -f "$ic5"/*; ln "$fx/evil/inside/file" "$fx/evil/inside/hardlink"
tar -czf - -C "$fx/evil" inside | "$AGE" -r "$recipient" -o "$ic5/flint-20261012-0230.tar.gz.age"
refused "an archive that holds a hard link is refused" "There is no files backup Flint can open in that folder." --unseal "$fx/b5b" --offsite "$ic5" --key "$key" --without-database
# An archive that carries a link and then a file "inside" it: the way an archive writes outside its folder.
rm -f "$ic5"/*; mkdir -p "$fx/evil2/through" "$fx/evil2/payload" "$fx/escaped"
ln -s "$fx/escaped" "$fx/evil2/through/door"; print -r -- pwned > "$fx/evil2/payload/file"
tar -czf - -C "$fx/evil2" -s ',^payload,through/door,' through payload | "$AGE" -r "$recipient" -o "$ic5/flint-20261012-0230.tar.gz.age"
check "the made-up archive really has a path through its own link" '"$AGE" -d -i "$key" "$ic5/flint-20261012-0230.tar.gz.age" | tar -tzf - | grep -q "^through/door/file$"'
refused "an archive with a path through its own link is refused" "There is no files backup Flint can open in that folder." --unseal "$fx/b5c" --offsite "$ic5" --key "$key" --without-database
check "and nothing was written outside" '[ -z "$(ls -A "$fx/escaped")" ]'
# iCloud has not downloaded the newest archive: Flint asks for it and waits; if it never comes, the one before is used.
ic6="$fx/icloud6/FlintBackups"; mkdir -p "${ic6:h}"; cp -R "$icloud" "$ic6"
mv "$ic6/flint-20261012-0230.tar.gz.age" "$fx/held-back.age"; : > "$ic6/.flint-20261012-0230.tar.gz.age.icloud"
u_out="$(FLINT_ICLOUD_WAIT=1 /bin/zsh "$rebuild" --unseal "$fx/b6" --offsite "$ic6" --key "$key" 2>&1)"; st=$?
check "an archive still in iCloud is passed over after waiting" '[ "$st" = 0 ] && [[ "$u_out" == *"The files backup from 2026-10-12 at 02:30 has not come down from iCloud, so Flint is using the one before it."* ]]'

# An opened folder that changed after it was opened (its fingerprints no longer match).
/bin/zsh "$rebuild" --unseal "$fx/good" --offsite "$icloud" --key "$key" >/dev/null 2>&1
check "the newest backups open into a folder" '[ -s "$fx/good/MANIFEST.sha256" ] && [ -s "$fx/good/$dump_name" ] && [ -s "$fx/good/$dump_name.counts.json" ]'
tamper() { rm -rf "${fx:?}/tampered"; cp -Rp "$fx/good" "$fx/tampered"; }
tamper; print -n x >> "$fx/tampered/files.tar.gz"
refused "a changed files archive is refused (its fingerprint no longer matches)" "An opened backup has changed since it was opened, so Flint will not restore from it." --rehearse "$fx/r3" --bundle "$fx/tampered"
tamper; print -n x >> "$fx/tampered/$dump_name"
refused "a changed database dump is refused" "An opened backup has changed since it was opened" --rehearse "$fx/r3" --bundle "$fx/tampered"
tamper; print -r -- x > "$fx/tampered/extra-file"
refused "a file added to the opened folder is refused" "holds a file that was not there when it was made" --rehearse "$fx/r3" --bundle "$fx/tampered"
tamper; rm "$fx/tampered/$dump_name.counts.json"
refused "a file missing from the opened folder is refused" "The opened backups are incomplete." --rehearse "$fx/r3" --bundle "$fx/tampered"
tamper; print -r -- "not a manifest line" >> "$fx/tampered/MANIFEST.sha256"
refused "an unreadable list of fingerprints is refused" "The list of opened backups is not readable." --rehearse "$fx/r3" --bundle "$fx/tampered"
tamper; chmod 755 "$fx/tampered"
refused "an opened folder others can read is refused" "Others on this Mac can read the folder of opened backups." --rehearse "$fx/r3" --bundle "$fx/tampered"
refused "a folder that is not opened backups is refused" "That folder is not one that rebuild.sh --unseal made." --rehearse "$fx/r3" --bundle "$fx/old/local"
check "the good opened folder was never changed by a rehearsal" '( cd "$fx/good" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 )'

# A target that is not empty.
mkdir -p "$fx/r4"; print -r -- x > "$fx/r4/something"
refused "a rehearsal folder that is not empty is refused" "The rehearsal's folder is not empty." --rehearse "$fx/r4" --bundle "$fx/good"
rm -rf "${fx:?}/r4"
FLINT_REHEARSAL_EXISTING=files refused "a Mac that already has Flint's files is refused, with nothing changed" "This Mac already has a Flint (its data folder). Nothing was changed." --rehearse "$fx/r5" --bundle "$fx/good"
FLINT_REHEARSAL_EXISTING=database refused "a Mac that already has a Flint database is refused, with nothing changed" "This Mac already has a Flint database. Nothing was changed. A rebuild never replaces a database" --rehearse "$fx/r6" --bundle "$fx/good"
refused "a rehearsal inside Flint's own folders is refused" "A rehearsal never runs inside Flint's own folders." --rehearse "$HOME/.flint/rehearsal-must-not-be-here" --bundle "$fx/good"
check "and made nothing there" '[ ! -e "$HOME/.flint/rehearsal-must-not-be-here" ]'

# A missing tool: said by name, with how to get it.
nodebin=${$(whence -p node):h}
missing() { env -i HOME="$HOME" TMPDIR="$TMP" PATH="$1" FLINT_TOOL_PATHS="$2" /bin/zsh "$rebuild" "${@:3}" 2>&1; }
m_out="$(missing "$nodebin:/usr/bin:/bin" "$PGBIN" --unseal "$fx/b7" --offsite "$icloud" --key "$key")"; st=$?
check "without age it says so, and how to install it" '[ "$st" = 1 ] && [[ "$m_out" == "The program age is not installed, and Flint needs it to open a backup. Install it with: brew install age" ]]'
m_out="$(missing "$nodebin:/usr/bin:/bin" "" --rehearse "$fx/r7" --bundle "$fx/good")"; st=$?
check "without Postgres it says so, and how to install it" '[ "$st" = 1 ] && [[ "$m_out" == "Postgres 17 is not installed, and the rehearsal needs it. Install it with: brew install postgresql@17" ]] && [ ! -e "$fx/r7" ]'
m_out="$(missing "/usr/bin:/bin" "$PGBIN" --rehearse "$fx/r7" --bundle "$fx/good")"; st=$?
check "without node it says so" '[ "$st" = 1 ] && [[ "$m_out" == "The program node is not installed, and the rehearsal needs it." ]] && [ ! -e "$fx/r7" ]'

# Arguments.
refused "no arguments: it says how to run it" "Run this as rebuild.sh --to you@new-mac.local on the MacBook."
refused "an unknown option is refused" "Run this as rebuild.sh --to" --rehearse "$fx/r8" --everything
refused "two modes at once are refused" "Run this as rebuild.sh --to" --rehearse "$fx/r8" --unseal "$fx/b8"
refused "a model name that is not a name is refused" "That model name is not one Flint can use." --rehearse "$fx/r8" --bundle "$fx/good" --model 'x; rm -rf ~'
refused "--replace-existing means nothing to a rehearsal" "A rehearsal always starts from an empty scratch folder" --rehearse "$fx/r8" --bundle "$fx/good" --replace-existing
for bad in 'new-mac.local' '-oProxyCommand=evil@host' 'will foti@host' 'will@host;id' 'will@-host' '@host'; do
  refused "the new Mac must be named as you@its-name ($bad)" "Name the new Mac as you@its-name" --to "$bad" --offsite "$icloud" --key "$key"
done

# ==== 4. the MacBook's half (--to), with stand-ins for ssh and scp: the key never leaves ====
sbin="$fx/sbin"; remote="$fx/remote"; mkdir -p "$sbin" "$remote"
print -r -- '#!/bin/zsh
# A stand-in for ssh: record what would run on the new Mac, and run nothing there.
print -r -- "ssh ${(j: :)${(q-)@}}" >> "$REMOTE/calls.log"
[[ " $* " == *" -O exit "* ]] && exit 0
[[ -e $REMOTE/refuse-first && ! -e $REMOTE/refused ]] && { : > "$REMOTE/refused"; exit 255; }
exit 0' > "$sbin/ssh"
print -r -- '#!/bin/zsh
# A stand-in for scp: copy what is sent into a folder, so the test can look at exactly what left.
print -r -- "scp ${(j: :)${(q-)@}}" >> "$REMOTE/calls.log"
files=(); seen=0
for a in "$@"; do
  if (( seen )); then files+=("$a"); elif [[ $a == -- ]]; then seen=1; fi
done
dest=${files[-1]#*:}; files=(${files[1,-2]})
mkdir -p "$REMOTE/home/${dest:h}"
if [[ $dest == */ ]]; then mkdir -p "$REMOTE/home/$dest"; cp "${files[@]}" "$REMOTE/home/$dest"; else cp "${files[@]}" "$REMOTE/home/$dest"; fi' > "$sbin/scp"
chmod +x "$sbin/ssh" "$sbin/scp"
to() { env -i HOME="$fx/macbook" TMPDIR="$TMP" REMOTE="$remote" PATH="$sbin:${AGE:h}:$nodebin:/usr/bin:/bin" /bin/zsh "$rebuild" --to "$@" 2>&1; }
mkdir -p "$fx/macbook"
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key" --model fixture-model:1b)"; st=$?
check "--to runs through to the end" '[ "$st" = 0 ]'
check "it tells the owner what is happening, in sentences" '[[ "$to_out" == *"Flint is connecting to the new Mac. Enter that Mac'"'"'s password when it asks."* && "$to_out" == *"The backups are on the new Mac. Flint is setting it up."* ]]'
check "the opened backups were sent, and nothing else but the toolchain script" '[ "$(ls "$remote/home/flint-rebuild-bundle" | sort | tr "\n" " ")" = "$(ls "$fx/good" | sort | tr "\n" " ")" ] && cmp -s "$remote/home/flint-rebuild-toolchain.sh" "$rebuild"'
check "the backup key was never sent: not its file, not its contents, not its path" '! grep -rqF -- "$KEY_SECRET" "$remote" && ! grep -q "backup-key" "$remote/calls.log" && ! ls "$remote/home" "$remote/home/flint-rebuild-bundle" | grep -qi key'
check "what was sent is what was opened (the fingerprints match)" '( cd "$remote/home/flint-rebuild-bundle" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 )'
check "the new Mac is asked for an empty folder first, then set up, then rebuilt, in that order" '[ "$(grep -c "" "$remote/calls.log")" -ge 5 ] && [ "$(grep -n "mkdir -p -m 700 flint-rebuild-bundle" "$remote/calls.log" | cut -d: -f1)" -lt "$(grep -n "^scp" "$remote/calls.log" | head -1 | cut -d: -f1)" ] && [ "$(grep -n -- "--toolchain" "$remote/calls.log" | cut -d: -f1)" -lt "$(grep -n -- "rebuild.sh --from flint-rebuild-bundle" "$remote/calls.log" | cut -d: -f1)" ]'
check "the rebuild on the new Mac is given the model, and only fixed words besides" 'grep -q "/bin/zsh flint/apps/studio/rebuild.sh --from flint-rebuild-bundle --model fixture-model:1b" "$remote/calls.log"'
check "every ssh and scp call names the new Mac after --, so its name can never be read as an option" '! grep -vE "^(ssh|scp) .* -- " "$remote/calls.log"'
leftover() { local -a x; x=("$TMP"/flint-rebuild.*(N)); (( ${#x} > 0 )); }
check "the opened backups on the MacBook are removed when it ends" '! leftover'
# The new Mac cannot be reached: it stops, and the opened backups on the MacBook are removed.
rm -rf "${remote:?}"; mkdir -p "$remote"; : > "$remote/refuse-first"
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key")"; st=$?
check "a new Mac that cannot be reached stops it, with what to do" '[ "$st" = 1 ] && [[ "$to_out" == *"Flint could not reach the new Mac, or a rebuild'"'"'s files are already there. Turn on Remote Login on the new Mac"* ]]'
check "and nothing was sent" '[ ! -e "$remote/home" ] && ! grep -q "^scp" "$remote/calls.log"'
check "and the MacBook keeps no opened backups" '! leftover'

(( fail )) && exit 1
printf 'ok: the rebuild rehearsal passed (fixture %.0fs, rehearsal %.0fs of which the rebuild itself %ss, the rebuild with no database backup %ss, refusals and the MacBook half %.0fs)\n' \
  $(( t_fixture - t_start )) $(( t_rehearsal - t_fixture )) "$(print -r -- "$out" | sed -nE 's/^The rehearsal passed in ([0-9]+) seconds.*/\1/p')" \
  "$(print -r -- "$r_out" | sed -nE 's/^The rehearsal passed in ([0-9]+) seconds.*/\1/p')" $(( SECONDS - t_stop ))
