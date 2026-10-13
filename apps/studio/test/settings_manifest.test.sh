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
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
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
# Local inference. The routing mode decides where your words go, so it is never taken from a backup: not the
# setting, and not the file Settings keeps it in. Nor is where the local model server is, its key, or the two
# switches that let "local" be another machine.
check "the routing mode is never restored, as a setting or as the file Settings keeps" 'manifest_lookup secrets.env FLINT_INFERENCE_MODE && [[ $REPLY == reenter && $REPLY2 == Routing-Mode ]] && manifest_lookup file inference.json && [[ $REPLY == reenter && $REPLY2 == Routing-Mode ]]'
for name in FLINT_LOCAL_BASE_URL FLINT_LOCAL_API_KEY FLINT_LOCAL_ALLOW_REMOTE FLINT_LOCAL_ALLOW_INSECURE_REMOTE; do
  check "$name is re-entered, never restored" 'manifest_lookup secrets.env $name && [[ $REPLY == reenter ]]'
done
# The wire and the kind of server are words, and may be put back: neither decides whether a model is taken for
# one on this Mac (the model server itself is asked, whatever they say: apps/server/src/policy.ts brainIsLocal).
for name in FLINT_LOCAL_PROVIDER FLINT_LOCAL_SERVER; do
  check "$name is a word a rebuild may put back" 'manifest_lookup secrets.env $name && [[ $REPLY == restore && $REPLY2 == word ]]'
done
# Voice. Which provider hears and which speaks are words, and may be put back: unset, speech goes to OpenAI, so a
# rebuild that dropped a more private choice would send replies out again. Where a local speech server is, and its
# key, are never taken from a backup. Each name's shape is the one the server takes for it (section 7).
for name in FLINT_STT_PROVIDER FLINT_TTS_PROVIDER FLINT_TTS_VOICE; do
  check "$name is a word a rebuild may put back" 'manifest_lookup secrets.env $name && [[ $REPLY == restore && $REPLY2 == word ]]'
done
for name in FLINT_LOCAL_STT_MODEL FLINT_LOCAL_TTS_MODEL FLINT_TTS_MODEL; do
  check "$name is a model's name a rebuild may put back" 'manifest_lookup secrets.env $name && [[ $REPLY == restore && $REPLY2 == model ]]'
done
check "a voice of the Mac's own is put back in the shape the Mac names one" 'manifest_lookup secrets.env FLINT_SAY_VOICE && [[ $REPLY == restore && $REPLY2 == sayvoice ]]'
check "a voice on a local speech server is put back in the shape the server takes" 'manifest_lookup secrets.env FLINT_LOCAL_TTS_VOICE && [[ $REPLY == restore && $REPLY2 == speechname ]]'
for name in FLINT_LOCAL_STT_BASE_URL FLINT_LOCAL_TTS_BASE_URL FLINT_LOCAL_VOICE_API_KEY; do
  check "$name is re-entered, never restored" 'manifest_lookup secrets.env $name && [[ $REPLY == reenter && $REPLY2 == Local-Speech-Server ]]'
done
check "and the server does not take either word for where a model runs" 'grep -q "return said === .ollama. ? listed(brain.baseURL, brain.model) : said === .other.;" "$here/../../server/src/policy.ts"'
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
  'homepath|~/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups/pg' \
  'sayvoice|Samantha' 'sayvoice|Eddy (English (US))' 'sayvoice|Bad News' 'sayvoice|Anna-Marie' 'sayvoice|Zoe (Premium)' \
  'speechname|alloy' 'speechname|af_heart' 'speechname|en/kokoro:af_heart' 'speechname|voices/en_US-lessac-medium.onnx'; do
  check "accepts ${row%%|*}: ${row#*|}" 'ok "${row%%|*}" "${row#*|}"'
