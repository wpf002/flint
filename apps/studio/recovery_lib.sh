#!/bin/zsh
# Shared by the recovery scripts (rebuild.sh, settings_manifest.sh,
# restore_file.sh, rollback.sh). Sourced, never run.
#
# What is here:
#   - say / refuse: every line the owner reads is one complete sentence;
#   - the settings manifest (settings.manifest): which settings exist, by name,
#     and what a rebuild does with each. It holds no values;
#   - the two checks a setting's VALUE must pass before it is saved for a
#     rebuild or put back by one: it matches the pattern its name is listed
#     with, and it does not look like a secret;
#   - reading setting names and values out of env files and LaunchAgent plists
#     without ever running them as code;
#   - rendering a LaunchAgent from a template.
#
# Nothing here prints a setting's value.

RECOVERY_DIR="${${(%):-%x}:A:h}"
SETTINGS_MANIFEST="${FLINT_SETTINGS_MANIFEST:-$RECOVERY_DIR/settings.manifest}"
AGENTS_MANIFEST="${FLINT_AGENTS_MANIFEST:-$RECOVERY_DIR/agents.manifest}"

say() { print -r -- "$*"; }
refuse() { print -r -- "$*" >&2; exit 1; }

# need_tool <program> <sentence saying how to get it>: its full path in REPLY, or a refusal.
# Looked for on PATH, then where Homebrew puts things (launchd's PATH has no Homebrew).
# FLINT_TOOL_PATHS, when set, replaces that second list (the tests use it to hide a tool).
need_tool() {
  emulate -L zsh
  local found dir
  found="$(whence -p -- "$1" 2>/dev/null)" || true
  if [[ -z $found ]]; then
    for dir in ${(s.:.)${FLINT_TOOL_PATHS-/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/tailscale/bin:/usr/local/bin}}; do
      [[ -x $dir/$1 && ! -d $dir/$1 ]] && { found=$dir/$1; break; }
    done
  fi
  [[ -n $found && -x $found ]] || refuse "$2"
  REPLY=$found
}

# ---- values ---------------------------------------------------------------------

# 0 when a value looks like a secret: a long unbroken token, a known key prefix,
# a URL carrying a password, or the words that introduce one. Such a value is
# never saved for a rebuild, whatever name it sits under.
flint_secret_shaped() {
  emulate -L zsh
  local v=$1
  [[ $v =~ '[A-Za-z0-9_+=-]{32,}' ]] && return 0
  [[ $v =~ '(^|[^A-Za-z0-9])(sk-|tvly-|pplx-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abprs]-|AKIA|AIza|age1|AGE-SECRET-KEY-|eyJ[A-Za-z0-9_-]{8,})' ]] && return 0
  [[ $v == *'-----BEGIN'* ]] && return 0
  [[ $v =~ '://[^/@[:space:]]*:[^/@[:space:]]*@' ]] && return 0
  [[ ${v:l} =~ '(password|passwd|secret|token|bearer|apikey|api_key)[=: ]' ]] && return 0
  return 1
}

# The shapes a restorable setting's value may take, by name.
typeset -gA FLINT_PATTERNS
FLINT_PATTERNS=(
  onoff     '^(on|off|1|0|true|false|yes|no)$'
  number    '^[0-9]{1,9}(\.[0-9]{1,6})?$'
  port      '^[0-9]{2,5}$'
  model     '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'
  spec      '^[a-z][a-z0-9_-]{0,19}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'
  word      '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'
  duration  '^-?[0-9]{1,6}(ms|s|m|h)?$'
  loopback  '^http://(\[::1\]|127\.0\.0\.1|localhost):[0-9]{2,5}$'
  bindaddr  '^(http://)?(\[::1\]|127\.0\.0\.1|localhost)(:[0-9]{2,5})?$'
  email     '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$'
  zone      '^[A-Za-z_]{1,20}(/[A-Za-z_+-]{1,30}){0,2}$'
  place     '^[A-Za-z][A-Za-z ,.-]{0,59}$'
  homepath  '^~(/[A-Za-z0-9 ._~+-]{1,80}){1,12}$'
)

# flint_value_ok <pattern name> <value>: the value has that shape and is not secret-shaped.
flint_value_ok() {
  emulate -L zsh
  local re=${FLINT_PATTERNS[$1]:-}
  [[ -n $re ]] || return 1
  [[ $2 =~ $re ]] || return 1
  [[ $2 == *$'\n'* || $2 == *$'\t'* || $2 == *$'\r'* ]] && return 1
  [[ $1 == homepath && ( $2 == *'/../'* || $2 == *'/..' ) ]] && return 1
  flint_secret_shaped "$2" && return 1
  return 0
}

# ---- the settings manifest --------------------------------------------------------

