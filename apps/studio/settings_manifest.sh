#!/bin/zsh
# The settings a rebuild puts back.
#
# The offsite backup leaves out every secret, which means it leaves out every
# settings file too, and with them your switches (which model, triage on or off,
# the spend caps). This saves the ones that are NOT secret, so a rebuilt Flint
# comes back set up the way you had it, with new keys and none of the old ones.
#
#   settings_manifest.sh            save ~/.flint/settings-snapshot.tsv (0600). The nightly
#                                   backup (backup_flint.sh) runs this before it archives.
#   settings_manifest.sh --check    name every setting on this Mac that
#                                   settings.manifest does not list. Names only.
#   settings_manifest.sh --preview  say which settings would be saved and which
#                                   left out, by name. Nothing is written.
#
# A setting is saved only if settings.manifest lists its name as `restore`, its
# value has the shape that name is listed with, and the value does not look like
# a secret. Everything else is left out, and the snapshot records the name alone.
# For a key or sign-in from outside it records only that one was set, so a
# rebuild can name the accounts the old Mac could reach.
# Env files and LaunchAgent files are read as text; nothing in them is ever run.
set -u
here=${0:A:h}
source "$here/recovery_lib.sh"

DATA="${FLINT_DATA:-$HOME/.flint}"
AGENTS="${FLINT_AGENTS:-$HOME/Library/LaunchAgents}"
SNAPSHOT="$DATA/settings-snapshot.tsv"
mode=write
case "${1:-}" in
  '') ;;
  --check) mode=check ;;
  --preview) mode=preview ;;
  *) refuse "Run this with no option to save the settings, with --check to compare the names, or with --preview to see what would be saved." ;;
esac

manifest_load || exit 1

typeset -a saved skipped unknown connectors present
home_tilde() { # a path under this home folder, written with ~ so it fits another one
  emulate -L zsh
  if [[ $1 == $HOME/* ]]; then REPLY="~${1#$HOME}"; else REPLY=$1; fi
}

# consider <where> <NAME> <value-getter> <source file>
consider() {
  emulate -L zsh
  local where=$1 name=$2 getter=$3 file=$4 value
  if ! manifest_lookup "$where" "$name"; then
    unknown+=("$where"$'\t'"$name")
    return 0
  fi
  if [[ $REPLY == reenter ]]; then
    # A key or sign-in from outside: never saved. That it was set is recorded, by name
    # alone, so a rebuild can say which accounts the old Mac could reach.
    "$getter" "$file" "$name" && [[ -n $REPLY ]] && present+=("$where"$'\t'"$name")
    return 0
  fi
  [[ $REPLY == restore ]] || return 0
  local shape=$REPLY2
  "$getter" "$file" "$name" || return 0
  value=$REPLY
  if [[ $shape == homepath ]]; then home_tilde "$value"; value=$REPLY; fi
  if flint_value_ok "$shape" "$value"; then
    saved+=("$where"$'\t'"$name"$'\t'"$value")
  else
    skipped+=("$where"$'\t'"$name")
  fi
}

for f in secrets.env runtime.override.env backup.env runtime.env; do
  for name in ${(f)"$(env_names "$DATA/$f")"}; do
    [[ -n $name ]] && consider "$f" "$name" env_value "$DATA/$f"
  done
done
for plist in "$AGENTS"/com.flint.*.plist(N); do
  label=${plist:t:r}
  case $label in
    com.flint.server) where=server.plist ;;
    com.flint.ollama) where=ollama.plist ;;
    *) where="$label.plist" ;;
  esac
  for name in ${(f)"$(plist_env_names "$plist")"}; do
    [[ -n $name ]] && consider "$where" "$name" plist_env_value "$plist"
  done
done

# The same for the files and folders that hold a sign-in: that one is there, never what is in it.
for key in ${(k)MF_CLASS}; do
  [[ $key == file/* && ${MF_CLASS[$key]} == reenter ]] || continue
  [[ -e $DATA/${key#file/} ]] && present+=("file"$'\t'"${key#file/}")
done

# The connectors that were set up, by name alone: their file holds keys, so it is
# never saved, and a rebuild says which ones need setting up again.
if [[ -r $DATA/mcp.json ]]; then
  i=0
  while (( i < 64 )) && cname="$(/usr/bin/plutil -extract "servers.$i.name" raw -o - "$DATA/mcp.json" 2>/dev/null)"; do
    [[ $cname =~ '^[a-z0-9][a-z0-9_-]{0,39}$' ]] && connectors+=("$cname")
    i=$(( i + 1 ))
  done
fi

if [[ $mode == check ]]; then
  if (( ${#unknown} == 0 )); then
    say "Every setting on this Mac is listed in the settings manifest."
    exit 0
  fi
  say "The settings manifest does not list ${#unknown} setting(s) found on this Mac. A rebuild would not put them back."
  for u in $unknown; do say "  ${u/$'\t'/  }"; done
  exit 1
fi

[[ -d $DATA ]] || refuse "Flint's data folder is not there, so there are no settings to save."
if [[ $mode == preview ]]; then
  # Names only, and nothing written: what a rebuild would get back, and what it would not.
  names() { local -a n; local s; for s in "$@"; do n+=("${${s#*$'\t'}%%$'\t'*}"); done; REPLY="${(j:, :)n}"; }
  names $saved; say "Flint would save ${#saved} settings for a rebuild: ${REPLY:-none}."
  names $skipped; say "It would leave out ${#skipped} whose value has an unexpected shape or looks like a secret: ${REPLY:-none}."
  names $unknown; say "It would leave out ${#unknown} it does not know: ${REPLY:-none}."
  names $present; say "It would note that ${#present} keys and sign-ins from outside were set, by name alone: ${REPLY:-none}."
  say "The connectors it would name: ${${(j:, :)connectors}:-none}."
  exit 0
fi
# Written whole, and only ever readable by its owner.
(
  umask 077
  {
    print -r -- "# Flint settings snapshot, version 1. Not secrets: apps/studio/settings.manifest says which settings are saved here."
    for s in $saved; do print -r -- "set"$'\t'"$s"; done
    for s in $skipped; do print -r -- "skipped"$'\t'"$s"; done
    for s in $unknown; do print -r -- "unknown"$'\t'"$s"; done
    for s in ${(o)present}; do print -r -- "present"$'\t'"$s"; done
    for s in $connectors; do print -r -- "connector"$'\t'"$s"; done
  } > "$SNAPSHOT.partial"
) 2>/dev/null || refuse "Flint could not save the settings snapshot."
chmod 600 "$SNAPSHOT.partial" && mv -f "$SNAPSHOT.partial" "$SNAPSHOT" || refuse "Flint could not save the settings snapshot."
say "Flint saved ${#saved} settings for a rebuild. It left out $(( ${#skipped} + ${#unknown} )) it does not know or whose value looks like a secret."
exit 0
