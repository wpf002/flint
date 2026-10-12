#!/bin/zsh
# Is the repo's picture of this Mac complete? Compared by NAME only: no setting's
# value and no file's content is read out or printed.
#
#   zsh apps/studio/test/live/settings_names.check.sh
#
#  1. every setting name in ~/.flint's env files and in the com.flint.*
#     LaunchAgents is listed in apps/studio/settings.manifest;
#  2. every com.flint.* LaunchAgent on this Mac is listed in agents.manifest;
#  3. every file or folder in ~/.flint that the offsite backup leaves out as a
#     secret is listed in settings.manifest, so a rebuild knows how it comes back.
#
# This runs against the real Mac, so it is not part of the deploy gate (which
# runs apps/studio/test/*.test.sh): a setting added by hand must never stop a
# deploy. Run it after adding a setting, an agent or a secret file, and add the
# name to the manifest it names. On a Mac with no Flint it has nothing to check.
set -u
here=${0:A:h}
studio=${here:h:h}
source "$studio/recovery_lib.sh"
DATA="$HOME/.flint"
AGENTS="$HOME/Library/LaunchAgents"
fail=0
[[ -d $DATA ]] || { print "ok: there is no Flint on this Mac, so there is nothing to compare"; exit 0; }
manifest_load || exit 1

# 1. settings
if out=$(/bin/zsh "$studio/settings_manifest.sh" --check 2>&1); then :; else print -r -- "$out"; fail=1; fi

# 2. agents
typeset -A listed
while read -r label how source load rest; do
  [[ -z $label || $label == \#* ]] && continue
  listed[$label]=1
done < "$AGENTS_MANIFEST"
for plist in "$AGENTS"/com.flint.*.plist(N); do
  label=${plist:t:r}
  [[ -n ${listed[$label]:-} ]] || { print -r -- "agents.manifest does not list $label, so a rebuild would not know where its file comes from."; fail=1; }
done

# 3. secret files: ask the backup's own exclude list which names it leaves out, on
#    an empty copy of the folder's names (so no content is ever read).
FLINT_BACKUP_DEFINE_ONLY=1 source "$studio/backup_flint.sh"
fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
for entry in "$DATA"/*(DN); do
  if [[ -d $entry && ! -L $entry ]]; then mkdir "$fx/${entry:t}"; else : > "$fx/${entry:t}"; fi
done
kept=$(tar -cf - -C "$fx" "${SECRETS[@]}" . 2>/dev/null | tar -tf - | sed -e 's#^\./##' -e 's#/$##')
for entry in "$fx"/*(DN); do
  name=${entry:t}
  print -r -- "$kept" | grep -qxF -- "$name" && continue   # not a secret: it is in the offsite copy
  manifest_lookup file "$name" && continue
  # A copy of a listed file made by hand (mcp.json.all42, backup.env.before-..., x.bak-...): the same secret, and never restored.
  covered=0
  for key in ${(k)MF_CLASS}; do
    [[ $key == file/* && $name == ${key#file/}.* ]] && { covered=1; break; }
  done
  [[ $name == *.bak* || $name == *.env ]] && covered=1
  (( covered )) || { print -r -- "settings.manifest does not list the secret file $name, so a rebuild would not say how it comes back."; fail=1; }
done

(( fail )) && exit 1
print "ok: every setting, agent and secret file on this Mac is listed, by name"
