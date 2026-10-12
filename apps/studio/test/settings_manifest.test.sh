#!/bin/zsh
# The settings manifest and the nightly settings snapshot, on a fixture shaped
# like ~/.flint and ~/Library/LaunchAgents. Run: zsh apps/studio/test/settings_manifest.test.sh
#
# What must hold:
#  - the manifest reads cleanly, and can never mark a secret-named setting as restorable;
#  - a value is saved only under a listed name, in that name's shape, and never
#    when it looks like a secret, whatever name it sits under;
#  - a setting the manifest does not list is named and never saved;
#  - settings files are read as text: nothing in one is ever run;
#  - the snapshot is 0600, and no secret value reaches it or the screen.
set -u
here=${0:A:h}
source "$here/../recovery_lib.sh"
script="$here/../settings_manifest.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

# ---- 1. the manifest itself -------------------------------------------------------------
check "the manifest loads" 'manifest_load'
check "it lists a real number of settings" '(( ${#MF_CLASS} > 120 ))'
for name in FLINT_TOKEN FLINT_DB_URL FLINT_DB_OWNER_URL; do
  check "$name is made fresh, never restored" 'manifest_lookup secrets.env $name && [[ $REPLY == generate ]]'
done
for name in ANTHROPIC_API_KEY OPENAI_API_KEY TAVILY_API_KEY NEXUS_MCP_TOKEN; do
  check "$name is re-entered, never restored" 'manifest_lookup secrets.env $name && [[ $REPLY == reenter ]]'
done
check "a server setting counts in the plist and in secrets.env alike" 'manifest_lookup secrets.env OLLAMA_MODEL && manifest_lookup server.plist FLINT_WORLD_NOW'
check "a name that is not listed is not found" '! manifest_lookup secrets.env NOT_A_SETTING'
check "the switch that turns the taint rule off is never restorable: a rebuilt Flint starts with it on" 'manifest_lookup secrets.env FLINT_TAINT_FLOOR && [[ $REPLY != restore ]]'
check "no restorable name says it is a secret" '! grep -E "^[a-z.]+ +[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]* +restore" "$SETTINGS_MANIFEST"'
check "the manifest holds names, never a value" '! grep -vE "^#|^$" "$SETTINGS_MANIFEST" | grep -E "=|://|sk-|[0-9a-f]{32}"'

bad() { print -r -- "$1" > "$fx/bad.manifest"; manifest_load "$fx/bad.manifest" 2>"$fx/bad.err"; }
check "a secret-named setting cannot be marked restorable" '! bad "secrets.env MY_API_KEY restore word" && grep -q "its name says it is a secret" "$fx/bad.err"'
check "nor a token, nor a password" '! bad "secrets.env FLINT_TOKEN restore word" && ! bad "secrets.env DB_PASSWORD restore word"'
check "a URL is restorable only as a loopback address" '! bad "secrets.env SOME_URL restore model" && bad "secrets.env SOME_URL restore loopback"'
check "an unknown value shape is refused" '! bad "secrets.env X restore anything-goes"'
check "an unknown class is refused" '! bad "secrets.env X keep word"'
check "a duplicate is refused" '! bad "secrets.env X restore word
secrets.env X generate rebuild"'
check "a line with too many or too few fields is refused" '! bad "secrets.env X restore word extra" && ! bad "secrets.env X restore"'
check "an empty manifest is refused" '! bad "# nothing"'
manifest_load

# ---- 2. what a value may look like ----------------------------------------------------------
ok()  { flint_value_ok "$1" "$2"; }
for row in \
  'onoff|on' 'onoff|off' 'number|16384' 'number|12.5' 'port|8080' 'model|muse-glimmer:30b' 'model|hf.co/someone/Model-7B-GGUF:Q4_K_M' \
  'spec|openai:gpt-5' 'word|v2' 'duration|24h' 'duration|-1' 'loopback|http://127.0.0.1:11434' 'loopback|http://[::1]:8090' \
  'bindaddr|127.0.0.1:11434' 'email|someone@example.com' 'zone|America/Chicago' 'place|Austin, Texas' \
  'homepath|~/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg'; do
  check "accepts ${row%%|*}: ${row#*|}" 'ok "${row%%|*}" "${row#*|}"'
