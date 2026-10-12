#!/bin/zsh
# The LaunchAgents the repo could not make before (the server, the local model,
# Tailscale), rendered from their templates and linted, and the list of every
# Flint agent and where its file comes from. Run: zsh apps/studio/test/plist_templates.test.sh
#
# What must hold:
#  - each template renders to a valid property list (plutil -lint), 0600, with
#    this Mac's paths in it and no placeholder left;
#  - a value that could break out of the XML, or a placeholder with no value, is refused;
#  - no template carries a secret, and each keeps its service on this Mac only;
#  - every agent in agents.manifest names a source that exists in the repo.
set -u
here=${0:A:h}
repo=${here:h:h:h}
source "$here/../recovery_lib.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }
get() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null; }
T="$here/../templates"
home="$fx/Users/someone"

# ---- the server ---------------------------------------------------------------------------
out="$fx/com.flint.server.plist"
check "the server template renders" 'render_template "$T/com.flint.server.plist.tmpl" "$out" NODE=/opt/node/bin/node NODE_DIR=/opt/node/bin HOME="$home" PORT=8080'
check "it is a valid property list" '/usr/bin/plutil -lint "$out" >/dev/null'
check "it is 0600" '[ "$(stat -f %Lp "$out")" = 600 ]'
check "no placeholder is left" '! grep -q "__" "$out"'
check "its label" '[ "$(get "$out" Label)" = com.flint.server ]'
check "it runs this Mac's node on the bundle in ~/.flint" '[ "$(get "$out" ProgramArguments.0)" = /opt/node/bin/node ] && [ "$(get "$out" ProgramArguments.1)" = "$home/.flint/server.mjs" ]'
check "it is kept running" '[ "$(get "$out" KeepAlive)" = true ] && [ "$(get "$out" RunAtLoad)" = true ]'
check "its port, console and connector list" '[ "$(get "$out" EnvironmentVariables.PORT)" = 8080 ] && [ "$(get "$out" EnvironmentVariables.CONSOLE_PATH)" = "$home/.flint/console.html" ] && [ "$(get "$out" EnvironmentVariables.MCP_CONFIG)" = "$home/.flint/mcp.json" ]'
check "node is first on its PATH" '[[ "$(get "$out" EnvironmentVariables.PATH)" == /opt/node/bin:* ]]'
check "the local model is asked on this Mac only" '[ "$(get "$out" EnvironmentVariables.OLLAMA_HOST)" = http://127.0.0.1:11434 ]'
check "it logs into ~/.flint" '[ "$(get "$out" StandardErrorPath)" = "$home/.flint/server.err.log" ]'
# What the runtime's installer reads back out of it (apps/runtime/install-runtime.sh).
plist_set_env "$out" OLLAMA_MODEL 'muse-glimmer:30b'; plist_set_env "$out" OLLAMA_NUM_CTX 16384; plist_set_env "$out" FLINT_BUDGET_OPENAI_DAILY_USD 2.5
check "a restored setting lands in it and it stays valid" '[ "$(get "$out" EnvironmentVariables.OLLAMA_MODEL)" = "muse-glimmer:30b" ] && /usr/bin/plutil -lint "$out" >/dev/null'
check "the runtime installer's reader finds the spend caps" '/usr/bin/plutil -p "$out" | sed -nE "s/^ *\"(FLINT_BUDGET_[A-Z]+_(DAILY|MONTHLY)_USD)\" => \"([0-9.]+)\"\$/\1=\3/p" | grep -qx "FLINT_BUDGET_OPENAI_DAILY_USD=2.5"'
check "a setting name that is not a name is refused" '! plist_set_env "$out" "BAD NAME" x 2>/dev/null && ! plist_set_env "$out" "A.B" x 2>/dev/null'

# ---- the local model --------------------------------------------------------------------------
out="$fx/com.flint.ollama.plist"
check "the ollama template renders" 'render_template "$T/com.flint.ollama.plist.tmpl" "$out" OLLAMA=/opt/homebrew/bin/ollama HOME="$home"'
check "ollama: valid, 0600, no placeholder" '/usr/bin/plutil -lint "$out" >/dev/null && [ "$(stat -f %Lp "$out")" = 600 ] && ! grep -q "__" "$out"'
check "ollama: serve, kept running, from the home folder" '[ "$(get "$out" ProgramArguments.0)" = /opt/homebrew/bin/ollama ] && [ "$(get "$out" ProgramArguments.1)" = serve ] && [ "$(get "$out" KeepAlive)" = true ] && [ "$(get "$out" WorkingDirectory)" = "$home" ]'
check "ollama: listens on this Mac only" '[ "$(get "$out" EnvironmentVariables.OLLAMA_HOST)" = 127.0.0.1:11434 ]'