# Lines: <where> <NAME> <class> <detail>. Loaded into MF_CLASS and MF_DETAIL,
# keyed "<where>/<NAME>". A name listed for secrets.env or server.plist counts in
# both: the server reads its settings from either.
typeset -gA MF_CLASS MF_DETAIL
manifest_load() {
  emulate -L zsh
  local file=${1:-$SETTINGS_MANIFEST} where name class detail rest key n=0
  MF_CLASS=() MF_DETAIL=()
  [[ -r $file ]] || { print -r -- "The settings manifest is missing." >&2; return 1; }
  while read -r where name class detail rest; do
    [[ -z $where || $where == \#* ]] && continue
    n=$(( n + 1 ))
    if [[ ! $where =~ '^[a-z][a-z0-9.:-]{0,60}$' || ! $name =~ '^[A-Za-z0-9._*/-]{1,80}$' || ! $class =~ '^(restore|generate|reenter|derive|retired)$' || -z $detail || -n $rest ]]; then
      print -r -- "The settings manifest has a line Flint cannot read (entry $n)." >&2; return 1
    fi
    key="$where/$name"
    if [[ -n ${MF_CLASS[$key]:-} ]]; then
      print -r -- "The settings manifest lists $name twice for $where." >&2; return 1
    fi
    if [[ $class == restore ]]; then
      if [[ -z ${FLINT_PATTERNS[$detail]:-} ]]; then
        print -r -- "The settings manifest gives $name a value shape Flint does not know." >&2; return 1
      fi
      # A name that says it is a secret is never restorable, whatever the line claims.
      if [[ $name =~ '(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)' ]]; then
        print -r -- "The settings manifest marks $name as restorable, and its name says it is a secret." >&2; return 1
      fi
      if [[ $name == *_URL && $detail != loopback ]]; then
        print -r -- "The settings manifest marks $name as restorable, and a URL is restorable only when it names this Mac." >&2; return 1
      fi
    fi
    MF_CLASS[$key]=$class
    MF_DETAIL[$key]=$detail
  done < "$file"
  (( n > 0 )) || { print -r -- "The settings manifest is empty." >&2; return 1; }
}

# manifest_lookup <where> <NAME>: class in REPLY and detail in REPLY2; 1 when the name is not listed.
manifest_lookup() {
  emulate -L zsh
  local where=$1 name=$2 w key
  local -a places
  case $where in
    secrets.env|server.plist) places=(secrets.env server.plist) ;;
    *) places=($where) ;;
  esac
  for w in $places; do
    key="$w/$name"
    if [[ -n ${MF_CLASS[$key]:-} ]]; then
      REPLY=${MF_CLASS[$key]} REPLY2=${MF_DETAIL[$key]}
      return 0
    fi
  done
  return 1
}

# ---- reading settings without running them ------------------------------------------

# env_names <file>: the setting names in an env file, one per line.
env_names() {
  emulate -L zsh
  local line
  [[ -r $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ '^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=' ]] && print -r -- "$match[2]"
  done < "$1"
  return 0
}

# env_value <file> <NAME>: the last value given to NAME, quotes stripped, in REPLY; 1 when it is not set.
env_value() {
  emulate -L zsh
  setopt extended_glob
  local line v found=1
  REPLY=
  [[ -r $1 ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ '^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$' && $match[2] == $2 ]]; then
      v=$match[3]
      v=${v%%[[:space:]]#}
      if [[ $v == \"*\" || $v == \'*\' ]]; then v=${v[2,-2]}; fi
      REPLY=$v found=0
    fi
  done < "$1"
  return $found
}

# plist_env_names <plist>: the names in a LaunchAgent's EnvironmentVariables, one per line.
plist_env_names() {
  emulate -L zsh
  local line
  [[ -r $1 ]] || return 0
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables' "$1" 2>/dev/null | while IFS= read -r line; do
    [[ $line =~ '^    ([A-Za-z_][A-Za-z0-9_]*) = ' ]] && print -r -- "$match[1]"
  done
  return 0
}

# plist_env_value <plist> <NAME>: its value in REPLY; 1 when it is not set.
plist_env_value() {
  emulate -L zsh
  REPLY=
  [[ $2 =~ '^[A-Za-z_][A-Za-z0-9_]*$' ]] || return 1
  REPLY="$(/usr/bin/plutil -extract "EnvironmentVariables.$2" raw -o - "$1" 2>/dev/null)" || { REPLY=; return 1; }
  return 0
}

# plist_set_env <plist> <NAME> <value>: set one environment variable in a LaunchAgent file.
plist_set_env() {
  emulate -L zsh
  [[ $2 =~ '^[A-Za-z_][A-Za-z0-9_]*$' ]] || return 1
  [[ $3 == *$'\n'* ]] && return 1
  /usr/bin/plutil -replace "EnvironmentVariables.$2" -string "$3" "$1"
}

# ---- LaunchAgent templates --------------------------------------------------------------

# render_template <template> <out> NAME=value ...: every __NAME__ in the template
# becomes its value. Refused when a value could break out of the XML it lands
# in, when the template names something no value was given for, or when the
# result is not a valid property list. The file is written 0600, whole.
render_template() {
  emulate -L zsh
  local tmpl=$1 out=$2 pair name value text
  shift 2
  [[ -r $tmpl ]] || { print -r -- "The template ${tmpl:t} is missing." >&2; return 1; }
  text="$(<"$tmpl")"
  for pair in "$@"; do
    name=${pair%%=*} value=${pair#*=}
    if [[ ! $name =~ '^[A-Z][A-Z0-9_]*$' ]]; then
      print -r -- "The template ${tmpl:t} was given a name Flint cannot use." >&2; return 1
    fi
    if [[ -z $value || $value == *[\<\>\&\"\'\\]* || $value == *$'\n'* || $value == *$'\t'* || $value == *__* ]]; then
      print -r -- "The value for $name cannot go into a LaunchAgent file safely." >&2; return 1
    fi
    text=${text//__${name}__/$value}
  done
  if [[ $text =~ '__[A-Z][A-Z0-9_]*__' ]]; then
    print -r -- "The template ${tmpl:t} needs $MATCH, and no value was given for it." >&2; return 1
  fi
  ( umask 077; print -r -- "$text" > "$out.partial" ) || return 1
  if ! /usr/bin/plutil -lint "$out.partial" >/dev/null 2>&1; then
    rm -f "$out.partial"
    print -r -- "The LaunchAgent file made from ${tmpl:t} is not valid." >&2; return 1
  fi
  chmod 600 "$out.partial" && mv -f "$out.partial" "$out"
}