done
long=$(printf 'a%.0s' {1..40})
for row in \
  'onoff|maybe' 'number|12abc' 'port|8' 'model|two words' 'model|a;rm -rf' 'model|$(id)' 'spec|nocolon' 'word|a/b' \
  'loopback|http://example.com:11434' 'loopback|https://127.0.0.1:11434' 'loopback|http://user:pw@127.0.0.1:1234' \
  'bindaddr|0.0.0.0:11434' 'bindaddr|192.168.1.5:11434' 'email|not-an-email' 'zone|America/Chi cago' \
  'homepath|/etc/passwd' 'homepath|~/../../etc' 'homepath|~/a/../b' 'nosuchshape|x' \
  "model|sk-ant-api03-short" "model|tvly-abc" "model|ghp_abcdef" "word|$long" "model|$long" "model|AKIAABCDEFGH" \
  'model|eyJhbGciOiJIUzI1NiJ9' 'word|age1qqqq' 'number|'; do
  check "refuses ${row%%|*}: ${row#*|}" '! ok "${row%%|*}" "${row#*|}"'
done
check "a URL with a password in it is secret-shaped" 'flint_secret_shaped "postgresql://flint_app:hunter2@[::1]:5432/flint"'
check "a 64-hex token is secret-shaped" 'flint_secret_shaped "$(printf "0123456789abcdef%.0s" 1 2 3 4)"'
check "a private key is secret-shaped" 'flint_secret_shaped "-----BEGIN PRIVATE KEY-----"'
check "an ordinary model name is not" '! flint_secret_shaped "muse-glimmer:30b"'

