#!/bin/zsh
# rebuild.sh: bring Flint back on a new Mac from the encrypted offsite backups.
#
# The offsite backups (apps/studio/backup_flint.sh and the runtime's nightly
# `offsite`) are age-encrypted to a key whose private half lives only on the
# MacBook. So the rebuild has two halves, and the key never leaves the MacBook:
#
#   On the MacBook:
#     rebuild.sh --to you@new-mac.local      The one command. It opens the newest
#                                            backups here, sends the opened copies
#                                            to the new Mac over SSH, and runs the
#                                            rebuild there.
#   The pieces it is made of:
#     rebuild.sh --unseal <bundle folder>    Open the newest backups into a folder.
#     rebuild.sh --from <bundle folder>      On the new Mac: rebuild from that folder.
#     rebuild.sh --rehearse <scratch folder> The whole rebuild into a scratch home
#                                            folder and a scratch database, with no
#                                            launchd, no installs and no sign-ins.
#                                            apps/studio/test/rebuild_rehearse.test.sh
#                                            runs it on every deploy.
#     rebuild.sh --stop <scratch folder>     Stop a rehearsal left running and remove it.
#
#   Options:
#     --offsite <folder>     where the encrypted backups are (default: iCloud Drive's FlintBackups)
#     --key <file>           the age key file (default: ~/.flint-standby/backup-key.txt)
#     --bundle <folder>      (with --rehearse) rehearse from a folder --unseal made
#     --model <name>         the local model, when the backup does not say
#     --without-database     rebuild although no database backup is offsite: Flint starts with an empty one
#     --replace-existing     rebuild on a Mac that has Flint files but no Flint database
#                            (the files are kept under another name)
#     --keep-running         (with --rehearse) leave the rehearsal up for a test to look at; --stop ends it
#
# What a rebuild restores, makes new, and leaves to you is written down by name
# in settings.manifest (settings) and agents.manifest (LaunchAgents):
#   - your memory, history and switches come back from the backup;
#   - every secret Flint can make is made fresh (FLINT_TOKEN, the database
#     passwords, the token files), so whatever the old Mac held is dead;
#   - keys and sign-ins from outside (an AI vendor, Google, Tailscale, the
#     approval key) are never in a backup: the rebuild ends by naming them.
#
# Safety: a backup is opened only into a folder nobody else can read, and its
# opened copy is removed when the rebuild ends. Nothing from a backup is ever
# run: settings are read as text and checked against settings.manifest, scripts
# lose their execute bit, links are dropped, and connectors are rebuilt from
# this repo. The database is restored as its owner role, never a superuser. A
# rebuild never replaces a Flint database that is already there (that is
# `restore-production`, docs/RECOVERY.md). Every line this prints is a sentence;
# no secret is ever printed (one exception, by design: the one-time code for
# enrolling your approval key).
set -u
setopt pipefail

NODE_VERSION="v24.15.0"   # matches the PATH baked into the repo's LaunchAgent files