# ---- Tailscale ------------------------------------------------------------------------------------
out="$fx/com.flint.tailscaled.plist"
check "the tailscaled template renders" 'render_template "$T/com.flint.tailscaled.plist.tmpl" "$out" TAILSCALED=/opt/homebrew/opt/tailscale/bin/tailscaled HOME="$home"'
check "tailscaled: valid, 0600, no placeholder" '/usr/bin/plutil -lint "$out" >/dev/null && [ "$(stat -f %Lp "$out")" = 600 ] && ! grep -q "__" "$out"'
check "tailscaled: userspace, with its socket and state in ~/.flint" '[ "$(get "$out" ProgramArguments.1)" = --tun=userspace-networking ] && [ "$(get "$out" ProgramArguments.2)" = "--socket=$home/.flint/tailscaled.sock" ] && [ "$(get "$out" ProgramArguments.3)" = "--state=$home/.flint/tailscaled.state" ] && [ "$(get "$out" ProgramArguments.4)" = "--statedir=$home/.flint/tailscale" ]'
check "tailscaled: the socket is the one finish-tailscale.sh talks to" 'grep -q "TS_SOCK=\"\$HOME/.flint/tailscaled.sock\"" "$here/../finish-tailscale.sh"'

# ---- refusals -----------------------------------------------------------------------------------------
r() { render_template "$T/com.flint.ollama.plist.tmpl" "$fx/refused.plist" "$@" 2>"$fx/r.err"; }
check "a value with < is refused" '! r OLLAMA="/bin/x</string><string>evil" HOME="$home" && grep -q "cannot go into a LaunchAgent file safely" "$fx/r.err"'
check "a value with & is refused" '! r OLLAMA="/bin/a&b" HOME="$home"'
check "a value with a quote is refused" '! r OLLAMA="/bin/a\"b" HOME="$home" && ! r OLLAMA="/bin/a'"'"'b" HOME="$home"'
check "a value with a line break is refused" '! r OLLAMA="/bin/a"$'"'"'\n'"'"'"b" HOME="$home"'
check "a value that is itself a placeholder is refused" '! r OLLAMA=__HOME__ HOME="$home"'
check "an empty value is refused" '! r OLLAMA= HOME="$home"'
check "a placeholder with no value is refused, by name" '! r HOME="$home" && grep -q "needs __OLLAMA__" "$fx/r.err"'
check "a missing template is refused" '! render_template "$T/nope.tmpl" "$fx/refused.plist" A=b 2>/dev/null'
check "a refusal writes nothing" '[ ! -e "$fx/refused.plist" ] && [ ! -e "$fx/refused.plist.partial" ]'

# ---- no secrets, loopback only ---------------------------------------------------------------------------
for t in "$T"/*.tmpl; do
  check "${t:t} is itself a valid property list" '/usr/bin/plutil -lint "$t" >/dev/null'
  check "${t:t} names no secret" '! grep -E "<key>[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*</key>" "$t"'
  check "${t:t} holds no address but this Mac's" '! grep -E "0\.0\.0\.0|ts\.net|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" "$t" | grep -v "127\.0\.0\.1"'
  check "${t:t} holds no home folder of its own" '! grep -q "/Users/" "$t"'
done

# ---- every agent, and where its file comes from --------------------------------------------------------------
typeset -A seen
n=0
while read -r label how source load rest; do
  [[ -z $label || $label == \#* ]] && continue
  n=$(( n + 1 ))
  check "agents.manifest: $label is a well-formed line" '[[ $label =~ "^com\.flint\.[a-z-]+$" && $how =~ "^(template|file|installer|retired|local)$" && $load =~ "^(load|last|installer|no)$" && -z $rest ]]'
  check "agents.manifest: $label is listed once" '[[ -z ${seen[$label]:-} ]]'
  seen[$label]=1
  case $how in
    template|file|installer) check "agents.manifest: the source of $label exists" '[ -f "$repo/$source" ]' ;;
    *) check "agents.manifest: $label has no source and is never loaded" '[[ $source == - && $load == no ]]' ;;
  esac
  [[ $how == template ]] && check "agents.manifest: $label's template is one of the three" '[[ $source == apps/studio/templates/$label.plist.tmpl ]]'
  [[ $how == file ]] && check "agents.manifest: $label's file carries its label" 'grep -q "<string>$label</string>" "$repo/$source"'
  [[ $how == installer ]] && check "agents.manifest: $label's installer names it" 'grep -q "$label" "$repo/$source"'
done < "$AGENTS_MANIFEST"
check "agents.manifest lists the agents" '(( n >= 12 ))'
for label in com.flint.server com.flint.ollama com.flint.tailscaled; do
  check "$label is made from a template" '[[ -n ${seen[$label]:-} ]] && [ -f "$T/$label.plist.tmpl" ]'
done
check "exactly one agent is loaded last: the one that starts deploys" '[ "$(grep -vE "^#|^$" "$AGENTS_MANIFEST" | awk "\$4 == \"last\" { print \$1 }")" = com.flint.deploy ]'
# Every LaunchAgent file kept in the repo is listed, so none is forgotten by a rebuild.
for f in "$repo"/apps/*/com.flint.*.plist(N) "$repo"/apps/*/*/com.flint.*.plist(N); do
  check "the repo's ${f:t} is in agents.manifest" '[[ -n ${seen[${f:t:r}]:-} ]]'
done

(( fail )) && exit 1
print "ok: three templates render and lint, unsafe values are refused, and $n agents each name where their file comes from"