# ---- 3. the snapshot, on a fixture ------------------------------------------------------------
home="$fx/home"; data="$home/.flint"; agents="$home/Library/LaunchAgents"
mkdir -p "$data" "$agents"
hex=$(printf '0123456789abcdef%.0s' 1 2 3 4)
cat > "$data/secrets.env" <<ENV
# a comment
FLINT_TOKEN=$hex
ANTHROPIC_API_KEY=sk-ant-api03-THISISNOTAREALKEYTHISISNOTAREALKEY
FLINT_DB_URL=postgresql://flint_app:hunter2@[::1]:5432/flint
FLINT_RUNTIME_URL=http://[::1]:8090
FLINT_TAILNET_USER="someone@example.com"
export FLINT_TIER_HARD='openai:gpt-5'
FLINT_WORLD_NOW=1
FLINT_TTS_VOICE=$hex
PARITY_GOOGLE_MODEL=sk-ant-looks-like-a-key
FLINT_TIER_CODE=\$(touch "$fx/pwned-by-env")
SOMETHING_NEW=on
ENV
cat > "$data/runtime.override.env" <<ENV
FLINT_RUNTIME_TRIAGE=on
FLINT_SOURCE_APPLE_CALENDAR=on
NEXUS_READ_TOKEN=$hex
ENV
cat > "$data/backup.env" <<ENV
FLINT_DB_BACKUP_URL=postgresql://flint_backup:hunter3@[::1]:5432/flint
FLINT_OFFSITE_DIR=$home/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg
ENV
cat > "$data/runtime.env" <<ENV
DATABASE_URL=postgresql://flint_app:hunter2@[::1]:5432/flint
RUNTIME_PORT=8090
ENV
chmod 600 "$data"/*.env
render_template "$here/../templates/com.flint.server.plist.tmpl" "$agents/com.flint.server.plist" NODE=/usr/local/bin/node NODE_DIR=/usr/local/bin HOME="$home" PORT=8080
plist_set_env "$agents/com.flint.server.plist" OLLAMA_MODEL 'muse-glimmer:30b'
plist_set_env "$agents/com.flint.server.plist" OLLAMA_NUM_CTX 16384
plist_set_env "$agents/com.flint.server.plist" FLINT_BUDGET_ANTHROPIC_DAILY_USD 5
plist_set_env "$agents/com.flint.server.plist" FLINT_STYLE_VARIANT "$hex"
plist_set_env "$agents/com.flint.server.plist" FLINT_TOKEN "$hex"
plist_set_env "$agents/com.flint.server.plist" BRAND_NEW_SWITCH yes
render_template "$here/../templates/com.flint.ollama.plist.tmpl" "$agents/com.flint.ollama.plist" OLLAMA=/opt/homebrew/bin/ollama HOME="$home"
plist_set_env "$agents/com.flint.ollama.plist" OLLAMA_KEEP_ALIVE 24h
plist_set_env "$agents/com.flint.ollama.plist" OLLAMA_HOST 0.0.0.0:11434
print -r -- '{"servers":[{"name":"web","command":"node","env":{"SEARCH_API_KEY":"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"}},{"name":"runtime","command":"node"},{"name":"Bad Name!","command":"x"}]}' > "$data/mcp.json"

# The commit each part is running, as its installer writes it down; and a line that is not one.
sha_server=$(printf 'a1b2c3d4e5%.0s' 1 2 3 4); sha_runtime=$(printf '0f9e8d7c6b%.0s' 1 2 3 4)
print -r -- "$sha_server 1700000000" > "$data/server.version"
mkdir -p "$data/runtime/releases/$sha_runtime"; ln -s "$data/runtime/releases/$sha_runtime" "$data/runtime/current"
print -r -- 'not-a-commit; rm -rf ~' > "$data/runtime/version"

out=$(env -i HOME="$home" PATH=/usr/bin:/bin /bin/zsh "$script" 2>"$fx/err.log"); st=$?
snap="$data/settings-snapshot.tsv"
check "the snapshot run succeeds" '[ "$st" = 0 ]'
check "it says what it did, in one sentence" '[[ "$out" == "Flint saved 12 settings for a rebuild. It left out 7 it does not know or whose value looks like a secret." ]]'
check "the snapshot is 0600" '[ "$(stat -f %Lp "$snap")" = 600 ]'
check "nothing was left half-written" '[ ! -e "$snap.partial" ]'
T=$'\t'
want_set=(
  "secrets.env${T}FLINT_RUNTIME_URL${T}http://[::1]:8090"
  "secrets.env${T}FLINT_TIER_HARD${T}openai:gpt-5"
  "secrets.env${T}FLINT_WORLD_NOW${T}1"
  "runtime.override.env${T}FLINT_RUNTIME_TRIAGE${T}on"
  "runtime.override.env${T}FLINT_SOURCE_APPLE_CALENDAR${T}on"
  "backup.env${T}FLINT_OFFSITE_DIR${T}~/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg"
  "server.plist${T}PORT${T}8080"
  "server.plist${T}OLLAMA_HOST${T}http://127.0.0.1:11434"
  "server.plist${T}OLLAMA_MODEL${T}muse-glimmer:30b"
  "server.plist${T}OLLAMA_NUM_CTX${T}16384"
  "server.plist${T}FLINT_BUDGET_ANTHROPIC_DAILY_USD${T}5"
  "ollama.plist${T}OLLAMA_KEEP_ALIVE${T}24h"
)
for w in $want_set; do check "saved: ${${w#*$T}%%$T*}" 'grep -qxF "set${T}$w" "$snap"'; done
check "exactly those were saved, and nothing else" '[ "$(grep -c "^set${T}" "$snap")" = "${#want_set}" ]'
# Who may reach Flint over the tailnet is never saved: a rebuild reads it from the Tailscale sign-in.
check "the tailnet account is not saved, by value or by name" '! grep -q "TAILNET" "$snap" && ! grep -q "example.com" "$snap"'
# Which version was running, so a rebuild installs that one: the server's from its installer's line, the
# runtime's from its release folder when its line is not a commit.
check "the commits that were running are saved" 'grep -qxF "deployed${T}server${T}$sha_server" "$snap" && grep -qxF "deployed${T}runtime${T}$sha_runtime" "$snap" && [ "$(grep -c "^deployed${T}" "$snap")" = 2 ]'
check "a line that is not a commit is never saved" '! grep -q "not-a-commit" "$snap"'
# A value that looks like a secret is left out under ANY name, and only its name is recorded.
for n in "secrets.env${T}FLINT_TTS_VOICE" "secrets.env${T}PARITY_GOOGLE_MODEL" "secrets.env${T}FLINT_TIER_CODE" "server.plist${T}FLINT_STYLE_VARIANT" "ollama.plist${T}OLLAMA_HOST"; do
  check "left out, by name: ${n#*$T}" 'grep -qxF "skipped${T}$n" "$snap"'
done
check "an Ollama address that is not this Mac is never restored" '! grep -q "0.0.0.0" "$snap"'
# A name the manifest does not list is recorded by name and never saved.
check "an unlisted name is named" 'grep -qxF "unknown${T}secrets.env${T}SOMETHING_NEW" "$snap" && grep -qxF "unknown${T}server.plist${T}BRAND_NEW_SWITCH" "$snap"'
# Secrets under their own names are simply not there: no line at all.
for n in FLINT_TOKEN FLINT_DB_URL FLINT_DB_BACKUP_URL DATABASE_URL; do
  check "no line for $n" '! grep -q "$n" "$snap"'
done
for n in ANTHROPIC_API_KEY NEXUS_READ_TOKEN; do
  check "no value line for $n" '! grep -E "^(set|skipped|unknown)${T}.*$n" "$snap"'
done
for secret in "$hex" hunter2 hunter3 sk-ant tvly- postgresql:// 'touch'; do
  check "no secret value in the snapshot or on the screen ($secret)" '! grep -qF -- "$secret" "$snap" && [[ "$out" != *"$secret"* ]] && ! grep -qF -- "$secret" "$fx/err.log"'
done
check "a settings file is read as text, never run" '[ ! -e "$fx/pwned-by-env" ]'
check "connectors are recorded by name alone" 'grep -qxF "connector${T}web" "$snap" && grep -qxF "connector${T}runtime" "$snap" && [ "$(grep -c "^connector" "$snap")" = 2 ]'
# A key or sign-in from outside is never saved; that one was set is recorded by name, for the rebuild's closing list.
for n in "secrets.env${T}ANTHROPIC_API_KEY" "runtime.override.env${T}NEXUS_READ_TOKEN" "file${T}mcp.json"; do
  check "recorded as present, by name: ${n#*$T}" 'grep -qxF "present${T}$n" "$snap"'
done
check "nothing Flint makes for itself is recorded as present" '! grep -E "^present${T}.*(FLINT_TOKEN|FLINT_DB_|DATABASE_URL)" "$snap"'
check "every line is one of the six kinds" '! grep -vE "^(#|set${T}|skipped${T}|unknown${T}|present${T}|connector${T}|deployed${T})" "$snap"'

# ---- 4. --check: names only -----------------------------------------------------------------------
out=$(env -i HOME="$home" PATH=/usr/bin:/bin /bin/zsh "$script" --check 2>&1); st=$?
check "--check fails when a setting is not listed" '[ "$st" = 1 ]'
check "--check names the unlisted settings" '[[ "$out" == *"secrets.env  SOMETHING_NEW"* && "$out" == *"server.plist  BRAND_NEW_SWITCH"* ]]'
check "--check prints names, never values" '[[ "$out" != *"$hex"* && "$out" != *hunter* && "$out" != *"=on"* ]]'
grep -v '^SOMETHING_NEW=' "$data/secrets.env" > "$data/secrets.env.new" && mv "$data/secrets.env.new" "$data/secrets.env"
/usr/bin/plutil -remove EnvironmentVariables.BRAND_NEW_SWITCH "$agents/com.flint.server.plist"
out=$(env -i HOME="$home" PATH=/usr/bin:/bin /bin/zsh "$script" --check 2>&1); st=$?
check "--check passes when every name is listed" '[ "$st" = 0 ] && [[ "$out" == "Every setting on this Mac is listed in the settings manifest." ]]'
rm -f "$snap"
out=$(env -i HOME="$home" PATH=/usr/bin:/bin /bin/zsh "$script" --preview 2>&1); st=$?
check "--preview names what would be saved and what would not, and writes nothing" '[ "$st" = 0 ] && [ ! -e "$snap" ] && [[ "$out" == *"Flint would save 12 settings for a rebuild: "*"OLLAMA_MODEL"*"It would leave out 5 whose value has an unexpected shape or looks like a secret: "*"FLINT_TTS_VOICE"*"It would leave out 0 it does not know: none."*"ANTHROPIC_API_KEY"*"The connectors it would name: web, runtime."* ]]'
check "--preview prints names, never values" '[[ "$out" != *"$hex"* && "$out" != *hunter* && "$out" != *"muse-glimmer"* && "$out" != *"sk-ant"* && "$out" != *"example.com"* ]]'
out=$(env -i HOME="$home" PATH=/usr/bin:/bin /bin/zsh "$script" --everything 2>&1); st=$?
check "an unknown option is refused with a sentence" '[ "$st" = 1 ] && [[ "$out" == *"with no option"* ]]'
out=$(env -i HOME="$fx/nowhere" PATH=/usr/bin:/bin /bin/zsh "$script" 2>&1); st=$?
check "no data folder: it says so and saves nothing" '[ "$st" = 1 ] && [[ "$out" == *"data folder is not there"* ]] && [ ! -e "$fx/nowhere" ]'

# ---- 5. the nightly backup saves the snapshot before it archives ------------------------------------
mkdir -p "$fx/icloud"
env -i HOME="$home" PATH=/usr/bin:/bin FLINT_BACKUP_DIR="$fx/local" FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" FLINT_BACKUP_MANIFEST="$fx/offsite.txt" \
  FLINT_BACKUP_TS=20261012-0230 /bin/zsh "$here/../backup_flint.sh" >"$fx/backup.out" 2>"$fx/backup.err"
check "the nightly backup ran" '[ -f "$fx/local/flint-20261012-0230.tar.gz" ]'
check "and its archive carries the snapshot" 'tar -tzf "$fx/local/flint-20261012-0230.tar.gz" | grep -qx "./settings-snapshot.tsv"'
check "and said so in its log" 'grep -q "Flint saved 12 settings for a rebuild" "$fx/backup.out"'
# A snapshot that cannot be written never stops the backup.
chmod 500 "$data"; rm -f "$fx/local/flint-20261012-0231.tar.gz"
env -i HOME="$home" PATH=/usr/bin:/bin FLINT_BACKUP_DIR="$fx/local" FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" FLINT_BACKUP_MANIFEST="$fx/offsite.txt" \
  FLINT_BACKUP_TS=20261012-0231 /bin/zsh "$here/../backup_flint.sh" >"$fx/backup.out" 2>"$fx/backup.err"
chmod 700 "$data"
check "a snapshot that cannot be saved does not stop the backup" '[ -f "$fx/local/flint-20261012-0231.tar.gz" ]'

(( fail )) && exit 1
print "ok: the settings manifest holds names only, and the snapshot keeps ${#want_set} plain settings and no secret"