# ==== the toolchain: runs on the new Mac before the repo is there, so it stands alone ====
toolchain() {
  emulate -L zsh
  local repo_url=${1:-https://github.com/wpf002/flint.git}
  [[ $repo_url =~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' ]] || { print -r -- "That is not a GitHub address Flint can clone from."; return 1; }
  [[ "$(uname -s)" == Darwin ]] || { print -r -- "Flint rebuilds only onto a Mac."; return 1; }
  if ! command -v brew >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/brew ]]; then
    print -r -- "Installing Homebrew needs this Mac's password once."
    sudo -v || { print -r -- "Flint could not get permission to install Homebrew."; return 1; }
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1 \
      || { print -r -- "Homebrew did not install. Install it from brew.sh and run this again."; return 1; }
  fi
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
  print -r -- "Flint is installing what it runs on. This takes a few minutes."
  local formula
  for formula in git postgresql@17 ollama tailscale age uv; do
    brew list --formula "$formula" >/dev/null 2>&1 || brew install --quiet "$formula" >/dev/null 2>&1 \
      || { print -r -- "The package $formula did not install. Run this to see why:"; print -r -- "  brew install $formula"; return 1; }
  done
  export NVM_DIR="$HOME/.nvm"
  [[ -s $NVM_DIR/nvm.sh ]] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh 2>/dev/null | PROFILE=/dev/null bash >/dev/null 2>&1
  [[ -s $NVM_DIR/nvm.sh ]] || { print -r -- "Node's installer did not finish. Check this Mac's internet connection and run this again."; return 1; }
  source "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION" >/dev/null 2>&1 && nvm alias default "$NODE_VERSION" >/dev/null 2>&1 && nvm use "$NODE_VERSION" >/dev/null 2>&1 \
    || { print -r -- "Node $NODE_VERSION did not install."; return 1; }
  corepack enable >/dev/null 2>&1 || true
  if [[ -d $HOME/flint/.git ]]; then
    git -C "$HOME/flint" fetch --quiet origin main && git -C "$HOME/flint" reset --hard --quiet origin/main \
      || { print -r -- "Flint's code could not be brought up to date."; return 1; }
  else
    git clone --quiet "$repo_url" "$HOME/flint" || { print -r -- "Flint's code could not be downloaded."; return 1; }
  fi
  ( cd "$HOME/flint" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile >/dev/null 2>&1 ) \
    || { print -r -- "Flint's code downloaded, and its packages did not install."; return 1; }
  print -r -- "This Mac has what Flint runs on, and Flint's code."
}
if [[ ${1:-} == --toolchain ]]; then toolchain "${2:-}"; exit $?; fi

SELF=${0:A}
HERE=${0:A:h}
REPO=${HERE:h:h}
source "$HERE/recovery_lib.sh"
QUIET="$REPO/test-support/quiet-bin"
STANDINS="$HERE/rehearsal"
TMP="${${TMPDIR:-/tmp}%/}"

# ==== arguments ====
MODE= ARG= OFFSITE= KEY= GIVEN_BUNDLE= MODEL= WITHOUT_DB=0 REPLACE=0 KEEP_RUNNING=0
usage="Run this as rebuild.sh --to you@new-mac.local on the MacBook. The top of the script lists the other ways to run it."
while (( $# > 0 )); do
  case $1 in
    --to|--unseal|--from|--rehearse|--stop)
      [[ -z $MODE ]] || refuse "$usage"
      (( $# >= 2 )) || refuse "$usage"
      MODE=${1#--} ARG=$2; shift 2 ;;
    --offsite) (( $# >= 2 )) || refuse "$usage"; OFFSITE=$2; shift 2 ;;
    --key) (( $# >= 2 )) || refuse "$usage"; KEY=$2; shift 2 ;;
    --bundle) (( $# >= 2 )) || refuse "$usage"; GIVEN_BUNDLE=$2; shift 2 ;;
    --model) (( $# >= 2 )) || refuse "$usage"; MODEL=$2; shift 2 ;;
    --without-database) WITHOUT_DB=1; shift ;;
    --replace-existing) REPLACE=1; shift ;;
    --keep-running) KEEP_RUNNING=1; shift ;;
    *) refuse "$usage" ;;
  esac
done
[[ -n $MODE && -n $ARG ]] || refuse "$usage"
[[ -z $MODEL ]] || flint_value_ok model "$MODEL" || refuse "That model name is not one Flint can use."
[[ $EUID != 0 ]] || refuse "Run this as yourself, not as root."

# ==== small helpers ====
typeset -F SECONDS
typeset -a STEP_TIMES
T0=$SECONDS
timed() { # <name>: record how long the step since the last call took (the rehearsal's report)
  STEP_TIMES+=("$1"$'\t'"$(printf '%.1f' $(( SECONDS - T0 )))")
  T0=$SECONDS
}
abs() { # a path made absolute, in REPLY (the path itself need not exist yet)
  emulate -L zsh
  if [[ $1 == /* ]]; then REPLY=$1; else REPLY="$PWD/$1"; fi
  REPLY=${REPLY:a}
}
empty_or_absent() { [[ ! -e $1 ]] || { [[ -d $1 && ! -L $1 ]] && [[ -z "$(ls -A "$1" 2>/dev/null)" ]]; }; }
private() { (( ( 8#$(/usr/bin/stat -f %Lp "$1") & 8#077 ) == 0 )); }   # nobody but its owner can read or write it
sha_of() { REPLY="$(/usr/bin/shasum -a 256 -- "$1" 2>/dev/null)" || return 1; REPLY=${REPLY%% *}; [[ $REPLY =~ '^[0-9a-f]{64}$' ]]; }
when_of() { # a backup's name -> a few words for when it was made, in REPLY
  emulate -L zsh
  if [[ $1 =~ '^flint-([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})' ]]; then REPLY="$match[1]-$match[2]-$match[3] at $match[4]:$match[5]"
  elif [[ $1 =~ '^flint-([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})-([0-9]{2})' ]]; then REPLY="$match[1] at $match[2]:$match[3] UTC"
  else REPLY="an unknown time"; fi
}

FILES_NAME='^flint-[0-9]{8}-[0-9]{4}\.tar\.gz\.age$'
DUMP_NAME='^flint-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.dump\.age$'

# ==== opening the backups (on the Mac that holds the key) ====

# The names in <folder> that match <pattern>, newest first, one per line. A
# file iCloud has not downloaded yet shows up as .<name>.icloud and counts too.
candidates() {
  emulate -L zsh
  local dir=$1 pattern=$2 f name
  local -a names
  for f in "$dir"/flint-*(N) "$dir"/.flint-*.icloud(N); do
    name=${f:t}
    [[ $name == .*.icloud ]] && name=${${name#.}%.icloud}
    [[ $name =~ $pattern ]] && names+=("$name")
  done
  (( ${#names} )) && print -rl -- ${(Ou)names}
  return 0
}

# Make sure <file> is really on this disk: ask iCloud for it and wait, if it is only a placeholder.
materialize() {
  emulate -L zsh
  local file=$1 wait=${FLINT_ICLOUD_WAIT:-600} i=0
  [[ -f $file ]] && return 0
  [[ -e ${file:h}/.${file:t}.icloud ]] || return 1
  command -v brctl >/dev/null 2>&1 && brctl download "$file" >/dev/null 2>&1
  while (( i < wait )); do
    [[ -f $file ]] && return 0
    sleep 1; i=$(( i + 1 ))
  done
  return 1
}

# age_open <key> <in> <out>: 0 opened; 2 the key does not open it; 3 the file is damaged.
age_open() {
  emulate -L zsh
  local errf st
  errf="$(mktemp "$TMP/flint-age.XXXXXX")" || return 3
  ( umask 077; "$AGE" -d -i "$1" -o "$3.partial" -- "$2" ) 2>"$errf"; st=$?
  if [[ $st == 0 && -s $3.partial ]]; then
    rm -f "$errf"; chmod 600 "$3.partial" && mv -f "$3.partial" "$3"; return 0
  fi
  rm -f "$3.partial"
  if grep -q 'no identity matched' "$errf" 2>/dev/null; then rm -f "$errf"; return 2; fi
  rm -f "$errf"; return 3
}

# Every member of a files archive must stay inside the folder it is unpacked
# into: a plain file, a folder or a link, never a path that climbs out, and
# never a path that passes through a link the same archive carries (the way an
# archive writes outside its folder). Links themselves are dropped after unpacking.
archive_is_safe() {
  emulate -L zsh
  local -a kinds names links
  local i link
  kinds=("${(@f)$(/usr/bin/tar -tvzf "$1" 2>/dev/null)}") || return 1
  names=("${(@f)$(/usr/bin/tar -tzf "$1" 2>/dev/null)}") || return 1
  (( ${#names} > 0 && ${#names} == ${#kinds} )) || return 1
  for (( i = 1; i <= ${#names}; i++ )); do
    [[ ${kinds[i][1]} == [-dl] ]] || return 1
    [[ ${kinds[i]} == *' link to '* ]] && return 1
    [[ ${names[i]} == /* || ${names[i]} == .. || ${names[i]} == ../* || ${names[i]} == */../* || ${names[i]} == */.. ]] && return 1
    [[ ${kinds[i][1]} == l ]] && links+=("${names[i]%/}")
  done
  for link in $links; do
    for (( i = 1; i <= ${#names}; i++ )); do
      [[ ${names[i]} == $link/* ]] && return 1
    done
  done
  return 0
}

unseal() { # <offsite folder> <key file> <bundle folder>
  emulate -L zsh
  local offsite=$1 key=$2 bundle=$3 name st when files_from= dump_from= dump_dir counts_note=
  need_tool age "The program age is not installed, and Flint needs it to open a backup. Install it with: brew install age"; AGE=$REPLY
  [[ -f $key && ! -L $key ]] || refuse "The backup key file is not there. Name it with --key, followed by the file."
  [[ -O $key ]] || refuse "The backup key file belongs to someone else on this Mac, so Flint will not use it."
  private "$key" || refuse "Others on this Mac can read your backup key. Fix that first with: chmod 600 ${(q-)key}"
  grep -q '^AGE-SECRET-KEY-1' "$key" 2>/dev/null || refuse "That file is not an age key."
  [[ -d $offsite ]] || refuse "The backup folder is not there. Check that iCloud Drive is signed in on this Mac, or name the folder with --offsite."
  empty_or_absent "$bundle" || refuse "The folder to open the backups into is not empty. Choose a new one."
  mkdir -p -m 700 "$bundle" && chmod 700 "$bundle" || refuse "Flint could not make the folder to open the backups into."

  # 1. Flint's files: the newest archive that opens and is whole.
  for name in ${(f)"$(candidates "$offsite" "$FILES_NAME")"}; do
    [[ -n $name ]] || continue
    when_of "$name"; when=$REPLY
    if ! materialize "$offsite/$name"; then
      say "The files backup from $when has not come down from iCloud, so Flint is using the one before it."
      continue
    fi
    age_open "$key" "$offsite/$name" "$bundle/files.tar.gz"; st=$?
    if [[ $st == 2 ]]; then
      rm -rf "${bundle:?}"
      refuse "This key does not open the backups. They were made for a different key."
    fi
    if [[ $st == 0 ]] && archive_is_safe "$bundle/files.tar.gz"; then files_from=$name; break; fi
    rm -f "$bundle/files.tar.gz"
    say "The files backup from $when is damaged, so Flint is using the one before it."
  done
  if [[ -z $files_from ]]; then
    rm -rf "${bundle:?}"
    refuse "There is no files backup Flint can open in that folder."
  fi

  # 2. Flint's database: the newest dump that opens. Its row counts ride beside it when the backup sent them.
  for dump_dir in "$offsite/pg" "$offsite"; do
    [[ -d $dump_dir ]] || continue
    for name in ${(f)"$(candidates "$dump_dir" "$DUMP_NAME")"}; do
      [[ -n $name ]] || continue
      when_of "$name"; when=$REPLY
      if ! materialize "$dump_dir/$name"; then
        say "The database backup from $when has not come down from iCloud, so Flint is using the one before it."
        continue
      fi
      age_open "$key" "$dump_dir/$name" "$bundle/${name%.age}"; st=$?
      if [[ $st == 2 ]]; then
        rm -rf "${bundle:?}"
        refuse "This key does not open the database backup. It was made for a different key."
      fi
      if [[ $st == 0 ]]; then
        dump_from=$name
        if materialize "$dump_dir/${name%.age}.counts.json.age"; then
          age_open "$key" "$dump_dir/${name%.age}.counts.json.age" "$bundle/${name%.age}.counts.json" || counts_note=" Its row counts could not be opened, so its sizes will not be compared."
        fi
        break 2
      fi
      say "The database backup from $when is damaged, so Flint is using the one before it."
    done
  done
  if [[ -z $dump_from && $WITHOUT_DB != 1 ]]; then
    rm -rf "${bundle:?}"
    refuse "There is no database backup Flint can open in that folder. To rebuild with your files and an empty database, add --without-database."
  fi

  # 3. What is in the bundle, and the fingerprint of each file: checked again before anything is restored from it.
  (
    umask 077
    {
      print -r -- "version=1"
      print -r -- "files=$files_from"
      print -r -- "database=${dump_from:-none}"
    } > "$bundle/bundle.info"
    : > "$bundle/MANIFEST.sha256"
    for name in "$bundle"/*(N); do
      [[ ${name:t} == MANIFEST.sha256 ]] && continue
      sha_of "$name" || exit 1
      print -r -- "$REPLY  ${name:t}" >> "$bundle/MANIFEST.sha256"
    done
  ) || { rm -rf "${bundle:?}"; refuse "Flint could not finish the folder of opened backups."; }
  when_of "$files_from"
  say "Flint opened the files backup from $REPLY."
  if [[ -n $dump_from ]]; then
    when_of "$dump_from"
    say "Flint opened the database backup from $REPLY.$counts_note"
  else
    say "There is no database backup offsite, so the rebuilt Flint starts with an empty database."
  fi
}

# verify_bundle <folder>: only its owner can read it, it holds exactly what its
# manifest lists, and every file still has the fingerprint taken when it was opened.
# The database dump's path, when there is one, is left in BUNDLE_DUMP.
verify_bundle() {
  emulate -L zsh
  local bundle=$1 line sum name
  local -A listed
  [[ -d $bundle && ! -L $bundle && -O $bundle ]] || refuse "The folder of opened backups is not there, or is not yours."
  private "$bundle" || refuse "Others on this Mac can read the folder of opened backups. Open the backups again into a new folder."
  [[ -f $bundle/MANIFEST.sha256 && -f $bundle/bundle.info && -f $bundle/files.tar.gz ]] || refuse "That folder is not one that rebuild.sh --unseal made."
  while IFS= read -r line; do
    [[ $line =~ '^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,120})$' ]] || refuse "The list of opened backups is not readable. Open the backups again."
    sum=$match[1] name=$match[2]
    [[ -f $bundle/$name && ! -L $bundle/$name ]] || refuse "The opened backups are incomplete. Open the backups again."
    sha_of "$bundle/$name" && [[ $REPLY == $sum ]] || refuse "An opened backup has changed since it was opened, so Flint will not restore from it. Open the backups again."
    listed[$name]=1
  done < "$bundle/MANIFEST.sha256"
  for name in "$bundle"/*(DN); do
    [[ ${name:t} == MANIFEST.sha256 || -n ${listed[${name:t}]:-} ]] || refuse "The folder of opened backups holds a file that was not there when it was made. Open the backups again."
  done
  [[ -n ${listed[files.tar.gz]:-} && -n ${listed[bundle.info]:-} ]] || refuse "The opened backups are incomplete. Open the backups again."
  env_value "$bundle/bundle.info" database || refuse "The opened backups are incomplete. Open the backups again."
  BUNDLE_DUMP=
  if [[ $REPLY != none ]]; then
    [[ $REPLY =~ $DUMP_NAME && -n ${listed[${REPLY%.age}]:-} ]] || refuse "The opened backups are incomplete. Open the backups again."
    BUNDLE_DUMP="$bundle/${REPLY%.age}"
  fi
}

# ==== --stop: end a rehearsal that was left running, and remove it ====
stop_rehearsal() {
  emulate -L zsh
  local dir=$1 sock
  [[ -n $dir && -f $dir/.flint-rehearsal && -O $dir/.flint-rehearsal ]] || refuse "That folder is not a Flint rebuild rehearsal, so Flint left it alone."
  FLINT_REHEARSAL_STATE="$dir/state" /bin/zsh "$STANDINS/launchctl" rehearsal-stop-all 2>/dev/null
  if [[ -f $dir/pg/postmaster.pid ]]; then
    need_tool pg_ctl "The program pg_ctl is missing, so Flint could not stop the rehearsal's database."
    "$REPLY" -D "$dir/pg" -m immediate -w -t 20 stop >/dev/null 2>&1
  fi
  if [[ -r $dir/state/socket-dir ]]; then
    sock="$(<"$dir/state/socket-dir")"
    [[ $sock == $TMP/flint-rh.* ]] && rm -rf "${sock:?}"
  fi
  rm -rf "${dir:?}"
}

# ==== the modes that only open or move backups ====
default_offsite() { REPLY="$HOME/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups"; }
default_key() { REPLY="$HOME/.flint-standby/backup-key.txt"; }

if [[ $MODE == stop ]]; then
  abs "$ARG"; stop_rehearsal "$REPLY"
  say "The rehearsal is stopped and its folder is removed."
  exit 0
fi

if [[ $MODE == unseal ]]; then
  abs "$ARG"; bundle=$REPLY
  [[ -n $OFFSITE ]] || { default_offsite; OFFSITE=$REPLY; }
  [[ -n $KEY ]] || { default_key; KEY=$REPLY; }
  unseal "$OFFSITE" "$KEY" "$bundle"
  say "The opened backups are in ${bundle}. They are not encrypted: remove that folder when the rebuild is done."
  exit 0
fi

if [[ $MODE == to ]]; then
  # The MacBook's half: open here, send the opened copies, rebuild there. The key is never sent.
  target=$ARG
  [[ $target =~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$' ]] || refuse "Name the new Mac as you@its-name, for example willfoti@new-studio.local."
  [[ -n $OFFSITE ]] || { default_offsite; OFFSITE=$REPLY; }
  [[ -n $KEY ]] || { default_key; KEY=$REPLY; }
  work="$(mktemp -d "$TMP/flint-rebuild.XXXXXX")" || refuse "Flint could not make a working folder."
  chmod 700 "$work"
  ssh_opts=(-o ConnectTimeout=20 -o ControlMaster=auto -o "ControlPath=$work/ssh-%C" -o ControlPersist=900)
  cleanup_to() { ssh "${ssh_opts[@]}" -O exit -- "$target" >/dev/null 2>&1; rm -rf "${work:?}"; }
  trap cleanup_to EXIT
  trap 'exit 130' INT TERM
  unseal "$OFFSITE" "$KEY" "$work/bundle"
  repo_url="$(git -C "$REPO" remote get-url origin 2>/dev/null)" || repo_url=
  [[ $repo_url =~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' ]] || repo_url=https://github.com/wpf002/flint.git
  say "Flint is connecting to the new Mac. Enter that Mac's password when it asks."
  ssh "${ssh_opts[@]}" -- "$target" 'mkdir -p -m 700 flint-rebuild-bundle && chmod 700 flint-rebuild-bundle && [ -z "$(ls -A flint-rebuild-bundle)" ]' \
    || refuse "Flint could not reach the new Mac, or a rebuild's files are already there. Turn on Remote Login on the new Mac, remove the folder flint-rebuild-bundle from its home folder, and run this again."
  sent=("$work/bundle"/*(DN))
  # ${target}, in braces: a bare $target:f... would be read by zsh as a modifier on the name.
  scp -q "${ssh_opts[@]}" -- "${sent[@]}" "${target}:flint-rebuild-bundle/" || refuse "The backups did not reach the new Mac. Nothing there was changed."
  scp -q "${ssh_opts[@]}" -- "$SELF" "${target}:flint-rebuild-toolchain.sh" || refuse "The backups did not reach the new Mac. Nothing there was changed."
  say "The backups are on the new Mac. Flint is setting it up."
  ssh -t "${ssh_opts[@]}" -- "$target" "/bin/zsh flint-rebuild-toolchain.sh --toolchain ${(q-)repo_url}; st=\$?; rm -f flint-rebuild-toolchain.sh; exit \$st" \
    || refuse "The new Mac could not be set up. The opened backups are still in flint-rebuild-bundle in its home folder: remove that folder if you are not trying again."
  remote_args=(--from flint-rebuild-bundle)
  [[ -n $MODEL ]] && remote_args+=(--model "$MODEL")
  (( REPLACE )) && remote_args+=(--replace-existing)
  (( WITHOUT_DB )) && remote_args+=(--without-database)
  # Each word quoted on its own, then joined: the new Mac's shell sees the same words this one does.
  quoted_args=(${(q-)remote_args})
  ssh -t "${ssh_opts[@]}" -- "$target" "/bin/zsh flint/apps/studio/rebuild.sh ${(j: :)quoted_args}" \
    || refuse "The rebuild stopped before it finished. What it printed above says why. Running this command again starts it over."
  exit 0
fi

# ==== from here: the rebuild itself (--from on the new Mac, or --rehearse) ====
REHEARSE=0
[[ $MODE == rehearse ]] && REHEARSE=1

if (( REHEARSE )) && [[ -z ${FLINT_REHEARSAL_INNER:-} ]]; then
  # The rehearsal starts over in an environment of its own: a scratch home folder, and a PATH
  # whose first entries are the stand-ins, so no step can reach launchd, the screen, Homebrew,
  # the tailnet or another machine.
  abs "$ARG"; SCRATCH=$REPLY
  real_home=${HOME:A}
  for guarded in "$real_home/.flint" "$real_home/flint" "$real_home/Library" "$real_home/FlintBackups" "$real_home/.flint-standby"; do
    [[ $SCRATCH == $guarded || $SCRATCH == $guarded/* ]] && refuse "A rehearsal never runs inside Flint's own folders. Choose a scratch folder somewhere else."
  done
  [[ $SCRATCH != $real_home && $SCRATCH != / ]] || refuse "Choose a scratch folder for the rehearsal, not your home folder."
  empty_or_absent "$SCRATCH" || refuse "The rehearsal's folder is not empty. Choose a new one."
  [[ -d ${SCRATCH:h} ]] || refuse "The folder the rehearsal's folder would go in is not there."
  (( ! REPLACE )) || refuse "A rehearsal always starts from an empty scratch folder, so --replace-existing does not apply to it."
  for tool in node pnpm; do
    need_tool $tool "The program $tool is not installed, and the rehearsal needs it."
    typeset "TOOL_$tool=$REPLY"
  done
  need_tool initdb "Postgres 17 is not installed, and the rehearsal needs it. Install it with: brew install postgresql@17"; pg_bin=${REPLY:h}
  [[ -n $OFFSITE ]] && { abs "$OFFSITE"; OFFSITE=$REPLY; }
  [[ -n $KEY ]] && { abs "$KEY"; KEY=$REPLY; }
  [[ -n $GIVEN_BUNDLE ]] && { abs "$GIVEN_BUNDLE"; GIVEN_BUNDLE=$REPLY; }
  [[ -n $OFFSITE || -n $GIVEN_BUNDLE ]] || { default_offsite; OFFSITE=$REPLY; }
  [[ -n $KEY || -n $GIVEN_BUNDLE ]] || { default_key; KEY=$REPLY; }
  mkdir -p -m 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/state" "$SCRATCH/log" || refuse "Flint could not make the rehearsal's folder."
  chmod 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/state" "$SCRATCH/log"
  : > "$SCRATCH/.flint-rehearsal"
  # pnpm here is Corepack's; a scratch home has no copy of it, so the rehearsal brings one and never downloads.
  corepack=()
  if [[ -d $real_home/.cache/node/corepack ]]; then
    /bin/cp -Rc "$real_home/.cache/node/corepack" "$SCRATCH/corepack" 2>/dev/null || /bin/cp -R "$real_home/.cache/node/corepack" "$SCRATCH/corepack"
    corepack=("COREPACK_HOME=$SCRATCH/corepack")
  fi
  inner=(--rehearse "$SCRATCH")
  [[ -n $OFFSITE ]] && inner+=(--offsite "$OFFSITE")
  [[ -n $KEY ]] && inner+=(--key "$KEY")
  [[ -n $GIVEN_BUNDLE ]] && inner+=(--bundle "$GIVEN_BUNDLE")
  [[ -n $MODEL ]] && inner+=(--model "$MODEL")
  (( WITHOUT_DB )) && inner+=(--without-database)
  (( KEEP_RUNNING )) && inner+=(--keep-running)
  rehearsal_path=("$STANDINS" "$QUIET" "${TOOL_node:h}" "${TOOL_pnpm:h}" "$pg_bin" ${(s.:.)${FLINT_TOOL_PATHS-/opt/homebrew/bin}} /usr/bin /bin /usr/sbin /sbin)
  exec /usr/bin/env -i \
    HOME="$SCRATCH/home" USER="$(id -un)" LOGNAME="$(id -un)" TMPDIR="$TMP" LANG=en_US.UTF-8 \
    PATH="${(j.:.)rehearsal_path}" \
    COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${corepack[@]}" \
    ${FLINT_TOOL_PATHS+FLINT_TOOL_PATHS=$FLINT_TOOL_PATHS} ${FLINT_ICLOUD_WAIT+FLINT_ICLOUD_WAIT=$FLINT_ICLOUD_WAIT} \
    ${FLINT_REHEARSAL_EXISTING+FLINT_REHEARSAL_EXISTING=$FLINT_REHEARSAL_EXISTING} \
    FLINT_REHEARSAL_STATE="$SCRATCH/state" FLINT_REHEARSAL_INNER=1 \
    /bin/zsh "$SELF" "${inner[@]}"
fi

if (( REHEARSE )); then
  abs "$ARG"; SCRATCH=$REPLY
  [[ $HOME == $SCRATCH/home && -f $SCRATCH/.flint-rehearsal ]] || refuse "The rehearsal was not started the way it starts itself."
  # No step of a rehearsal may reach the real launchd: prove the stand-in answers before going on.
  [[ "$(whence -p launchctl)" == $STANDINS/launchctl ]] || refuse "The rehearsal's launchctl stand-in is not first on the PATH, so the rehearsal stopped before doing anything."
  launchctl print gui/0/com.flint.rehearsal-probe >/dev/null 2>&1
  [[ $? == 113 ]] || refuse "The rehearsal's launchctl stand-in did not answer, so the rehearsal stopped before doing anything."
  BUNDLE="$SCRATCH/bundle"
  PG_DATA="$SCRATCH/pg"
  LOG="$SCRATCH/log"
  finish_rehearsal() {
    local st=$?
    trap - EXIT INT TERM
    if (( KEEP_RUNNING )) && [[ $st == 0 ]]; then exit 0; fi
    if [[ $st != 0 && -d $SCRATCH/log ]]; then
      # What went wrong is in the logs: they outlive the rehearsal's folder, which holds opened backups and must go.
      rm -rf "${SCRATCH:?}.failed-log"
      mv "$SCRATCH/log" "$SCRATCH.failed-log" 2>/dev/null && say "The rehearsal did not pass. Its logs are kept in $SCRATCH.failed-log."
    fi
    stop_rehearsal "$SCRATCH" 2>/dev/null
    exit $st
  }
  trap finish_rehearsal EXIT
  trap 'exit 130' INT TERM
  ports=(${(f)"$(node -e '
    const net = require("net"); const servers = []; let left = 4;
    for (let i = 0; i < 4; i++) { const s = net.createServer(); servers.push(s); s.listen(0, "::1", () => { if (--left === 0) { console.log(servers.map((x) => x.address().port).join("\n")); servers.forEach((x) => x.close()); } }); }
  ' 2>/dev/null)"})
  (( ${#ports} == 4 )) || refuse "The rehearsal could not find free ports on this Mac."
  PG_PORT=$ports[1] SERVER_PORT=$ports[2] RUNTIME_PORT=$ports[3] INTERNAL_PORT=$ports[4]
  PG_SOCKET="$(mktemp -d "$TMP/flint-rh.XXXXXX")" || refuse "The rehearsal could not make a folder for its database's socket."
  chmod 700 "$PG_SOCKET"
  print -r -- "$PG_SOCKET" > "$SCRATCH/state/socket-dir"
else
  abs "$ARG"; BUNDLE=$REPLY
  PG_PORT=5432 SERVER_PORT=8080 RUNTIME_PORT=8090 INTERNAL_PORT=8081
  PG_SOCKET=/tmp
  LOG="$HOME/.flint-rebuild-log"
  [[ "$(uname -s)" == Darwin ]] || refuse "Flint rebuilds only onto a Mac."
  # nvm and Homebrew set themselves up with variables that may not be set yet: not an error here.
  set +u
  [[ -s $HOME/.nvm/nvm.sh ]] && { export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use "$NODE_VERSION" >/dev/null 2>&1; }
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
  set -u
  path=(/opt/homebrew/opt/postgresql@17/bin $path)
  PG_DATA="${HOMEBREW_PREFIX:-/opt/homebrew}/var/postgresql@17"
fi
DATA="$HOME/.flint"
AGENTS="$HOME/Library/LaunchAgents"
ME="$(id -un)"
MARKER="$DATA/.rebuild-in-progress"

# ---- 1. before anything changes ----------------------------------------------------------
if (( ! REHEARSE )); then
  need_tool fdesetup "This Mac cannot say whether FileVault is on, so Flint stopped."
  "$REPLY" status 2>/dev/null | grep -q 'FileVault is On' || refuse "FileVault is off on this Mac, and a rebuild puts your memory and history on its disk. Turn FileVault on in System Settings, then run this again."
  [[ $REPO == ${${:-$HOME/flint}:A} ]] || refuse "On the new Mac, run the copy of this script that is in the flint folder of your home folder."
  # Flint's services are LaunchAgents: they live in your login session, and there is none until you log in at the screen.
  launchctl print "gui/$UID" >/dev/null 2>&1 || refuse "Log in at the new Mac's own screen first, and leave it logged in. Flint runs in your login session. Nothing was changed."
fi
for tool in node pnpm openssl tar shasum plutil psql pg_ctl initdb pg_restore pg_isready curl git; do
  need_tool $tool "The program $tool is not installed, and the rebuild needs it."
  typeset "TOOL_$tool=$REPLY"
done
if (( REHEARSE )); then
  # The rehearsal only needs to know where these would be: it never runs them.
  OLLAMA_BIN=/opt/homebrew/bin/ollama TAILSCALED_BIN=/opt/homebrew/opt/tailscale/bin/tailscaled
else
  need_tool ollama "Ollama is not installed. Install it with: brew install ollama"; OLLAMA_BIN=$REPLY
  need_tool tailscaled "Tailscale is not installed. Install it with: brew install tailscale"; TAILSCALED_BIN=$REPLY
  need_tool tailscale "Tailscale is not installed. Install it with: brew install tailscale"; TAILSCALE_BIN=$REPLY
fi
manifest_load || exit 1

if (( REHEARSE )) && [[ -z $GIVEN_BUNDLE ]]; then
  unseal "$OFFSITE" "$KEY" "$BUNDLE"
elif (( REHEARSE )); then
  # A bundle made elsewhere: the rehearsal works on its own copy and leaves the given one alone.
  verify_bundle "$GIVEN_BUNDLE"
  /bin/cp -Rp "$GIVEN_BUNDLE" "$BUNDLE" && chmod 700 "$BUNDLE" || refuse "The rehearsal could not copy the opened backups."
fi
verify_bundle "$BUNDLE"
archive_is_safe "$BUNDLE/files.tar.gz" || refuse "The files backup holds something that does not belong in it, so Flint will not unpack it."
timed backups

# Your settings, read out of the files backup before anything is unpacked, so that
# whatever is missing is known while nothing has changed yet. Only the ones that are
# not secrets are in there, and each is checked again here against settings.manifest.
typeset -a SET_SECRETS SET_OVERRIDE SET_BACKUP SET_SERVER SET_OLLAMA NOT_RESTORED CONNECTORS PRESENT
RESTORED_PORT= RESTORED_MODEL= have_snapshot=0
snapshot="$(mktemp "$TMP/flint-settings.XXXXXX")" || refuse "Flint could not make a working file."
if /usr/bin/tar -xzOf "$BUNDLE/files.tar.gz" ./settings-snapshot.tsv > "$snapshot" 2>/dev/null && [[ -s $snapshot ]]; then
  have_snapshot=1
  while IFS=$'\t' read -r kind where name value extra; do
    case $kind in
      set)
        if [[ -n $extra ]] || ! manifest_lookup "$where" "$name" || [[ $REPLY != restore ]] || ! flint_value_ok "$REPLY2" "$value"; then
          [[ $name =~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' ]] && NOT_RESTORED+=("$name")
          continue
        fi
        shape=$REPLY2
        # A rehearsal keeps its own addresses and ports: a restored one would point it at the real Flint.
        if (( REHEARSE )) && [[ $shape == (loopback|bindaddr|port) ]]; then continue; fi
        [[ $shape == homepath ]] && value="$HOME${value#\~}"
        case $where in
          secrets.env) SET_SECRETS+=("$name=$value") ;;
          runtime.override.env) SET_OVERRIDE+=("$name=$value") ;;
          backup.env) SET_BACKUP+=("$name=$value") ;;
          server.plist)
            if [[ $name == PORT ]]; then RESTORED_PORT=$value
            elif [[ $name == OLLAMA_MODEL ]]; then RESTORED_MODEL=$value
            else SET_SERVER+=("$name=$value"); fi ;;
          ollama.plist) SET_OLLAMA+=("$name=$value") ;;
          *) NOT_RESTORED+=("$name") ;;
        esac ;;
      skipped|unknown) [[ $where =~ '^[A-Za-z0-9._-]{1,60}$' && $name =~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' ]] && NOT_RESTORED+=("$name") ;;
      connector) [[ $where =~ '^[a-z0-9][a-z0-9_-]{0,39}$' ]] && CONNECTORS+=("$where") ;;
      present) [[ $where =~ '^[A-Za-z0-9._-]{1,60}$' && $name =~ '^[A-Za-z0-9._-]{1,80}$' ]] && manifest_lookup "$where" "$name" && [[ $REPLY == reenter ]] && PRESENT+=("$REPLY2") ;;
    esac
  done < "$snapshot"
fi
rm -f "$snapshot"
(( ! REHEARSE )) && [[ -n $RESTORED_PORT ]] && SERVER_PORT=$RESTORED_PORT
[[ -n $MODEL ]] || MODEL=$RESTORED_MODEL
if [[ -z $MODEL ]]; then
  (( REHEARSE )) || refuse "The backup does not say which local model Flint uses. Nothing was changed. Run this again and add --model with its name, for example: --model muse-glimmer:30b"
  MODEL=rehearsal-model
fi
SET_SERVER+=("OLLAMA_MODEL=$MODEL")

# The Mac must be empty of Flint. Two things are allowed past that: a rebuild that stopped
# part-way and is being run again (its own marker says so), and the owner's explicit word.
# (The test of that refusal: a rehearsal can be told to pretend its scratch Mac already has Flint's files.)
if (( REHEARSE )) && [[ ${FLINT_REHEARSAL_EXISTING:-} == files ]]; then mkdir -p -m 700 "$DATA" && : > "$DATA/already-here"; fi
# (And of the way past it: a rehearsal can be told to pretend an earlier rebuild stopped part-way here.)
if (( REHEARSE )) && [[ ${FLINT_REHEARSAL_EXISTING:-} == resume ]]; then mkdir -p -m 700 "$DATA" && : > "$MARKER" && : > "$DATA/left-by-the-first-try"; fi
RESUME=0
[[ -f $MARKER ]] && RESUME=1
if (( ! RESUME )); then
  existing=()
  empty_or_absent "$DATA" || existing+=("its data folder")
  [[ -z "$(print -l "$AGENTS"/com.flint.*.plist(N))" ]] || existing+=("its LaunchAgents")
  if (( ${#existing} )); then
    (( REPLACE )) || refuse "This Mac already has a Flint (${(j: and :)existing}). Nothing was changed. A rebuild is for a new Mac. To rebuild over what is here, add --replace-existing: the data folder is kept under another name."
  fi
fi
mkdir -p -m 700 "$LOG" && chmod 700 "$LOG" || refuse "Flint could not make a folder for the rebuild's logs."

# ---- the database server, and whether a Flint database is already in it --------------------
pg_conf() { # this Mac's own login by socket, every other connection by password on ::1, nothing off this Mac
  emulate -L zsh
  [[ -f $PG_DATA/pg_hba.conf.before-flint ]] || cp -p "$PG_DATA/pg_hba.conf" "$PG_DATA/pg_hba.conf.before-flint" || return 1
  print -r -- "# Written by Flint (apps/studio/rebuild.sh). The copy from before is pg_hba.conf.before-flint.
local   all   all                    peer
host    all   all   ::1/128          scram-sha-256" > "$PG_DATA/pg_hba.conf" || return 1
  print -r -- "# Written by Flint (apps/studio/rebuild.sh).
listen_addresses = '::1'
port = $PG_PORT
unix_socket_directories = '$PG_SOCKET'
password_encryption = 'scram-sha-256'" > "$PG_DATA/flint.conf" || return 1
  grep -q "^include_if_exists = 'flint.conf'" "$PG_DATA/postgresql.conf" || print -r -- "
include_if_exists = 'flint.conf'" >> "$PG_DATA/postgresql.conf" || return 1
  chmod 600 "$PG_DATA/pg_hba.conf" "$PG_DATA/flint.conf"
}
pg_ready() { # [tries]: is the server answering on its socket?
  emulate -L zsh
  local i
  for i in {1..${1:-60}}; do "$TOOL_pg_isready" -q -h "$PG_SOCKET" -p "$PG_PORT" && return 0; sleep 0.5; done
  return 1
}
pg_start() { # <start|restart>
  emulate -L zsh
  if (( REHEARSE )); then
    # LC_ALL=C, as Homebrew's own service sets it: without a valid locale Postgres will not start on a Mac.
    LC_ALL=C "$TOOL_pg_ctl" -D "$PG_DATA" -l "$LOG/postgres.log" -w -t 60 "$1" >"$LOG/pg_ctl.log" 2>&1 || return 1
  else
    brew services "$1" postgresql@17 >"$LOG/brew-services.log" 2>&1 || return 1
  fi
  pg_ready
}
# As this Mac's own login over the socket: no password is typed, passed or printed.
pg_admin() { "$TOOL_psql" -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -U "$ME" -d postgres "$@" 2>>"$LOG/psql.err"; }

fresh_cluster=0
if [[ ! -f $PG_DATA/PG_VERSION ]]; then
  LC_ALL=C "$TOOL_initdb" -D "$PG_DATA" --locale=C -E UTF-8 >"$LOG/initdb.log" 2>&1 || refuse "Flint could not make the database server's data folder. The details are in $LOG/initdb.log."
  fresh_cluster=1
fi
[[ "$(<"$PG_DATA/PG_VERSION")" == 17 ]] || refuse "The database server on this Mac is not Postgres 17, so Flint stopped. Nothing was changed."
if (( fresh_cluster )); then
  pg_conf || refuse "Flint could not write the database server's settings."
  pg_start start || refuse "The database server did not start. The details are in $LOG."
elif [[ -f $PG_DATA/flint.conf ]]; then
  # Set up by an earlier run of this script.
  pg_ready 4 || pg_start start || refuse "The database server did not start. The details are in $LOG."
else
  # A database server that was here first. Flint looks before it touches anything.
  pg_ready 4 || pg_start start || refuse "The database server on this Mac did not start, so Flint stopped. Nothing was changed."
  others="$(pg_admin -c "SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")" || refuse "Flint could not ask the database server on this Mac what it holds, so it stopped. Nothing was changed."
  if [[ $others == 0 ]]; then
    pg_conf || refuse "Flint could not write the database server's settings."
    pg_start restart || refuse "The database server did not start. The details are in $LOG."
  else
    say "This Mac's database server already holds other databases, so Flint left its settings alone."
  fi
fi
# (The same for the refusal below: a rehearsal can be told to pretend its scratch Mac already has a Flint database.)
if (( REHEARSE )) && [[ ${FLINT_REHEARSAL_EXISTING:-} == database ]]; then pg_admin -c 'CREATE DATABASE flint' >/dev/null; fi
if (( ! RESUME )); then
  held="$(pg_admin -c "SELECT count(*) FROM pg_database WHERE datname = 'flint'")" || refuse "Flint could not ask the database server what it holds, so it stopped. Nothing was changed."
  [[ $held == 0 ]] || refuse "This Mac already has a Flint database. Nothing was changed. A rebuild never replaces a database: to put a backup back into it, see docs/RECOVERY.md."
fi
timed database-server

# ---- 2. Flint's files --------------------------------------------------------------------
# From here the Mac changes. The marker lets this same command be run again if it stops part-way.
stamp="$(date +%Y%m%d-%H%M%S)"
if (( RESUME )); then
  say "An earlier rebuild stopped part-way on this Mac. Flint is starting it over."
  rm -rf "${DATA:?}"
elif ! empty_or_absent "$DATA"; then
  mv "$DATA" "$DATA.before-rebuild-$stamp" || refuse "Flint could not set the existing data folder aside, so it stopped."
  say "The Flint data that was here is kept in ${DATA:t}.before-rebuild-$stamp."
fi
mkdir -p -m 700 "$DATA" && chmod 700 "$DATA" && : > "$MARKER" || refuse "Flint could not make its data folder."
# The same list of secret-bearing names the backup leaves out: a file of that kind is never
# unpacked, even from an archive that somehow carries one.
secret_names=("${(@f)$(FLINT_BACKUP_DEFINE_ONLY=1 /bin/zsh -c 'source "$1" && print -rl -- "${SECRETS[@]}"' _ "$HERE/backup_flint.sh" 2>/dev/null)}")
(( ${#secret_names} >= 20 )) || refuse "Flint could not read its own list of secret files, so it stopped before unpacking anything."
( umask 077; /usr/bin/tar -xzf "$BUNDLE/files.tar.gz" -C "$DATA" "${secret_names[@]}" ) >/dev/null 2>"$LOG/unpack.err" \
  || refuse "The files backup did not unpack. The details are in $LOG/unpack.err."
# Nothing from a backup is run, and nothing in it points outside its folder.
find "$DATA" -type l -delete 2>/dev/null
find "$DATA" -type f -perm +111 -exec chmod a-x {} + 2>/dev/null
chmod -R go-rwx "$DATA" 2>/dev/null
# This Mac's own state, which the old Mac's copy would only confuse: what is deployed, what is
# built, and the approval key that lived in the old Mac's hardware.
for stale in runtime/current runtime/migrate-failed runtime-held deploy-retry deploy-hold deploy-events.jsonl \
  app-installed-tree app-failed-tree app-notified-tree app-pid calendar-installed-tree calendar-failed-tree \
  approval-key.se tailscale-url.txt tailscaled.sock server.mjs.prev console.html.prev; do
  rm -rf "${DATA:?}/${stale:?}"
done
# Connectors are code. The restored bundles are removed; the ones this repo has source for are rebuilt below.
restored_connectors=() dropped_connectors=()
for f in "$DATA"/connectors/*(DN); do
  name=${f:t}
  if [[ $name =~ '^([a-z0-9-]+-server)\.mjs$' && -f $REPO/packages/mcp/connectors/$match[1].ts ]]; then restored_connectors+=("$match[1]")
  elif [[ $name == *.mjs ]]; then dropped_connectors+=("${name%.mjs}"); fi
  rm -rf "${f:?}"
done
rm -f "$DATA"/server.mjs "$DATA"/ask.mjs
say "Your memory, history and Flint's own files are back from the backup."
restored=$(( ${#SET_SECRETS} + ${#SET_OVERRIDE} + ${#SET_BACKUP} + ${#SET_SERVER} + ${#SET_OLLAMA} ))
if (( have_snapshot )); then
  say "Flint put back $restored of your settings."
else
  say "This backup was made before Flint saved your settings, so they start at their defaults."
fi
timed files

# ---- 3. new secrets ------------------------------------------------------------------------
(
  umask 077
  {
    print -r -- "# Written by apps/studio/rebuild.sh. Flint's own secrets here are new; none came from a backup."
    for kv in $SET_SECRETS; do [[ $kv == FLINT_RUNTIME_URL=* ]] || print -r -- "$kv"; done
    print -r -- "FLINT_RUNTIME_URL=http://[::1]:$RUNTIME_PORT"
    token="$("$TOOL_openssl" rand -hex 32)"
    [[ $token =~ '^[0-9a-f]{64}$' ]] || exit 1
    print -r -- "FLINT_TOKEN=$token"
  } > "$DATA/secrets.env"
) || refuse "Flint could not make its new access token."
chmod 600 "$DATA/secrets.env"
if (( ${#SET_OVERRIDE} )); then
  ( umask 077; print -rl -- $SET_OVERRIDE > "$DATA/runtime.override.env" ) && chmod 600 "$DATA/runtime.override.env" || refuse "Flint could not write your runtime settings."
fi
say "Flint made itself a new access token. The old Mac's no longer works."
timed secrets

# ---- 4. the database ---------------------------------------------------------------------------
bootstrap_args=(--port "$PG_PORT")
(( RESUME )) && bootstrap_args+=(--rotate)
( cd "$REPO" && PGHOST="$PG_SOCKET" PGPORT="$PG_PORT" PGUSER="$ME" PGDATABASE=postgres pnpm --silent --filter @flint/runtime bootstrap-db "${bootstrap_args[@]}" ) 2>"$LOG/bootstrap-db.err" \
  || refuse "Flint could not set up its database. The details are in $LOG/bootstrap-db.err."
if (( ${#SET_BACKUP} )); then
  ( umask 077; print -rl -- $SET_BACKUP >> "$DATA/backup.env" ) && chmod 600 "$DATA/backup.env" || refuse "Flint could not write your backup settings."
fi
if [[ -n $BUNDLE_DUMP ]]; then
  ( cd "$REPO" && pnpm --silent --filter @flint/runtime restore-empty --dump "$BUNDLE_DUMP" ) 2>"$LOG/restore.err" \
    || refuse "The database backup did not restore. The details are in $LOG/restore.err."
else
  say "No database backup was restored, so Flint starts with an empty database."
fi
timed database

# ---- 5. the LaunchAgents the repo could not make before, from their templates ------------------
mkdir -p "$AGENTS" || refuse "Flint could not make the LaunchAgents folder."
[[ $HOME != *[\<\>\&\"\'\\]* ]] || refuse "This Mac's home folder has a character in its name that a LaunchAgent file cannot hold."
render_template "$HERE/templates/com.flint.server.plist.tmpl" "$AGENTS/com.flint.server.plist" NODE="$TOOL_node" NODE_DIR="${TOOL_node:h}" HOME="$HOME" PORT="$SERVER_PORT" || exit 1
render_template "$HERE/templates/com.flint.ollama.plist.tmpl" "$AGENTS/com.flint.ollama.plist" OLLAMA="$OLLAMA_BIN" HOME="$HOME" || exit 1
render_template "$HERE/templates/com.flint.tailscaled.plist.tmpl" "$AGENTS/com.flint.tailscaled.plist" TAILSCALED="$TAILSCALED_BIN" HOME="$HOME" || exit 1
for kv in $SET_SERVER; do plist_set_env "$AGENTS/com.flint.server.plist" "${kv%%=*}" "${kv#*=}" || refuse "A restored setting could not be written into the server's LaunchAgent."; done
for kv in $SET_OLLAMA; do plist_set_env "$AGENTS/com.flint.ollama.plist" "${kv%%=*}" "${kv#*=}" || refuse "A restored setting could not be written into the local model's LaunchAgent."; done
if (( REHEARSE )); then
  # The rehearsal's server answers on its own ports, asks no real model, and leaves the calendar watcher off.
  plist_set_env "$AGENTS/com.flint.server.plist" OLLAMA_HOST "http://127.0.0.1:9"
  plist_set_env "$AGENTS/com.flint.server.plist" FLINT_INTERNAL_PORT "$INTERNAL_PORT"
  plist_set_env "$AGENTS/com.flint.server.plist" FLINT_WATCHER off
  # ...and its runtime calls back to the rehearsal's server, never the real one.
  mkdir -p "$SCRATCH/state/overrides"
  print -r -- "SERVER_INTERNAL_URL=http://[::1]:$INTERNAL_PORT" > "$SCRATCH/state/overrides/com.flint.runtime.env"
fi
# The LaunchAgent files kept in the repo, with this Mac's home folder in them.
typeset -a LOAD_NOW LOAD_LAST
while read -r label how source load rest; do
  [[ -z $label || $label == \#* ]] && continue
  [[ $how == file && $load == (load|last) ]] || continue
  text="$(<"$REPO/$source")" || refuse "The LaunchAgent file for $label is missing from the repo."
  ( umask 077; print -r -- "${text//\/Users\/willfoti/$HOME}" > "$AGENTS/$label.plist" ) && "$TOOL_plutil" -lint "$AGENTS/$label.plist" >/dev/null 2>&1 \
    || refuse "The LaunchAgent file for $label is not valid."
  if [[ $load == last ]]; then LOAD_LAST+=("$label"); else LOAD_NOW+=("$label"); fi
done < "$AGENTS_MANIFEST"
for plist in "$AGENTS"/com.flint.*.plist(N); do
  "$TOOL_plutil" -lint "$plist" >/dev/null 2>&1 || refuse "The LaunchAgent file ${plist:t} is not valid."
  chmod 600 "$plist"
done
say "Flint's LaunchAgents are written from the repo."
timed agents

load_agent() { # real mode only: load one LaunchAgent into this login session
  launchctl bootout "gui/$UID/$1" >/dev/null 2>&1
  launchctl bootstrap "gui/$UID" "$AGENTS/$1.plist" >/dev/null 2>&1 || launchctl kickstart -k "gui/$UID/$1" >/dev/null 2>&1
}

# ---- 6. remote access (the real rebuild only) ---------------------------------------------------
REMOTE_DONE=1
if (( ! REHEARSE )); then
  load_agent com.flint.ollama || say "The local model's server did not load. Flint goes on without it."
  load_agent com.flint.tailscaled || say "Tailscale's daemon did not load. Flint goes on without remote access."
  for i in {1..20}; do [[ -S $DATA/tailscaled.sock ]] && break; sleep 0.5; done
  say "Open the link below on any device and sign in to Tailscale. Flint waits up to 10 minutes."
  if "$TAILSCALE_BIN" --socket "$DATA/tailscaled.sock" up --timeout=10m && /bin/zsh "$HERE/finish-tailscale.sh" >"$LOG/finish-tailscale.log" 2>&1; then
    say "Your phone and MacBook can reach Flint on this Mac again."
  else
    REMOTE_DONE=0
    say "Remote access is not set up yet. Flint goes on, and the last lines below say how to finish it."
  fi
fi

# ---- 7. build and start Flint with the real installers ------------------------------------------
esbuild="$(find "$REPO/node_modules/.pnpm" -path '*esbuild*/bin/esbuild' -type f 2>/dev/null | head -1)"
for name in $restored_connectors; do
  mkdir -p "$DATA/connectors"
  [[ -n $esbuild ]] && "$esbuild" "$REPO/packages/mcp/connectors/$name.ts" --bundle --platform=node --format=esm --target=node20 \
    --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
    --outfile="$DATA/connectors/$name.mjs" --log-level=error >"$LOG/connector-$name.log" 2>&1 \
    || say "The connector $name could not be rebuilt from the repo, so it is left out."
done
# The code being installed is what was already live, so its gate (typecheck and tests) is not run
# again here; the deploy job runs it on the next change, as always.
install_env=(FLINT_SKIP_TESTS=1 "PORT=$SERVER_PORT" "RUNTIME_PORT=$RUNTIME_PORT")
( cd "$REPO" && env "${install_env[@]}" ./apps/runtime/install-runtime.sh ) >"$LOG/install-runtime.log" 2>&1 \
  || refuse "The runtime did not come up. The details are in $LOG/install-runtime.log."
say "Flint's runtime is built and answering."
( cd "$REPO" && env "${install_env[@]}" ./apps/server/install-server.sh ) >"$LOG/install-server.log" 2>&1 \
  || refuse "The server did not come up. The details are in $LOG/install-server.log."
say "Flint's server is built and answering."
timed install

# ---- 8. check it -------------------------------------------------------------------------------
"$TOOL_curl" -fsS -m 5 "http://[::1]:$SERVER_PORT/health" 2>/dev/null | grep -q '"ok":true' || refuse "The server stopped answering after it was installed."
"$TOOL_curl" -fsS -m 5 "http://[::1]:$RUNTIME_PORT/health" 2>/dev/null | grep -q '"ok":true' || refuse "The runtime stopped answering after it was installed."
env_value "$DATA/secrets.env" FLINT_DB_OWNER_URL || refuse "The database's settings are missing after the install."
( cd "$REPO/apps/runtime" && DATABASE_URL="$REPLY" PRISMA_HIDE_UPDATE_MESSAGE=1 ./node_modules/.bin/prisma migrate status ) >"$LOG/migrate-status.log" 2>&1 \
  || refuse "The database is not up to date after the install. The details are in $LOG/migrate-status.log."
for f in "$DATA"/*.env(N) "$DATA"/tokens/*(N); do
  private "$f" || refuse "A settings file in Flint's data folder can be read by others on this Mac: ${f:t}."
done
say "Flint answers on this Mac, and its database is up to date."
timed checks

# ---- 9. the approval key --------------------------------------------------------------------------
# The old Mac's key lived in its hardware and is gone with it. This code registers a new one and
# revokes every old one. It is shown once, to you; a rehearsal makes it and never shows it.
if (( REHEARSE )); then
  ( cd "$REPO" && pnpm --silent --filter @flint/runtime enroll --replace ) >/dev/null 2>"$LOG/enroll.err" || refuse "The rehearsal could not make an enrolment code."
  [[ -f $DATA/enroll-code ]] && private "$DATA/enroll-code" || refuse "The enrolment code was not saved safely."
else
  say "Your approval key lived in the old Mac. Open Flint on this Mac, go to Settings and then Approval Key, and enter this code:"
  ( cd "$REPO" && pnpm --silent --filter @flint/runtime enroll --replace ) 2>"$LOG/enroll.err" \
    || { say "Flint could not make an enrolment code. Make one later with:"; say "  cd ~/flint && pnpm --filter @flint/runtime enroll --replace"; }
fi

# ---- 10. the rest of the agents (the real rebuild only), and what is left for you ------------------
if (( ! REHEARSE )); then
  /bin/zsh "$HERE/install_searxng.sh" >"$LOG/install-searxng.log" 2>&1 || say "Keyless web search did not install. Flint works without it."
  for label in $LOAD_NOW $LOAD_LAST; do load_agent "$label" || say "The agent $label did not load."; done
fi
# The rebuild is whole: the marker goes, and so do the opened copy of the backups and the rebuild's logs.
rm -f "$MARKER"
(( REHEARSE )) || rm -rf "${BUNDLE:?}" "${LOG:?}"

embed=nomic-embed-text
for kv in $SET_SECRETS; do [[ $kv == FLINT_EMBED_MODEL=* ]] && embed=${kv#*=}; done
say "Flint does not download models. Run these on this Mac, one at a time:"
say "  ollama pull $MODEL"
say "  ollama pull $embed"

typeset -A WHERE_TO
WHERE_TO=(
  Anthropic      "Anthropic: revoke the old key at console.anthropic.com under API Keys, and add a new one only if you still use it."
  OpenAI         "OpenAI: revoke the old key at platform.openai.com under API keys, and add a new one only if you still use it."
  Google-AI      "Google AI: revoke the old key at aistudio.google.com under API keys, and add a new one only if you still use it."
  Perplexity     "Perplexity: revoke the old key in Perplexity's settings under API, and add a new one only if you still use it."
  Tavily         "Tavily: revoke the old key at app.tavily.com under API Keys, and add a new one only if you still use it."
  Nexus          "Nexus: revoke the old Mac's tokens in Nexus, and give this Mac new ones."
  Phone-Pings    "Phone pings: choose a new topic name in the phone's notification app, and set the same name in Flint."
  GitHub-App     "GitHub: remove the old private key of the flint-observer app under Developer settings, and make a new one."
  Google         "Google Calendar: remove the old Mac under Third-party access at myaccount.google.com, then sign in again from Flint."
  Tailscale      "Tailscale: remove the old Mac under Machines in the Tailscale admin page."
  Approval-Key   "Approval key: the enrolment code registers this Mac's key and revokes the old one."
  Connectors     "Connectors: the list of connectors holds keys, so it was never backed up. It needs writing again."
)
outside=()
if (( have_snapshot )); then outside=(${(u)PRESENT}); else outside=(Tailscale Approval-Key Connectors Google Nexus); fi
(( ${#outside} )) && say "These were never in a backup, because Flint does not back up a key or a sign-in. Each needs you once:"
for o in $outside; do [[ -n ${WHERE_TO[$o]:-} ]] && say "  ${WHERE_TO[$o]}"; done
(( ${#CONNECTORS} )) && say "The connectors that were set up on the old Mac: ${(j:, :)CONNECTORS}."
(( ${#dropped_connectors} )) && say "Flint left out ${#dropped_connectors} connector(s) it has no source for: ${(j:, :)dropped_connectors}."
(( ${#NOT_RESTORED} )) && say "Flint did not put back ${#${(u)NOT_RESTORED}} setting(s) it does not know or could not check: ${(j:, :)${(u)NOT_RESTORED}}."
if (( ! REHEARSE && ! REMOTE_DONE )); then
  say "To finish remote access, run these three on this Mac, one at a time:"
  say "  tailscale --socket ~/.flint/tailscaled.sock up"
  say "  ~/flint/apps/studio/finish-tailscale.sh"
  say "  ~/flint/apps/runtime/install-runtime.sh"
fi

if (( REHEARSE )); then
  total=0
  for row in $STEP_TIMES; do total=$(( total + ${row#*$'\t'} )); done
  {
    print -r -- "pg_port"$'\t'"$PG_PORT"; print -r -- "pg_socket"$'\t'"$PG_SOCKET"
    print -r -- "server_port"$'\t'"$SERVER_PORT"; print -r -- "runtime_port"$'\t'"$RUNTIME_PORT"; print -r -- "internal_port"$'\t'"$INTERNAL_PORT"
    for row in $STEP_TIMES; do print -r -- "seconds_$row"; done
    print -r -- "seconds_total"$'\t'"$(printf '%.1f' $total)"
  } > "$SCRATCH/report.tsv"
  say "The rehearsal passed in $(printf '%.0f' $total) seconds: the backups opened, the files and the database came back and passed their checks, and both services answered."
  if (( KEEP_RUNNING )); then
    say "The rehearsal is left running. Stop and remove it with this command:"
    say "  ${(q-)SELF} --stop ${(q-)SCRATCH}"
  fi
else
  say "Flint is rebuilt on this Mac."
fi
exit 0
