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
# says what is missing and is skipped, unless FLINT_REQUIRE_REHEARSAL=1 (the
# deploy gate and the weekly run set it), where a missing tool is a failure: a
# rehearsal that did not run must never read as one that passed.
set -u
umask 077
here=${0:A:h}
studio=${here:h}
repo=${studio:h:h}
source "$studio/recovery_lib.sh"
rebuild="$studio/rebuild.sh"
TMP="${${TMPDIR:-/tmp}%/}"

skip() {
  if [[ ${FLINT_REQUIRE_REHEARSAL:-} == 1 ]]; then print -r -- "FAIL the rehearsal could not run: $1"; exit 1; fi
  print -r -- "skipped: $1"; exit 0
}
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

# What an earlier run left when it was killed outright (kill -9 runs no cleanup): its scratch folders,
# and a Postgres still running in one. Only folders this test makes, by their own prefixes, directly
# in the temp folder, this user's, and only once the run that made them is gone.
sweep() {
  emulate -L zsh
  local dir pidfile pid pg
  for dir in "$TMP"/flint-rr.*(N/) "$TMP"/flint-ro.*(N/); do
    [[ -O $dir && ! -L $dir ]] || continue
    pidfile="$dir/owner.pid"
    if [[ -r $pidfile ]]; then
      read -r pid < "$pidfile"
      [[ $pid == <-> ]] && kill -0 "$pid" 2>/dev/null && continue   # that run is still going
    else
      # No record of who made it: left alone until it is plainly old.
      (( $(date +%s) - $(stat -f %m "$dir") > 7200 )) || continue
    fi
    for pg in "$dir"/rr.*/old/pg(N/) "$dir"/rr.*/*/pg(N/); do
      [[ -f $pg/postmaster.pid ]] && "$PGBIN/pg_ctl" -D "$pg" -m immediate -w -t 20 stop >/dev/null 2>&1
    done
    rm -rf "${dir:?}"
  done
}
sweep
root="${FLINT_REHEARSAL_DIR:-$(mktemp -d "$TMP/flint-rr.XXXXXX")}"
mkdir -p "$root" || { print -r -- "FAIL could not make $root"; exit 1; }
[[ -n ${FLINT_REHEARSAL_DIR:-} ]] || print -r -- $$ > "$root/owner.pid"
fx="${root:A}/rr.$$"
mkdir -m 700 "$fx" || { print -r -- "FAIL could not make $fx"; exit 1; }
oldsock="$(mktemp -d "$TMP/flint-ro.XXXXXX")"
print -r -- $$ > "$oldsock/owner.pid"
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }
cleanup() {
  for d in "$fx"/new "$fx"/r*(N/); do [[ -f $d/.flint-rehearsal ]] && /bin/zsh "$rebuild" --stop "$d" >/dev/null 2>&1; done
  [[ -f $fx/old/pg/postmaster.pid ]] && "$PGBIN/pg_ctl" -D "$fx/old/pg" -m immediate -w -t 20 stop >/dev/null 2>&1
  rm -rf "${fx:?}" "${oldsock:?}"
  [[ -n ${FLINT_REHEARSAL_DIR:-} ]] || { rm -f "$root/owner.pid"; rmdir "$root" 2>/dev/null; }
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
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
# The commit its server is running, as the installer writes it down: a rebuild installs that version.
old_commit="$(git -C "$repo" rev-parse HEAD)"
print -r -- "$old_commit 1700000000" > "$odata/server.version"
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
# The next night's archive, the one the rebuild uses, is NOT one Flint's backup would make. The offsite
# folder can be written by anyone who holds the public key, so this one is made the way someone who
# wanted the rebuilt Mac would make it: every secret in it, and the files a rebuild must never take
# under names that differ only in case (this disk does not tell upper case from lower): a connector
# list whose commands the server would run, token files, the tailnet state, a settings file, a program
# where the runtime's releases live, a list of names for the nightly backup to delete, and another key
# for future backups to be encrypted to. A rebuild must unpack none of it.
print -r -- '{"q":"second","a":"two"}' >> "$odata/training/corpus.jsonl"
stage="$fx/stage"; cp -Rp "$odata" "$stage"
other_key="$fx/other-key.txt"; "$AGE_KEYGEN" -o "$other_key" >/dev/null 2>&1; FORGED_RECIPIENT="$("$AGE_KEYGEN" -y "$other_key")"
print -r -- "$FORGED_RECIPIENT" > "$stage/backup-age-recipient"
print -r -- '{"servers":[{"name":"planted","command":"/bin/sh","args":["-c","touch '"$fx"'/the-planted-connector-ran"]}]}' > "$stage/mcp.json"
mv "$stage/mcp.json" "$stage/MCP.JSON"; mv "$stage/tokens" "$stage/Tokens"; mv "$stage/tailscaled.state" "$stage/Tailscaled.state"
print -r -- "PLANTED_SETTING=1" > "$stage/planted.ENV"
print -r -- "FLINT_DB_URL=postgresql://flint_app:planted@db.example.com:5432/flint" >> "$stage/backup.env"; mv "$stage/backup.env" "$stage/backup.ENV"
mkdir -p "$stage/runtime/releases/0000000000000000000000000000000000000000"; print -r -- "planted" > "$stage/runtime/releases/0000000000000000000000000000000000000000/runtime.mjs"
print -r -- "../../../somewhere/else" > "$stage/offsite-backups.txt"
print -r -- '{"anything":true}' > "$stage/autonomy.json"
# A folder whose name tar would read as a pattern, beside files that pattern would take: only the real
# adapters folder is asked for, by its own plain name.
mkdir -p "$stage/brain/adapters*"; print -r -- "inside-the-star-folder" > "$stage/brain/adapters*/x.txt"
print -r -- "taken-by-a-pattern" > "$stage/brain/adapters_note.txt"; print -r -- "not-an-adapter" > "$stage/brain/other.txt"
# One member whose owner's name has a space in it, which would shift the size out of its column in a
# listing by name: appended to the archive under that name before it is compressed.
print -r -- "${(l:5000::x:):-}" > "$stage/memory/spaced-owner.txt"
tar -cf "$fx/hostile.tar" -C "$stage" --exclude ./memory/spaced-owner.txt .
tar -rf "$fx/hostile.tar" --uname 'a b' --gname 0 -C "$stage" ./memory/spaced-owner.txt
check "the made-up archive really has an owner name with a space in it" 'tar -tvf "$fx/hostile.tar" | grep -q " a b  *0  *5001 .*spaced-owner.txt$"'
gzip -c "$fx/hostile.tar" | "$AGE" -r "$recipient" -o "$icloud/flint-20261012-0230.tar.gz.age"
rm -f "$fx/hostile.tar"
newest_names="$("$AGE" -d -i "$key" "$icloud/flint-20261012-0230.tar.gz.age" | tar -tzf -)"
in_newest() { local n; for n in "$@"; do print -r -- "$newest_names" | grep -qxF -- "$n" || return 1; done; }
check "the newest archive carries the secrets a rebuild must leave out" 'in_newest ./secrets.env ./token ./google/token.json ./enroll-code'
check "and the planted files, under names that differ only in case" 'in_newest ./MCP.JSON ./Tokens/runtime.token ./Tailscaled.state ./backup.ENV ./planted.ENV ./offsite-backups.txt ./runtime/releases/0000000000000000000000000000000000000000/runtime.mjs ./backup-age-recipient'
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
check "it says it starts from the backup, and what is in force afterwards" '[[ "$out" == *"The rebuilt Flint starts from the backup, so anything you revoked, switched off or told Flint to forget after it was made is back."* && "$out" == *"Flint may do nothing on its own after this restore: every action asks you first."* ]]'

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
check "the restore wrote its audit entry, as a rebuild that asked no one" '[ "$(npsql "SELECT (inputs->>'"'"'mode'"'"') || chr(32) || actor || chr(32) || context || chr(32) || coalesce(tier, chr(45)) FROM \"AuditEntry\" WHERE action = '"'"'restore.production'"'"'")" = "rebuild rebuild deploy -" ]'
check "the role that restored the backup owns nothing afterwards, and the empty database it replaced is gone" '[ "$(npsql "SELECT count(*) FROM pg_database WHERE datdba = '"'"'flint_restore'"'"'::regrole OR datname LIKE '"'"'flint\_%\_%'"'"'" postgres)" = 0 ]'
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
check "a program in the backup is not unpacked at all, and nothing that was unpacked can run" '[ ! -e "$ndata/bin" ] && ! find "$ndata/memory" "$ndata/training" "$ndata/eval" "$ndata/brain" -type f -perm +111 | grep -q .'
check "only your data was unpacked: nothing else the archive held is there" '[ ! -e "$ndata/autonomy.json" ] && [ ! -e "$ndata/offsite-backups.txt" ] && [ ! -e "$ndata/planted.env" ] && [ ! -e "$ndata/runtime/releases/0000000000000000000000000000000000000000" ]'
check "a folder named like a pattern is not asked for, and takes nothing beside it" '[ ! -e "$ndata/brain/adapters_note.txt" ] && [ ! -e "$ndata/brain/other.txt" ] && [ -z "$(find "$ndata/brain" -name "x.txt")" ] && [ "$(ls "$ndata/brain")" = adapters ]'
check "a member whose owner has a space in its name is restored like any other" '[ "$(stat -f %z "$ndata/memory/spaced-owner.txt")" = 5001 ]'
check "the planted connector list was never read: nothing it names was run" '[ ! -e "$fx/the-planted-connector-ran" ] && ! grep -rq "the-planted-connector-ran" "$ndata" 2>/dev/null'
check "the planted settings file was not unpacked: the database settings are this rebuild own" '! grep -rq "db.example.com" "$ndata" && ! grep -rq "PLANTED_SETTING" "$ndata"'
check "future backups are encrypted to your key, worked out from the key itself, not the one in the archive" '[ "$(<"$ndata/backup-age-recipient")" = "$recipient" ] && ! grep -rqF -- "$FORGED_RECIPIENT" "$nhome" && [ "$(stat -f %Lp "$ndata/backup-age-recipient")" = 600 ]'
check "it names what else the backup held and was not put back" '[[ "$out" == *"The backup also held "*" other thing(s) that a rebuild does not put back: "*"MCP.JSON"* && "$out" == *"that a rebuild does not put back: "*"autonomy.json"* ]]'
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
check "your switches are back in the server's settings" 'grep -qx "FLINT_TIER_HARD=openai:gpt-5" "$ndata/secrets.env" && grep -qx "FLINT_WORLD_NOW=1" "$ndata/secrets.env"'
check "who may reach Flint over the tailnet is never taken from a backup" '! grep -q "FLINT_TAILNET_USER" "$ndata/secrets.env" && ! grep -rq "someone@example.com" "$ndata"/*.env'
check "and in the runtime's" 'grep -qx "FLINT_RUNTIME_TRIAGE=off" "$ndata/runtime.override.env" && grep -qx "FLINT_SOURCE_GOOGLE_CALENDAR=off" "$ndata/runtime.override.env" && [ "$(stat -f %Lp "$ndata/runtime.override.env")" = 600 ]'
check "and in the server's LaunchAgent" '[ "$(pget "$nagents/com.flint.server.plist" OLLAMA_MODEL)" = "fixture-model:1b" ] && [ "$(pget "$nagents/com.flint.server.plist" OLLAMA_NUM_CTX)" = 4096 ] && [ "$(pget "$nagents/com.flint.server.plist" FLINT_BUDGET_ANTHROPIC_DAILY_USD)" = 5 ]'
check "and in the local model's" '[ "$(pget "$nagents/com.flint.ollama.plist" OLLAMA_KEEP_ALIVE)" = 24h ]'
check "the runtime got the restored model and spend cap through its installer" 'grep -qx "FLINT_TRIAGE_MODEL=fixture-model:1b" "$ndata/runtime.env" && grep -qx "FLINT_BUDGET_ANTHROPIC_DAILY_USD=5" "$ndata/runtime.env"'
check "a rehearsal never points at the real Flint: its server port, runtime and model address are its own" '[ "$(pget "$nagents/com.flint.server.plist" PORT)" = "$sport" ] && grep -qx "FLINT_RUNTIME_URL=http://\[::1\]:$rport" "$ndata/secrets.env" && [ "$(pget "$nagents/com.flint.server.plist" OLLAMA_HOST)" = "http://127.0.0.1:9" ] && ! grep -qx "FLINT_RUNTIME_URL=http://\[::1\]:8090" "$ndata/secrets.env"'
check "the backup settings are back, with this home folder in the path" 'grep -qxF "FLINT_OFFSITE_DIR=$nhome/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg" "$ndata/backup.env"'
check "it says how many settings it put back, and each one by name and value" '[[ "$out" == *"Flint put back "*" of your settings:"* && "$out" == *$'"'"'\n'"'"'"  FLINT_TIER_HARD is openai:gpt-5."* && "$out" == *"  OLLAMA_MODEL is fixture-model:1b."* && "$out" == *"  FLINT_RUNTIME_TRIAGE is off."* ]]'
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
check "only what a rehearsal loads was loaded: the server, the runtime, its nightly backup and the weekly rehearsal" '[ "$(ls "$new/state/loaded" | sort | tr "\n" " ")" = "com.flint.rebuild-rehearsal com.flint.runtime com.flint.runtime-backup com.flint.server " ]'
check "the weekly rehearsal is recorded and was not run" '[ ! -e "$new/state/pids/com.flint.rebuild-rehearsal" ]'
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
# A marker copied or planted in another folder names the folder it came from, so it stops and removes nothing.
mkdir -p "$fx/planted-marker/state"; print -r -- "$fx/somewhere-else" > "$fx/planted-marker/.flint-rehearsal"; print -r -- "$fx/old" > "$fx/planted-marker/state/socket-dir"
check "--stop leaves alone a folder whose marker is not its own" '! /bin/zsh "$rebuild" --stop "$fx/planted-marker" >/dev/null 2>&1 && [ -d "$fx/planted-marker" ] && [ -d "$fx/old/home" ]'
rm -rf "${fx:?}/planted-marker"

# ==== 2b. no database backup offsite, on a Mac that had a Flint before (--replace-existing) ====
# The files come back and Flint starts with an empty database that the installer migrates. The Mac
# already has Flint's files and its database roles from an earlier install: with the owner's word the
# files are set aside, and every role gets a new password.
ic4="$fx/icloud4/FlintBackups"; mkdir -p "${ic4:h}"; cp -R "$icloud" "$ic4"; rm -rf "${ic4:?}/pg"
/bin/zsh "$rebuild" --unseal "$fx/nodb" --offsite "$ic4" --key "$key" --without-database >/dev/null 2>&1
/bin/zsh "$rebuild" --unseal "$fx/good" --offsite "$icloud" --key "$key" >/dev/null 2>&1
check "the newest backups open into a folder" '[ -s "$fx/good/MANIFEST.sha256" ] && [ -s "$fx/good/$dump_name" ] && [ -s "$fx/good/$dump_name.counts.json" ]'
check "the opened folder names the key future backups go to, worked out from the key" 'grep -qxF "recipient=$recipient" "$fx/good/bundle.info" && grep -qx "version=2" "$fx/good/bundle.info"'
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
FLINT_REHEARSAL_EXISTING=roles refused "roles left by an earlier install are found before anything changes" "The database server on this Mac still has Flint's roles from an earlier install. Nothing was changed. To rebuild over what is here, add --replace-existing" --rehearse "$fx/r0x" --bundle "$fx/nodb"
r0="$fx/r0"
r_out="$(FLINT_REHEARSAL_EXISTING=files,roles /bin/zsh "$rebuild" --rehearse "$r0" --bundle "$fx/nodb" --replace-existing --keep-running 2>&1)"; st=$?
check "a rebuild with no database backup, over an earlier install, passes its rehearsal" '[ "$st" = 0 ] && [[ "$r_out" == *"The rehearsal passed in "* ]]'
[[ $st == 0 ]] || { print -r -- "$r_out"; for f in "$r0".failed-log/*(N); do print -r -- "---- ${f:t}"; tail -n 12 "$f"; done; rm -rf "${r0:?}.failed-log"; }
check "it says the database starts empty" '[[ "$r_out" == *"No database backup was restored, so Flint starts with an empty database."* ]]'
check "it says where the files that were there are kept" '[[ "$r_out" == *"The Flint data that was here is kept in .flint.before-rebuild-"* ]]'
if [[ $st == 0 ]]; then
  kept_before=("$r0"/home/.flint.before-rebuild-*/already-here(N))
  check "the files that were there are kept, and the new ones are in place" '(( ${#kept_before} == 1 )) && [ ! -e "$r0/home/.flint/already-here" ] && [ ! -e "$r0/home/.flint/.rebuild-in-progress" ]'
  check "the files still came back" 'cmp -s "$odata/training/corpus.jsonl" "$r0/home/.flint/training/corpus.jsonl"'
  r0sock="$(awk -F'\t' '$1 == "pg_socket" { print $2 }' "$r0/report.tsv")"; r0port="$(awk -F'\t' '$1 == "pg_port" { print $2 }' "$r0/report.tsv")"
  r0psql() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$r0sock" -p "$r0port" -U "$me" -d flint -c "$1"; }
  check "the empty database was migrated by the runtime's installer" '[ "$(r0psql "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")" = "$(ls -d "$repo"/apps/runtime/prisma/migrations/2*/ | wc -l | tr -d " ")" ] && [ "$(r0psql "SELECT count(*) FROM \"Proposal\"")" = 0 ]'
  check "and a copy was taken before migrating, as on every runtime update" '[ -n "$(ls "$r0/home/FlintBackups/pre-migrate" 2>/dev/null)" ]'
  check "the roles that were there have passwords now, and all five exist" '[ "$(r0psql "SELECT count(*) FROM pg_authid WHERE rolname LIKE '"'"'flint\\_%'"'"' AND rolpassword LIKE '"'"'SCRAM-SHA-256%'"'"'")" = 5 ]'
  /bin/zsh "$rebuild" --stop "$r0" >/dev/null 2>&1
fi
check "nothing of it is left" '[ ! -e "$r0" ] && ! pgrep -f "$r0/" >/dev/null'

# ==== 2c. a rebuild that stopped after it had put a database in place, run again ====
# The marker says the earlier rebuild made that database, so it is made again, empty, and the
# backup is restored into it. What the first try left in the data folder is set aside and removed.
r0b="$fx/r0b"
r_out2="$(FLINT_REHEARSAL_EXISTING=resume-database /bin/zsh "$rebuild" --rehearse "$r0b" --bundle "$fx/good" --keep-running 2>&1)"; st=$?
check "a rebuild run again after a database was left passes its rehearsal" '[ "$st" = 0 ] && [[ "$r_out2" == *"The rehearsal passed in "* ]]'
[[ $st == 0 ]] || { print -r -- "$r_out2"; for f in "$r0b".failed-log/*(N); do print -r -- "---- ${f:t}"; tail -n 12 "$f"; done; rm -rf "${r0b:?}.failed-log"; }
check "it says it is starting a stopped rebuild over" '[[ "$r_out2" == *"An earlier rebuild stopped part-way on this Mac. Flint is starting it over."* ]]'
if [[ $st == 0 ]]; then
  check "what the first try left is gone, and the rebuild is marked finished" '[ ! -e "$r0b/home/.flint/left-by-the-first-try" ] && [ ! -e "$r0b/home/.flint/.rebuild-in-progress" ] && [ -z "$(print -l "$r0b"/home/.flint.rebuild-stopped-*(N))" ]'
  r0bsock="$(awk -F'\t' '$1 == "pg_socket" { print $2 }' "$r0b/report.tsv")"; r0bport="$(awk -F'\t' '$1 == "pg_port" { print $2 }' "$r0b/report.tsv")"
  r0bpsql() { "$PGBIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h "$r0bsock" -p "$r0bport" -U "$me" -d flint -c "$1"; }
  check "the database the first try left was replaced by the backup, whole" '[ "$(r0bpsql "SELECT count(*) FROM \"Proposal\"")" = 3 ] && [ "$(r0bpsql "SELECT to_regclass('"'"'public.left_by_the_first_try'"'"') IS NULL")" = t ] && [ "$(r0bpsql "SELECT count(*) FROM \"AuditEntry\" WHERE action = '"'"'restore.production'"'"' AND outcome = '"'"'ok'"'"'")" = 1 ]'
  /bin/zsh "$rebuild" --stop "$r0b" >/dev/null 2>&1
fi
check "nothing of that one is left either" '[ ! -e "$r0b" ] && ! pgrep -f "$r0b/" >/dev/null'
t_stop=$SECONDS

# ==== 3. refusals: each one stops before anything is restored, and leaves nothing behind ====
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
check "damaged is not said of an archive that is whole" '[[ "$u_out" != *"never does"* ]]'
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
check "and it is called what it is, not damaged" '/bin/zsh "$rebuild" --unseal "$fx/b5x" --offsite "$ic5" --key "$key" --without-database 2>&1 | grep -q "The files backup from 2026-10-12 at 02:30 holds something a backup of Flint.s never does, so Flint did not use it"'
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
# The same path through a link, with the link written one way (./through/door) and the file another (through/door/file).
rm -f "$ic5"/*
tar -czf - -C "$fx/evil2" -s ',^payload,through/door,' ./through payload | "$AGE" -r "$recipient" -o "$ic5/flint-20261012-0230.tar.gz.age"
check "the made-up archive writes the link and the path through it in two forms" '"$AGE" -d -i "$key" "$ic5/flint-20261012-0230.tar.gz.age" | tar -tzf - | grep -qx "./through/door" && "$AGE" -d -i "$key" "$ic5/flint-20261012-0230.tar.gz.age" | tar -tzf - | grep -qx "through/door/file"'
refused "a path through a link is refused however the two names are written" "There is no files backup Flint can open in that folder." --unseal "$fx/b5d" --offsite "$ic5" --key "$key" --without-database
check "and nothing was written outside that way either" '[ -z "$(ls -A "$fx/escaped")" ]'
# Two names for one place: this disk does not tell upper case from lower, so the second would replace the first.
rm -f "$ic5"/*; mkdir -p "$fx/evil3"; print -r -- one > "$fx/evil3/x1"; print -r -- two > "$fx/evil3/x2"
tar -czf - -C "$fx/evil3" -s ',^x1$,memory/Knowledge.json,' -s ',^x2$,memory/knowledge.json,' x1 x2 | "$AGE" -r "$recipient" -o "$ic5/flint-20261012-0230.tar.gz.age"
refused "an archive with two names that differ only in case is refused" "There is no files backup Flint can open in that folder." --unseal "$fx/b5e" --offsite "$ic5" --key "$key" --without-database
# The size an archive unpacks to, counted by the rebuild's own check (read out of the script, with a cap small
# enough to reach here): the same whoever the archive says owns its files. An owner's name with a space in it
# once moved the size out of its column, and such a file counted for nothing.
eval "$(sed -n '/^archive_is_safe() {$/,/^}$/p' "$rebuild")"
typeset -ga ARCHIVE_NAMES; ARCHIVE_BYTES=0 ARCHIVE_MAX_FILES=2000000 ARCHIVE_MAX_BYTES=0
mkdir -p "$fx/sized/memory"; print -r -- "${(l:5000::x:):-}" > "$fx/sized/memory/big.txt"
tar -czf "$fx/sized-plain.tar.gz" -C "$fx/sized" .
tar -czf "$fx/sized-spaced.tar.gz" --uname 'a b' --gname 0 -C "$fx/sized" .
check "the second made-up archive names its owner with a space" 'tar -tvzf "$fx/sized-spaced.tar.gz" | grep -q " a b  *0  *5001 "'
for owner in plain spaced; do
  ARCHIVE_MAX_BYTES=6000
  check "an archive's size is counted whoever owns its files ($owner)" 'archive_is_safe "$fx/sized-$owner.tar.gz" && [ "$ARCHIVE_BYTES" = 5001 ]'
  ARCHIVE_MAX_BYTES=4000
  check "and one over the cap is refused ($owner)" '! archive_is_safe "$fx/sized-$owner.tar.gz"'
done
# A settings file tucked inside one of the folders a rebuild does unpack: caught on the disk, after unpacking,
# and what was unpacked is removed.
ic7="$fx/icloud7/FlintBackups"; mkdir -p "$ic7" "$fx/evil4/memory"
print -r -- '{"facts":[]}' > "$fx/evil4/memory/knowledge.json"; print -r -- "FLINT_TOKEN=planted" > "$fx/evil4/memory/Secrets.ENV"
tar -czf - -C "$fx/evil4" . | "$AGE" -r "$recipient" -o "$ic7/flint-20261012-0230.tar.gz.age"
refused "a settings file inside an unpacked folder stops the rebuild" "The files backup holds a settings file, which a backup of Flint's never does. Flint removed what it had unpacked and stopped." --rehearse "$fx/r2" --offsite "$ic7" --key "$key" --without-database
# iCloud has not downloaded the newest archive: Flint asks for it and waits; if it never comes, the one before is used.
ic6="$fx/icloud6/FlintBackups"; mkdir -p "${ic6:h}"; cp -R "$icloud" "$ic6"
mv "$ic6/flint-20261012-0230.tar.gz.age" "$fx/held-back.age"; : > "$ic6/.flint-20261012-0230.tar.gz.age.icloud"
u_out="$(FLINT_ICLOUD_WAIT=1 /bin/zsh "$rebuild" --unseal "$fx/b6" --offsite "$ic6" --key "$key" 2>&1)"; st=$?
check "an archive still in iCloud is passed over after waiting" '[ "$st" = 0 ] && [[ "$u_out" == *"The files backup from 2026-10-12 at 02:30 has not come down from iCloud, so Flint is using the one before it."* ]]'

# An opened folder that changed after it was opened (its fingerprints no longer match).
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
# A folder opened by another version of this script: its list of fingerprints is in order, and it is still opened again.
tamper; sed -i '' 's/^version=2$/version=1/' "$fx/tampered/bundle.info"
info_sum="$(shasum -a 256 "$fx/tampered/bundle.info")"; sed -i '' "s/^[0-9a-f]\{64\}  bundle\.info\$/${info_sum%% *}  bundle.info/" "$fx/tampered/MANIFEST.sha256"
refused "a folder opened by another version of the script is refused" "The opened backups were made by another version of this script. Open the backups again." --rehearse "$fx/r3" --bundle "$fx/tampered"
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
# A rehearsal aimed inside Flint's own folders. The home folder here is a stand-in: the guard is the same, and the real one is never named.
pretend="$fx/pretend-home"; mkdir -p "$pretend/.flint"
HOME="$pretend" refused "a rehearsal inside Flint's own folders is refused" "A rehearsal never runs inside Flint's own folders." --rehearse "$pretend/.flint/rehearsal-must-not-be-here" --bundle "$fx/good"
check "and made nothing there" '[ -z "$(ls -A "$pretend/.flint")" ]'

# A missing tool: said by name, with how to get it.
nodebin=${$(whence -p node):h}
missing() { env -i HOME="$HOME" TMPDIR="$TMP" PATH="$1" FLINT_TOOL_PATHS="$2" /bin/zsh "$rebuild" "${@:3}" 2>&1; }
m_out="$(missing "$nodebin:/usr/bin:/bin" "$PGBIN" --unseal "$fx/b7" --offsite "$icloud" --key "$key")"; st=$?
check "without age it says so, and how to install it, with the command on its own line" '[ "$st" = 1 ] && [[ "$m_out" == "The program age is not installed, and Flint needs it to open a backup. Install it with this command:"$'"'"'\n'"'"'"  brew install age" ]]'
m_out="$(missing "$nodebin:/usr/bin:/bin" "" --rehearse "$fx/r7" --bundle "$fx/good")"; st=$?
check "without Postgres it says so, and how to install it" '[ "$st" = 1 ] && [[ "$m_out" == "Postgres 17 is not installed, and the rehearsal needs it. Install it with this command:"$'"'"'\n'"'"'"  brew install postgresql@17" ]] && [ ! -e "$fx/r7" ]'
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

# ==== 3b. which version of Flint's code a rebuild installs ====
# The commit the old Mac was running, as its backup names it: never simply main's newest, which may be
# the very commit updates were paused to avoid. A checkout with changes of its own is never touched.
gitq() { HOME="$fx/githome" GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }
mkdir -p "$fx/githome" "$fx/origin.git" "$fx/seed"
gitq -C "$fx/origin.git" init --quiet --bare
gitq -C "$fx/seed" init --quiet
for n in one two three; do print -r -- $n > "$fx/seed/file"; gitq -C "$fx/seed" add file; gitq -C "$fx/seed" commit --quiet -m $n; done
gitq -C "$fx/seed" push --quiet "$fx/origin.git" main
c1="$(gitq -C "$fx/seed" rev-parse HEAD~2)" c2="$(gitq -C "$fx/seed" rev-parse HEAD~1)" c3="$(gitq -C "$fx/seed" rev-parse HEAD)"
co() { rm -rf "${fx:?}/checkout"; gitq clone --quiet "$fx/origin.git" "$fx/checkout"; }
deployed() { c_out="$(HOME="$fx/githome" GIT_CONFIG_NOSYSTEM=1 /bin/zsh "$rebuild" --checkout-deployed "$fx/checkout" "$@" 2>&1)"; c_st=$?; c_head="$(gitq -C "$fx/checkout" rev-parse HEAD)"; }
co; deployed "$c1" "$c2"
check "of two commits the backup names, the later one is installed" '[ "$c_st" = 0 ] && [ "$c_head" = "$c2" ] && [[ "$c_out" == "Flint'"'"'s code is the version the old Mac was running." ]]'
co; deployed "$c2" "$c1"
check "whichever order they are named in" '[ "$c_head" = "$c2" ]'
co; deployed "$c1"
check "one commit named: that one, not the newest" '[ "$c_head" = "$c1" ]'
co; deployed
check "none named: the newest, and it says the code is tested before it is installed" '[ "$c_st" = 0 ] && [ "$c_head" = "$c3" ] && [[ "$c_out" == "The backup does not say which version the old Mac was running, so Flint uses the newest and tests it before installing it." ]]'
co; deployed "$(printf 'ab%.0s' {1..20})" 'not-a-commit; touch '"$fx"'/ran'
check "a commit main does not hold, or a name that is not a commit, is never checked out or run" '[ "$c_st" = 0 ] && [ "$c_head" = "$c3" ] && [ ! -e "$fx/ran" ]'
co; print -r -- mine > "$fx/checkout/file"; deployed "$c1"
check "a checkout with changed files is left exactly as it is, and that is a refusal" '[ "$c_st" = 1 ] && [ "$c_head" = "$c3" ] && [ "$(<"$fx/checkout/file")" = mine ] && [[ "$c_out" == *"has changes of its own, so Flint left it alone and stopped."* ]]'
co; print -r -- local > "$fx/checkout/file"; gitq -C "$fx/checkout" commit --quiet -am local; local_head="$(gitq -C "$fx/checkout" rev-parse HEAD)"; deployed "$c1"
check "so is one with commits of its own" '[ "$c_st" = 1 ] && [ "$c_head" = "$local_head" ]'

# ==== 4. the MacBook's half (--to), with stand-ins for ssh and scp: the key never leaves ====
sbin="$fx/sbin"; remote="$fx/remote"; mkdir -p "$sbin" "$remote"
print -r -- '#!/bin/zsh
# A stand-in for ssh: record what would run on the new Mac, and run nothing there. It answers the
# question asked before anything is sent the way a new Mac would (or the way $REMOTE/preflight says),
# and can be told to fail the rebuild itself once ($REMOTE/fail-rebuild-once).
print -r -- "ssh ${(j: :)${(q-)@}}" >> "$REMOTE/calls.log"
[[ " $* " == *" -O exit "* ]] && exit 0
[[ -e $REMOTE/unreachable ]] && exit 255
if [[ "$*" == *flint-preflight* ]]; then
  id=NEW-MAC-0000-0000
  [[ -r $REMOTE/preflight-id ]] && id="$(<"$REMOTE/preflight-id")"
  print -r -- "flint-preflight id=$id"
  [[ -r $REMOTE/preflight ]] && exit "$(<"$REMOTE/preflight")"
  exit 0
fi
if [[ "$*" == *"rebuild.sh --from"* && -e $REMOTE/fail-rebuild-once ]]; then rm -f "$REMOTE/fail-rebuild-once"; exit 1; fi
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
# Its own temp folder, so "nothing left behind" is checked where this run worked and nowhere else.
totmp="$fx/t"; mkdir -p "$totmp" "$fx/macbook"
to() { env -i HOME="$fx/macbook" TMPDIR="$totmp" REMOTE="$remote" PATH="$sbin:${AGE:h}:$nodebin:/usr/bin:/bin" /bin/zsh "$rebuild" --to "$@" 2>&1; }
fresh_remote() { rm -rf "${remote:?}"; mkdir -p "$remote"; }
line_of() { grep -n -- "$1" "$remote/calls.log" | head -1 | cut -d: -f1; }
leftover() { local -a x; x=("$totmp"/flint-rebuild.*(N) "$totmp"/flint-age.*(N)); (( ${#x} > 0 )); }
sockets_before=(/tmp/flint-ssh.*(N))
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key" --model fixture-model:1b)"; st=$?
check "--to runs through to the end" '[ "$st" = 0 ]'
[[ $st == 0 ]] || print -r -- "$to_out"
check "it tells the owner what is happening, in sentences" '[[ "$to_out" == *"Flint is connecting to the new Mac. Enter that Mac'"'"'s password when it asks."* && "$to_out" == *"The backups are on the new Mac. Flint is setting it up."* ]]'
check "the opened backups were sent, and nothing else but the toolchain script" '[ "$(ls "$remote/home/flint-rebuild-bundle" | sort | tr "\n" " ")" = "$(ls "$fx/good" | sort | tr "\n" " ")" ] && cmp -s "$remote/home/flint-rebuild-toolchain.sh" "$rebuild"'
check "the backup key was never sent: not its file, not its contents, not its path" '! grep -rqF -- "$KEY_SECRET" "$remote" && ! grep -q "backup-key" "$remote/calls.log" && ! ls "$remote/home" "$remote/home/flint-rebuild-bundle" | grep -qi key'
check "what was sent is what was opened (the fingerprints match)" '( cd "$remote/home/flint-rebuild-bundle" && shasum -a 256 -c MANIFEST.sha256 >/dev/null 2>&1 )'
check "the new Mac is asked whether it is fit before anything is sent; then its folder is cleared, the backups sent, it is set up, and rebuilt, in that order" '[ "$(line_of flint-preflight)" -lt "$(line_of "rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh && mkdir -m 700 flint-rebuild-bundle")" ] && [ "$(line_of "mkdir -m 700 flint-rebuild-bundle")" -lt "$(line_of "^scp")" ] && [ "$(line_of "^scp")" -lt "$(line_of "--toolchain")" ] && [ "$(line_of "--toolchain")" -lt "$(line_of "rebuild.sh --from flint-rebuild-bundle")" ]'
check "the question it asks is fixed text: FileVault, a login session, Flint already there, Flint running" 'grep -q "fdesetup status" "$remote/calls.log" && grep -q "launchctl print" "$remote/calls.log" && grep -q "rebuild-in-progress" "$remote/calls.log" && grep -q "com\\\\.flint" "$remote/calls.log"'
check "the new Mac is set up at the version the old Mac was running, as the backup names it" 'grep -q -- "--toolchain https://github.com/[A-Za-z0-9._/-]* $old_commit;" "$remote/calls.log"'
check "the rebuild on the new Mac is given the model, told it is read on another screen, and only fixed words besides" 'grep -q "/bin/zsh flint/apps/studio/rebuild.sh --from flint-rebuild-bundle --from-another-mac --model fixture-model:1b" "$remote/calls.log"'
check "every ssh and scp call names the new Mac after --, so its name can never be read as an option" '! grep -vE "^(ssh|scp) .* -- " "$remote/calls.log"'
check "the connection is kept alive, and its socket is in a short folder of its own" 'grep -q "ServerAliveInterval=30" "$remote/calls.log" && grep -q "ControlPath=/tmp/flint-ssh\.[A-Za-z0-9]*/%C" "$remote/calls.log"'
check "the opened backups on the MacBook are removed when it ends, and so is the connection's folder" '! leftover && [ "$(print -l /tmp/flint-ssh.*(N))" = "$(print -l $sockets_before)" ]'
check "nothing was removed from the new Mac after a rebuild that finished" '[ "$(grep -c "rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh" "$remote/calls.log")" = 1 ]'

# A new Mac that is not fit: said in a sentence, and NOTHING is sent, opened backups least of all.
unfit() { # <what the new Mac answers> <words it must say> [<its id>]
  fresh_remote; print -r -- "$1" > "$remote/preflight"; [[ -n ${3:-} ]] && print -r -- "$3" > "$remote/preflight-id"
  to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key")"; st=$?
  if [[ $st == 1 && $to_out == *"$2"* ]]; then :; else print -r -- "FAIL an unfit new Mac ($1) is refused (exit $st): $to_out"; fail=1; fi
  if grep -q "^scp" "$remote/calls.log" || [[ -e $remote/home ]] || grep -q -- "--toolchain\|mkdir" "$remote/calls.log"; then print -r -- "FAIL something was sent to, or run on, an unfit new Mac ($1)"; fail=1; fi
  leftover && { print -r -- "FAIL the MacBook kept opened backups after refusing ($1)"; fail=1; }
  return 0
}
unfit 11 "FileVault is off on the new Mac, and a rebuild puts your memory and history on its disk. Turn FileVault on there in System Settings, then run this again. Nothing was sent."
unfit 12 "Log in at the new Mac's own screen first, and leave it logged in. Flint runs in your login session. Nothing was sent."
unfit 13 "That Mac already has Flint's files. Nothing was sent, and nothing there was changed."
unfit 15 "Flint is running on that Mac, so it is not a new Mac. Nothing was sent, and nothing there was changed."
unfit 10 "Flint rebuilds only onto a Mac. Nothing was sent."
my_id="$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }')"
unfit 0 "That is this Mac. Name the new Mac. Nothing was changed." "$my_id"
# With --replace-existing the new Mac is told so, and it is still asked first.
fresh_remote
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key" --replace-existing)"; st=$?
check "--replace-existing reaches the question and the rebuild" '[ "$st" = 0 ] && grep -q "flint-preflight 1.\{0,2\}$" "$remote/calls.log" && grep -q "rebuild.sh --from flint-rebuild-bundle --from-another-mac --replace-existing" "$remote/calls.log"'
# The new Mac cannot be reached: it stops, and nothing was opened or sent.
fresh_remote; : > "$remote/unreachable"
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key")"; st=$?
check "a new Mac that cannot be reached stops it, with what to do" '[ "$st" = 1 ] && [[ "$to_out" == *"Flint could not reach the new Mac. Turn on Remote Login there (System Settings, General, Sharing), check its name, and run this again. Nothing was sent."* ]]'
check "and nothing was sent" '[ ! -e "$remote/home" ] && ! grep -q "^scp" "$remote/calls.log"'
check "and the MacBook keeps no opened backups" '! leftover'
# The rebuild on the new Mac fails part-way: the opened backups are taken off it again, and the same
# command, run a second time, clears whatever is left there and goes through.
fresh_remote; : > "$remote/fail-rebuild-once"
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key")"; st=$?
check "a rebuild that stops on the new Mac says so, and to run it again" '[ "$st" = 1 ] && [[ "$to_out" == *"The rebuild stopped before it finished. What it printed above says why. Running this command again starts it over."* ]]'
check "and the opened backups are removed from the new Mac" '[ "$(grep -c "rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh" "$remote/calls.log")" = 2 ] && [ "$(line_of "rebuild.sh --from")" -lt "$(grep -n "rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh" "$remote/calls.log" | tail -1 | cut -d: -f1)" ]'
check "and from the MacBook" '! leftover'
: > "$remote/calls.log"
to_out="$(to someone@new-mac.local --offsite "$icloud" --key "$key")"; st=$?
check "the same command run again goes through: what the first try left there is cleared first" '[ "$st" = 0 ] && [ "$(line_of "rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh && mkdir -m 700 flint-rebuild-bundle")" -lt "$(line_of "^scp")" ] && grep -q "rebuild.sh --from flint-rebuild-bundle" "$remote/calls.log"'
check "and it leaves nothing on the MacBook" '! leftover'
bad_to="$(print -r -- "$to_out" | grep -vE "^[A-Z].*[.:]$|^  [A-Z].*\.$|^  [a-z~/].*$" || true)"
check "every line the MacBook half printed is a sentence" '[[ -z $bad_to ]]'
[[ -n $bad_to ]] && print -r -- "$bad_to"

(( fail )) && exit 1
printf 'ok: the rebuild rehearsal passed (fixture %.0fs, rehearsal %.0fs of which the rebuild itself %ss, the rebuild over an earlier install with no database backup %ss, the rebuild run again after a database was left %ss, refusals and the MacBook half %.0fs)\n' \
  $(( t_fixture - t_start )) $(( t_rehearsal - t_fixture )) "$(print -r -- "$out" | sed -nE 's/^The rehearsal passed in ([0-9]+) seconds.*/\1/p')" \
  "$(print -r -- "$r_out" | sed -nE 's/^The rehearsal passed in ([0-9]+) seconds.*/\1/p')" "$(print -r -- "$r_out2" | sed -nE 's/^The rehearsal passed in ([0-9]+) seconds.*/\1/p')" $(( SECONDS - t_stop ))