done
long=$(printf 'a%.0s' {1..40})
for row in \
  'onoff|maybe' 'number|12abc' 'port|8' 'model|two words' 'model|a;rm -rf' 'model|$(id)' 'spec|nocolon' 'word|a/b' \
  'loopback|http://example.com:11434' 'loopback|https://127.0.0.1:11434' 'loopback|http://user:pw@127.0.0.1:1234' \
  'bindaddr|0.0.0.0:11434' 'bindaddr|192.168.1.5:11434' 'email|not-an-email' 'zone|America/Chi cago' \
  'homepath|/etc/passwd' 'homepath|~/../../etc' 'homepath|~/a/../b' 'nosuchshape|x' \
  "model|sk-ant-api03-short" "model|tvly-abc" "model|ghp_abcdef" "word|$long" "model|$long" "model|AKIAABCDEFGH" \
  'model|eyJhbGciOiJIUzI1NiJ9' 'word|age1qqqq' 'number|' \
  'sayvoice|-o /tmp/x' 'sayvoice|--help' 'sayvoice|Samantha; rm -rf' 'sayvoice|Sam$(id)' 'sayvoice| Samantha' 'sayvoice|1984' "sayvoice|A$long" 'sayvoice|' \
  'speechname|two words' 'speechname|-v' 'speechname|a;rm' 'speechname|$(id)' 'speechname|../x' "speechname|$long$long$long" 'speechname|'; do
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
FLINT_INFERENCE_MODE=cloud
FLINT_LOCAL_PROVIDER=openai
FLINT_LOCAL_SERVER=openai
FLINT_LOCAL_BASE_URL=http://gpu-box.example.com:8080/v1
FLINT_LOCAL_ALLOW_REMOTE=1
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
check "it says what it did, in one sentence" '[[ "$out" == "Flint saved 14 settings for a rebuild. It left out 7 it does not know or whose value looks like a secret." ]]'
check "the snapshot is 0600" '[ "$(stat -f %Lp "$snap")" = 600 ]'
check "nothing was left half-written" '[ ! -e "$snap.partial" ]'
T=$'\t'
want_set=(
  "secrets.env${T}FLINT_RUNTIME_URL${T}http://[::1]:8090"
  "secrets.env${T}FLINT_TIER_HARD${T}openai:gpt-5"
  "secrets.env${T}FLINT_WORLD_NOW${T}1"
  "secrets.env${T}FLINT_LOCAL_PROVIDER${T}openai"
  "secrets.env${T}FLINT_LOCAL_SERVER${T}openai"
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
# The routing mode, where the local model server is, and the switch that lets it be another machine: recorded by
# name alone, so a rebuild can say what it did about each, and never by value. No backup carries a mode to restore.
for n in FLINT_INFERENCE_MODE FLINT_LOCAL_BASE_URL FLINT_LOCAL_ALLOW_REMOTE; do
  check "recorded as present, by name alone: $n" 'grep -qxF "present${T}secrets.env${T}$n" "$snap" && ! grep -E "^(set|skipped|unknown)${T}.*$n" "$snap"'
done
check "no mode and no model server address is in the snapshot" '! grep -q "cloud$" "$snap" && ! grep -q "gpu-box" "$snap"'
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
check "--preview names what would be saved and what would not, and writes nothing" '[ "$st" = 0 ] && [ ! -e "$snap" ] && [[ "$out" == *"Flint would save 14 settings for a rebuild: "*"OLLAMA_MODEL"*"It would leave out 5 whose value has an unexpected shape or looks like a secret: "*"FLINT_TTS_VOICE"*"It would leave out 0 it does not know: none."*"ANTHROPIC_API_KEY"*"The connectors it would name: web, runtime."* ]]'
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
check "and said so in its log" 'grep -q "Flint saved 14 settings for a rebuild" "$fx/backup.out"'
# A snapshot that cannot be written never stops the backup.
chmod 500 "$data"; rm -f "$fx/local/flint-20261012-0231.tar.gz"
env -i HOME="$home" PATH=/usr/bin:/bin FLINT_BACKUP_DIR="$fx/local" FLINT_BACKUP_OFFSITE="$fx/icloud/FlintBackups" FLINT_BACKUP_MANIFEST="$fx/offsite.txt" \
  FLINT_BACKUP_TS=20261012-0231 /bin/zsh "$here/../backup_flint.sh" >"$fx/backup.out" 2>"$fx/backup.err"
chmod 700 "$data"
check "a snapshot that cannot be saved does not stop the backup" '[ -f "$fx/local/flint-20261012-0231.tar.gz" ]'

# ---- 6. everything a rebuild leaves to the owner has a sentence saying what to do ----------------------
# A setting or file marked `reenter` is named at the end of a rebuild by its detail word. Each of those
# words must have a sentence in rebuild.sh, or the owner would be told nothing about it.
details=(${(u)${(f)"$(awk '$3 == "reenter" { print $4 }' "$here/../settings.manifest")"}})
check "the manifest has things a rebuild leaves to the owner" '(( ${#details} >= 8 ))'
for d in $details; do
  check "a rebuild says what to do about: $d" 'grep -qE "^  $d +\"[A-Z][^\"]*\\.\"$" "$here/../rebuild.sh"'
done

# The mode has one sentence, said on a line of its own whatever the backup held, and the rebuild writes Local for
# the new Mac itself (the rehearsal test runs it: rebuild_rehearse.test.sh).
check "the mode's sentence is the one sentence" 'grep -qxF "  Routing-Mode   \"Flint is in Local mode after a rebuild. Choose another mode in Settings if you want one.\"" "$here/../rebuild.sh"'
check "it is said always, not only when a backup held a mode" 'grep -qxF "say \"\${WHERE_TO[Routing-Mode]}\"" "$here/../rebuild.sh" && grep -qxF "outside=(\${outside:#Routing-Mode})" "$here/../rebuild.sh"'
check "the rebuild writes Local mode for the new Mac, and no restored line can name another" 'grep -qxF "    print -r -- \"FLINT_INFERENCE_MODE=local\"" "$here/../rebuild.sh" && grep -qF "[[ \$kv == (FLINT_RUNTIME_URL|FLINT_INFERENCE_MODE)=* ]] || print -r -- \"\$kv\"" "$here/../rebuild.sh"'

# ---- 7. voice settings: what the server uses is what a rebuild puts back ------------------------------------
# The review's L6. A voice of the Mac's own ("Eddy (English (US))") and a local voice with ':' or '/' in its name
# were listed as one plain word, so the snapshot left them out and a rebuilt Mac spoke with another voice. A
# second small Mac, with only voice settings: what the snapshot saves, and what a rebuild would take back.
home2="$fx/home2"; data2="$home2/.flint"; mkdir -p "$data2"
cat > "$data2/secrets.env" <<ENV
FLINT_TTS_PROVIDER=say
FLINT_SAY_VOICE=Eddy (English (US))
FLINT_STT_PROVIDER=local
FLINT_LOCAL_STT_MODEL=Systran/faster-whisper-small.en
FLINT_LOCAL_TTS_MODEL=kokoro
FLINT_LOCAL_TTS_VOICE=voices/en:af_heart
FLINT_TTS_MODEL=tts-1-hd
FLINT_TTS_VOICE=nova
FLINT_LOCAL_STT_BASE_URL=http://127.0.0.1:8178/v1
FLINT_LOCAL_TTS_BASE_URL=http://127.0.0.1:8880/v1
FLINT_LOCAL_VOICE_API_KEY=voice-key-not-a-real-one
ENV
chmod 600 "$data2/secrets.env"
out=$(env -i HOME="$home2" PATH=/usr/bin:/bin /bin/zsh "$script" 2>"$fx/err2.log"); st=$?
snap2="$data2/settings-snapshot.tsv"
check "the snapshot of the voice settings succeeds" '[ "$st" = 0 ] && [[ "$out" == "Flint saved 8 settings for a rebuild."* ]]'
voice_set=(
  "FLINT_TTS_PROVIDER${T}say"
  "FLINT_SAY_VOICE${T}Eddy (English (US))"
  "FLINT_STT_PROVIDER${T}local"
  "FLINT_LOCAL_STT_MODEL${T}Systran/faster-whisper-small.en"
  "FLINT_LOCAL_TTS_MODEL${T}kokoro"
  "FLINT_LOCAL_TTS_VOICE${T}voices/en:af_heart"
  "FLINT_TTS_MODEL${T}tts-1-hd"
  "FLINT_TTS_VOICE${T}nova"
)
for w in $voice_set; do check "saved as it is set: ${w%%$T*}" 'grep -qxF "set${T}secrets.env${T}$w" "$snap2"'; done
check "exactly those were saved" '[ "$(grep -c "^set${T}" "$snap2")" = "${#voice_set}" ]'
check "where the speech server is, and its key, are in the snapshot by name alone" '! grep -q "8178\|8880\|voice-key" "$snap2" && grep -qxF "present${T}secrets.env${T}FLINT_LOCAL_STT_BASE_URL" "$snap2" && grep -qxF "present${T}secrets.env${T}FLINT_LOCAL_TTS_BASE_URL" "$snap2" && grep -qxF "present${T}secrets.env${T}FLINT_LOCAL_VOICE_API_KEY" "$snap2"'
# What a rebuild does with each saved line (rebuild.sh reads the snapshot with these same two checks, then leaves
# a MODEL whose name has a slash in it for the owner to check).
put_back=()
while IFS=$'\t' read -r kind where name value extra; do
  [[ $kind == set ]] || continue
  manifest_lookup "$where" "$name" && [[ $REPLY == restore ]] && flint_value_ok "$REPLY2" "$value" || continue
  [[ $REPLY2 == model && $value == */* ]] && continue
  put_back+=("$name=$value")
done < "$snap2"
has() { (( ${put_back[(Ie)$1]} )); }   # exactly this line, brackets and all
check "a rebuild puts the Mac's voice back as the Mac names it, and the local voice with its ':' and '/'" 'has "FLINT_SAY_VOICE=Eddy (English (US))" && has "FLINT_LOCAL_TTS_VOICE=voices/en:af_heart"'
check "and the two provider words, the speech model and OpenAI's model and voice" 'has FLINT_TTS_PROVIDER=say && has FLINT_STT_PROVIDER=local && has FLINT_LOCAL_TTS_MODEL=kokoro && has FLINT_TTS_MODEL=tts-1-hd && has FLINT_TTS_VOICE=nova'
check "a speech model named with a slash is left for the owner to check, like any other model" '(( ! ${put_back[(I)FLINT_LOCAL_STT_MODEL=*]} )) && [ "${#put_back}" = 7 ]'
# The shapes here are the server's own: the same patterns, character for character.
cfg="$here/../../server/src/inference-config.ts"
check "the Mac's voice has the shape the server takes for it" 'grep -qF "export const SAY_VOICE_RE = /${FLINT_PATTERNS[sayvoice]}/;" "$cfg"'
check "a speech server's voice and model have the shape the server takes for them" 'grep -qF "const SPEECH_NAME_RE = /${FLINT_PATTERNS[speechname]}/;" "$cfg"'
check "and so has OpenAI's voice" 'grep -qF "const SPEECH_WORD_RE = /${FLINT_PATTERNS[word]}/;" "$cfg"'
check "a model's name and a speech name are one pattern, so the server takes what a rebuild puts back" '[[ ${FLINT_PATTERNS[model]} == ${FLINT_PATTERNS[speechname]} ]]'

# The review's L7. The sentence a rebuild says about a local speech server has to be true whichever of the two it
# was: one that only turned speech into text (replies were spoken by OpenAI or by the Mac all along), one that
# only spoke, or both. So it says what THAT server did, and promises nothing about speech it never made.
speech_line="$(grep -E '^  Local-Speech-Server +"' "$here/../rebuild.sh")"
check "the speech server's sentence says what that server did is done without it" '[[ $speech_line == *"what that server did is done without it: transcription runs on this Mac, and replies it spoke are spoken by each device'"'"'s own voice."* ]]'
check "and does not say every device speaks with its own voice, which is false when OpenAI or the Mac speaks" '[[ $speech_line != *"and each device speaks with its own voice"* ]]'

(( fail )) && exit 1
print "ok: the settings manifest holds names only, and the snapshot keeps ${#want_set} plain settings and no secret"
