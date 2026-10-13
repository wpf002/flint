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
#                                            runs it every week, and in every deploy
#                                            that changes what a rebuild is made of.
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
# opened copy is removed when the rebuild ends. A backup is encrypted, not
# signed: whoever can write to the offsite folder can put a file there that
# opens with your key. So nothing from a backup is trusted to be what Flint
# wrote:
#   - only the folders that hold your data are unpacked, by name (UNPACK below).
#     Everything else in the archive stays in it: settings files, connector
#     lists, tokens, code, whatever case their names are written in;
#   - settings are read as text and checked one by one against
#     settings.manifest; scripts lose their execute bit; links are dropped;
#     connectors are rebuilt from this repo;
#   - the key future backups are encrypted to is worked out from YOUR key on the
#     MacBook, never read from the backup;
#   - the database is restored by a role that owns nothing else, compared with a
#     database built from this repo's migrations, and only then put into use
#     (apps/runtime, restore.ts).
# A rebuild never replaces a Flint database that is already there (that is
# `restore-production`, docs/RECOVERY.md). Every line this prints is a sentence;
# no secret is ever printed (one exception, by design: the one-time code for
# enrolling your approval key).
set -u
setopt pipefail
umask 077   # everything this makes is its owner's alone unless it says otherwise

NODE_VERSION="v24.15.0"   # matches the PATH baked into the repo's LaunchAgent files

# ==== the toolchain: runs on the new Mac before the repo is there, so it stands alone ====
# checkout_deployed <checkout> [<commit> [<commit>]]: set Flint's code to the commit the old Mac was
# running: the later of the ones the backup names, when main holds any of them; otherwise main's
# newest, which is then tested before it is installed. A checkout with changes of its own (files
# changed, or commits main does not have) is left exactly as it is, and that is a refusal.
#
# The backup's word for which commit that was is only a line in an archive, and the commit it
# names is the one whose rebuild then unpacks and restores that same archive. So a named commit is
# used only when everything a rebuild is made of (RECOVERY_CODE) is the same in it as in main's
# newest: otherwise a backup could ask for an old commit and with it undo every later fix to the
# unpacking, the restore or the rules. Then main's newest is used instead, and tested first.
RECOVERY_CODE=(apps/studio apps/runtime/src/backup apps/runtime/scripts apps/runtime/install-runtime.sh apps/server/install-server.sh packages/policy)
checkout_deployed() {
  emulate -L zsh
  local dir=$1 want= sha when
  git -C "$dir" fetch --quiet origin main || { print -r -- "Flint's code could not be brought up to date."; return 1; }
  if [[ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]] || ! git -C "$dir" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    print -r -- "The flint folder on the new Mac has changes of its own, so Flint left it alone and stopped. Nothing was changed."
    return 1
  fi
  for sha in "${2:-}" "${3:-}"; do
    [[ $sha =~ '^[0-9a-f]{40}$' ]] && git -C "$dir" merge-base --is-ancestor "$sha" origin/main 2>/dev/null || continue
    if [[ -z $want ]] || git -C "$dir" merge-base --is-ancestor "$want" "$sha" 2>/dev/null; then want=$sha; fi
  done
  [[ -n $want ]] && when="$(git -C "$dir" show -s --format=%cd --date=format:%Y-%m-%d "$want" 2>/dev/null)"
  [[ ${when:-} =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]] || when=
  if [[ -n $want ]] && ! git -C "$dir" diff --quiet "$want" origin/main -- "${RECOVERY_CODE[@]}" 2>/dev/null; then
    git -C "$dir" checkout --quiet -B main origin/main || { print -r -- "Flint's code could not be brought up to date."; return 1; }
    print -r -- "The way Flint rebuilds has changed since the version the old Mac was running${when:+, which is from $when}, so Flint uses the newest and tests it before installing it."
  elif [[ -n $want ]]; then
    git -C "$dir" checkout --quiet -B main "$want" || { print -r -- "Flint's code could not be set to the version the old Mac was running."; return 1; }
    print -r -- "Flint's code is the version the old Mac was running${when:+, from $when}."
  else
    git -C "$dir" checkout --quiet -B main origin/main || { print -r -- "Flint's code could not be brought up to date."; return 1; }
    print -r -- "The backup does not say which version the old Mac was running, so Flint uses the newest and tests it before installing it."
  fi
}
# (For the test of that alone: it needs no Mac set up, only a checkout.)
if [[ ${1:-} == --checkout-deployed ]]; then checkout_deployed "${2:-}" "${3:-}" "${4:-}"; exit $?; fi

# toolchain <repo address> [<commit> [<commit>]]: what Flint runs on, and Flint's code at the
# commit the old Mac was running. It never resets or overwrites a checkout that is already there
# with changes of its own.
toolchain() {
  emulate -L zsh
  local repo_url=${1:-https://github.com/wpf002/flint.git} formula
  [[ $repo_url =~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' ]] || { print -r -- "That is not a GitHub address Flint can clone from."; return 1; }
  [[ "$(uname -s)" == Darwin ]] || { print -r -- "Flint rebuilds only onto a Mac."; return 1; }
  if ! command -v brew >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/brew ]]; then
    print -r -- "Installing Homebrew needs the new Mac's password once."
    sudo -v || { print -r -- "Flint could not get permission to install Homebrew."; return 1; }
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1
    # The download can fail and leave bash with nothing to run, which is not an error to bash.
    [[ -x /opt/homebrew/bin/brew ]] || command -v brew >/dev/null 2>&1 || { print -r -- "Homebrew did not install. Install it from brew.sh and run this again."; return 1; }
  fi
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)"
  print -r -- "Flint is installing what it runs on. This takes a few minutes."
  for formula in git postgresql@17 ollama tailscale age uv; do
    brew list --formula "$formula" >/dev/null 2>&1 || brew install --quiet "$formula" >/dev/null 2>&1 \
      || { print -r -- "The package $formula did not install. Run this to see why:"; print -r -- "  brew install $formula"; return 1; }
  done
  export NVM_DIR="$HOME/.nvm"
  [[ -s $NVM_DIR/nvm.sh ]] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh 2>/dev/null | PROFILE=/dev/null bash >/dev/null 2>&1
  [[ -s $NVM_DIR/nvm.sh ]] || { print -r -- "Node's installer did not finish. Check the new Mac's internet connection and run this again."; return 1; }
  source "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION" >/dev/null 2>&1 && nvm alias default "$NODE_VERSION" >/dev/null 2>&1 && nvm use "$NODE_VERSION" >/dev/null 2>&1 \
    || { print -r -- "Node $NODE_VERSION did not install."; return 1; }
  corepack enable >/dev/null 2>&1 || true
  if [[ ! -d $HOME/flint/.git ]]; then
    git clone --quiet "$repo_url" "$HOME/flint" || { print -r -- "Flint's code could not be downloaded."; return 1; }
  fi
  checkout_deployed "$HOME/flint" "${2:-}" "${3:-}" || return 1
  ( cd "$HOME/flint" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile >/dev/null 2>&1 ) \
    || { print -r -- "Flint's code downloaded, and its packages did not install."; return 1; }
  print -r -- "The new Mac has what Flint runs on, and Flint's code."
}
if [[ ${1:-} == --toolchain ]]; then toolchain "${2:-}" "${3:-}" "${4:-}"; exit $?; fi

SELF=${0:A}
HERE=${0:A:h}
REPO=${HERE:h:h}
source "$HERE/recovery_lib.sh"
QUIET="$REPO/test-support/quiet-bin"
STANDINS="$HERE/rehearsal"
TMP="${${TMPDIR:-/tmp}%/}"
TMP=${TMP:A}

# ==== arguments ====
MODE= ARG= OFFSITE= KEY= GIVEN_BUNDLE= MODEL= WITHOUT_DB=0 REPLACE=0 KEEP_RUNNING=0 VIA_TO=0
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
    --from-another-mac) VIA_TO=1; shift ;;   # --to adds it: what this prints is read on the MacBook's screen
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
  # :A, not :a: a link in the way is followed, so two names for one folder compare equal.
  REPLY=${REPLY:A}
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
  # Said before the wait, which can be long: nothing else is printed until the file is here or the wait is over.
  local minutes=$(( (wait + 59) / 60 ))
  say "A backup has not come down from iCloud yet. Flint asked for it and is waiting, for up to $minutes minute$( (( minutes == 1 )) || print -n s)."
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
    rm -f "$errf"
    chmod 600 "$3.partial" && mv -f "$3.partial" "$3" && return 0
    rm -f "$3.partial"; return 3
  fi
  rm -f "$3.partial"
  if grep -q 'no identity matched' "$errf" 2>/dev/null; then rm -f "$errf"; return 2; fi
  rm -f "$errf"; return 3
}

# Every member of a files archive must stay inside the folder it is unpacked
# into: a plain file, a folder or a link, never a path that climbs out, and
# never a path that passes through a link the same archive carries (the way an
# archive writes outside its folder). Names are compared as the disk will see
# them: `./a`, `a` and `a/` are one name, and so are `MCP.json` and `mcp.json`
# (this disk does not tell upper case from lower), so an archive that holds two
# names for one place is refused. Links themselves are dropped after unpacking.
# An archive larger than any backup of Flint's could be is refused too.
# On success ARCHIVE_NAMES holds its members' names (as the disk will see them,
# in their own case) and ARCHIVE_BYTES what they add up to unpacked.
ARCHIVE_MAX_BYTES=$(( 200 * 1024 * 1024 * 1024 ))   # unpacked; the adapters are the bulk of a real one
ARCHIVE_MAX_FILES=2000000
typeset -ga ARCHIVE_NAMES
ARCHIVE_BYTES=0
archive_is_safe() {
  emulate -L zsh
  local -a kinds names links fields
  local -A seen
  local i link name total=0 size
  ARCHIVE_NAMES=() ARCHIVE_BYTES=0
  # Owners as numbers: a name is the archive's own words, and one with a space in it would shift every column after it.
  kinds=("${(@f)$(/usr/bin/tar --numeric-owner -tvzf "$1" 2>/dev/null)}") || return 1
  names=("${(@f)$(/usr/bin/tar -tzf "$1" 2>/dev/null)}") || return 1
  (( ${#names} > 0 && ${#names} == ${#kinds} && ${#names} <= ARCHIVE_MAX_FILES )) || return 1
  for (( i = 1; i <= ${#names}; i++ )); do
    [[ ${kinds[i][1]} == [-dl] ]] || return 1
    [[ ${kinds[i]} == *' link to '* ]] && return 1
    name=${names[i]}
    [[ $name == /* || $name == .. || $name == ../* || $name == */../* || $name == */.. || $name == *$'\n'* ]] && return 1
    # As the disk will see it: no leading ./, no doubled or trailing slash.
    while [[ $name == ./* ]]; do name=${name#./}; done
    while [[ $name == *//* ]]; do name=${name//\/\//\/}; done
    name=${name%/}
    [[ $name == */./* || $name == */. ]] && return 1
    names[i]=$name
    [[ -z $name || $name == . ]] && continue   # the folder itself
    # A folder may be listed more than once; a file or a link may not share its place with anything, in any case.
    if [[ -n ${seen[${name:l}]:-} ]]; then
      [[ ${seen[${name:l}]} == "d $name" && ${kinds[i][1]} == d ]] || return 1
    fi
    seen[${name:l}]="${kinds[i][1]} $name"
    [[ ${kinds[i][1]} == l ]] && links+=("${name:l}")
    if [[ ${kinds[i][1]} == - ]]; then
      fields=(${=kinds[i]})
      # mode, links, owner, group, size: the owner and the group are numbers here, so the fifth column is the size.
      [[ ${fields[3]:-} == <-> && ${fields[4]:-} == <-> ]] || return 1
      size=${fields[5]:-}
      [[ $size == <-> ]] || return 1
      total=$(( total + size ))
    fi
  done
  (( total <= ARCHIVE_MAX_BYTES )) || return 1
  for link in $links; do
    for (( i = 1; i <= ${#names}; i++ )); do
      [[ ${names[i]:l} == $link/* ]] && return 1
    done
  done
  ARCHIVE_NAMES=("${(@)names:#}")
  ARCHIVE_BYTES=$total
  return 0
}

BUNDLE_VERSION=2   # what --unseal writes and --from reads: a folder made by another version is opened again, never guessed at
UNSEALING=         # the folder --unseal is filling, removed if it is interrupted
unseal() { # <offsite folder> <key file> <bundle folder>
  emulate -L zsh
  local offsite=$1 key=$2 bundle=$3 name st when files_from= dump_from= dump_dir counts_note= recipient
  need_tool age "The program age is not installed, and Flint needs it to open a backup. Install it with this command:" "  brew install age"; AGE=$REPLY
  need_tool age-keygen "The program age-keygen is not installed, and Flint needs it to read your backup key. Install it with this command:" "  brew install age"; AGE_KEYGEN=$REPLY
  [[ -f $key && ! -L $key ]] || refuse "The backup key file is not there. Name it with --key, followed by the file."
  [[ -O $key ]] || refuse "The backup key file belongs to someone else on this Mac, so Flint will not use it."
  private "$key" || refuse "Others on this Mac can read your backup key. Fix that first with this command:" "  chmod 600 ${(q-)key}"
  grep -q '^AGE-SECRET-KEY-1' "$key" 2>/dev/null || refuse "That file is not an age key."
  # The public half, worked out from the key itself: what the rebuilt Mac encrypts its backups to.
  # It is never read from a backup, where anyone who can write to the offsite folder could have put their own.
  recipient="$("$AGE_KEYGEN" -y "$key" 2>/dev/null)" && [[ $recipient =~ '^age1[0-9a-z]{50,80}$' ]] || refuse "That file is not an age key."
  [[ -d $offsite ]] || refuse "The backup folder is not there. Check that iCloud Drive is signed in on this Mac, or name the folder with --offsite."
  empty_or_absent "$bundle" || refuse "The folder to open the backups into is not empty. Choose a new one."
  mkdir -p -m 700 "$bundle" && chmod 700 "$bundle" || refuse "Flint could not make the folder to open the backups into."
  # Interrupted part-way, the half-made folder of opened backups goes: they are not encrypted.
  UNSEALING=$bundle

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
    if [[ $st == 0 ]]; then
      if archive_is_safe "$bundle/files.tar.gz"; then files_from=$name; break; fi
      rm -f "$bundle/files.tar.gz"
      say "The files backup from $when holds something a backup of Flint's never does, so Flint did not use it and is using the one before it."
      continue
    fi
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
      print -r -- "version=$BUNDLE_VERSION"
      print -r -- "files=$files_from"
      print -r -- "database=${dump_from:-none}"
      print -r -- "recipient=$recipient"
    } > "$bundle/bundle.info"
    : > "$bundle/MANIFEST.sha256"
    for name in "$bundle"/*(N); do
      [[ ${name:t} == MANIFEST.sha256 ]] && continue
      sha_of "$name" || exit 1
      print -r -- "$REPLY  ${name:t}" >> "$bundle/MANIFEST.sha256"
    done
  ) || { rm -rf "${bundle:?}"; refuse "Flint could not finish the folder of opened backups."; }
  UNSEALING=
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
  local -A listed sums
  [[ -d $bundle && ! -L $bundle && -O $bundle ]] || refuse "The folder of opened backups is not there, or is not yours."
  private "$bundle" || refuse "Others on this Mac can read the folder of opened backups. Open the backups again into a new folder."
  [[ -f $bundle/MANIFEST.sha256 && -f $bundle/bundle.info && -f $bundle/files.tar.gz ]] || refuse "That folder is not one that rebuild.sh --unseal made."
  while IFS= read -r line; do
    [[ $line =~ '^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,120})$' ]] || refuse "The list of opened backups is not readable. Open the backups again."
    sum=$match[1] name=$match[2]
    [[ -f $bundle/$name && ! -L $bundle/$name ]] || refuse "The opened backups are incomplete. Open the backups again."
    sha_of "$bundle/$name" && [[ $REPLY == $sum ]] || refuse "An opened backup has changed since it was opened, so Flint will not restore from it. Open the backups again."
    listed[$name]=1 sums[$name]=$sum
  done < "$bundle/MANIFEST.sha256"
  for name in "$bundle"/*(DN); do
    [[ ${name:t} == MANIFEST.sha256 || -n ${listed[${name:t}]:-} ]] || refuse "The folder of opened backups holds a file that was not there when it was made. Open the backups again."
  done
  [[ -n ${listed[files.tar.gz]:-} && -n ${listed[bundle.info]:-} ]] || refuse "The opened backups are incomplete. Open the backups again."
  env_value "$bundle/bundle.info" version && [[ $REPLY == $BUNDLE_VERSION ]] || refuse "The opened backups were made by another version of this script. Open the backups again."
  env_value "$bundle/bundle.info" recipient && [[ $REPLY =~ '^age1[0-9a-z]{50,80}$' ]] || refuse "The opened backups are incomplete. Open the backups again."
  BUNDLE_RECIPIENT=$REPLY
  # The two backups' own names, for the mark a rebuild leaves while it runs (which backups it was putting back).
  BUNDLE_FILES_NAME=unknown BUNDLE_DB_NAME=none
  env_value "$bundle/bundle.info" files && [[ $REPLY =~ $FILES_NAME ]] && BUNDLE_FILES_NAME=$REPLY
  env_value "$bundle/bundle.info" database || refuse "The opened backups are incomplete. Open the backups again."
  BUNDLE_DUMP= BUNDLE_DUMP_SHA=
  [[ $REPLY =~ $DUMP_NAME ]] && BUNDLE_DB_NAME=$REPLY
  if [[ $REPLY != none ]]; then
    [[ $REPLY =~ $DUMP_NAME && -n ${listed[${REPLY%.age}]:-} ]] || refuse "The opened backups are incomplete. Open the backups again."
    BUNDLE_DUMP="$bundle/${REPLY%.age}"
    # The dump's fingerprint, taken when the MacBook opened it: the restore checks the file against it again.
    BUNDLE_DUMP_SHA=${sums[${REPLY%.age}]}
  fi
}

# ==== --stop: end a rehearsal that was left running, and remove it ====
# The marker a rehearsal leaves in its folder names that folder, so a marker copied or
# planted somewhere else stops nothing. The socket folder it names must be one this
# script makes: directly inside the temp folder, with its own prefix and nothing else.
stop_rehearsal() {
  emulate -L zsh
  local dir=$1 sock marked
  [[ -n $dir && -d $dir && ! -L $dir && -f $dir/.flint-rehearsal && ! -L $dir/.flint-rehearsal && -O $dir/.flint-rehearsal ]] || refuse "That folder is not a Flint rebuild rehearsal, so Flint left it alone."
  marked="$(<"$dir/.flint-rehearsal")"
  [[ $marked == $dir ]] || refuse "That folder is not a Flint rebuild rehearsal, so Flint left it alone."
  FLINT_REHEARSAL_STATE="$dir/state" /bin/zsh "$STANDINS/launchctl" rehearsal-stop-all 2>/dev/null
  if [[ -f $dir/pg/postmaster.pid ]]; then
    need_tool pg_ctl "The program pg_ctl is missing, so Flint could not stop the rehearsal's database."
    "$REPLY" -D "$dir/pg" -m immediate -w -t 20 stop >/dev/null 2>&1
  fi
  if [[ -r $dir/state/socket-dir ]]; then
    sock="$(<"$dir/state/socket-dir")"
    [[ ${sock:h} == $TMP && ${sock:t} =~ '^flint-rh\.[A-Za-z0-9]{6}$' && -d $sock && ! -L $sock && -O $sock ]] && rm -rf "${sock:?}"
  fi
  rm -rf "${dir:?}"
  [[ ! -e $dir ]] || refuse "Flint could not remove the rehearsal's folder."
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
  trap '[[ -n $UNSEALING ]] && rm -rf "${UNSEALING:?}"' EXIT
  trap 'exit 130' INT TERM HUP
  unseal "$OFFSITE" "$KEY" "$bundle"
  say "The opened backups are in ${bundle}. They are not encrypted: remove that folder when the rebuild is done."
  exit 0
fi

# What the new Mac is asked before anything is sent to it. Fixed text, run by /bin/sh there with
# one argument (1 when --replace-existing was given). It prints the Mac's own id and ends with:
#   0 fit for a rebuild; 10 not a Mac; 11 FileVault is off; 12 nobody is logged in at its screen;
#   13 it already has Flint's files; 15 Flint is running on it.
# One line, so that it is one line wherever it is written down. In order: a Mac; its own id; FileVault;
# a login session; a rebuild that stopped part-way here is run again whatever it left (its own marker
# says so); Flint running; Flint's files, unless the owner said to rebuild over them.
REMOTE_PREFLIGHT='[ "$(uname -s)" = Darwin ] || exit 10; id="$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | /usr/bin/awk -F\" "/IOPlatformUUID/ { print \$4 }")"; echo "flint-preflight id=$id"; /usr/bin/fdesetup status 2>/dev/null | /usr/bin/grep -q "FileVault is On" || exit 11; /bin/launchctl print "gui/$(/usr/bin/id -u)" >/dev/null 2>&1 || exit 12; [ -f "$HOME/.flint/.rebuild-in-progress" ] && exit 0; /bin/launchctl list 2>/dev/null | /usr/bin/grep -q "com\.flint\." && exit 15; if [ "$1" != 1 ]; then [ -e "$HOME/.flint" ] && exit 13; ls "$HOME/Library/LaunchAgents"/com.flint.*.plist >/dev/null 2>&1 && exit 13; fi; exit 0'

# The commits the old Mac was running, as its nightly backup wrote them into the settings snapshot
# (settings_manifest.sh): up to two, each checked for shape. Nothing else is read from the archive here.
deployed_commits() { # <files archive>: the commits in REPLY, space-separated (empty when the backup names none)
  emulate -L zsh
  local kind what sha rest
  local -a found
  /usr/bin/tar -xzOf "$1" ./settings-snapshot.tsv 2>/dev/null | while IFS=$'\t' read -r kind what sha rest; do
    [[ $kind == deployed && $what == (server|runtime) && $sha =~ '^[0-9a-f]{40}$' && -z $rest ]] && found+=("$sha")
  done
  REPLY="${(j: :)${(u)found}}"
}

if [[ $MODE == to ]]; then
  # The MacBook's half: ask the new Mac whether it is fit, open the backups here, send the opened
  # copies, rebuild there. The key is never sent, and nothing is sent to a Mac that is not fit.
  target=$ARG
  [[ $target =~ '^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$' ]] || refuse "Name the new Mac as you@its-name, for example willfoti@new-studio.local."
  [[ -n $OFFSITE ]] || { default_offsite; OFFSITE=$REPLY; }
  [[ -n $KEY ]] || { default_key; KEY=$REPLY; }
  work="$(mktemp -d "$TMP/flint-rebuild.XXXXXX")" || refuse "Flint could not make a working folder."
  chmod 700 "$work"
  # The connection's own socket: its path must be short, and the temp folder's is not.
  ctl="$(mktemp -d /tmp/flint-ssh.XXXXXX)" || refuse "Flint could not make a working folder."
  chmod 700 "$ctl"
  ssh_opts=(-o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$ctl/%C" -o ControlPersist=900)
  sent=0 finished=0
  cleanup_to() {
    # The opened backups are not encrypted: they leave the new Mac again unless the rebuild there finished
    # (which removes them itself), and they always leave this one.
    if (( sent && ! finished )); then
      ssh "${ssh_opts[@]}" -- "$target" 'rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh' >/dev/null 2>&1 \
        || say "The opened backups may still be in the folder flint-rebuild-bundle in the new Mac's home folder. Running this again removes them first."
    fi
    ssh "${ssh_opts[@]}" -O exit -- "$target" >/dev/null 2>&1
    rm -rf "${work:?}" "${ctl:?}"
  }
  trap cleanup_to EXIT
  trap 'exit 130' INT TERM HUP
  # This Mac stays awake for as long as this runs: a rebuild is long, and a sleeping MacBook drops the connection.
  [[ -x /usr/bin/caffeinate ]] && /usr/bin/caffeinate -ims -w $$ >/dev/null 2>&1 &!

  say "Flint is connecting to the new Mac. Enter that Mac's password when it asks."
  replace_word=0; (( REPLACE )) && replace_word=1
  answer="$(ssh "${ssh_opts[@]}" -- "$target" "/bin/sh -c ${(q-)REMOTE_PREFLIGHT} flint-preflight $replace_word")"; st=$?
  case $st in
    0) ;;
    10) refuse "Flint rebuilds only onto a Mac. Nothing was sent." ;;
    11) refuse "FileVault is off on the new Mac, and a rebuild puts your memory and history on its disk. Turn FileVault on there in System Settings, then run this again. Nothing was sent." ;;
    12) refuse "Log in at the new Mac's own screen first, and leave it logged in. Flint runs in your login session. Nothing was sent." ;;
    13) refuse "That Mac already has Flint's files. Nothing was sent, and nothing there was changed. A rebuild is for a new Mac: to rebuild over what is there, add --replace-existing." ;;
    15) refuse "Flint is running on that Mac, so it is not a new Mac. Nothing was sent, and nothing there was changed." ;;
    *) refuse "Flint could not reach the new Mac. Turn on Remote Login there (System Settings, General, Sharing), check its name, and run this again. Nothing was sent." ;;
  esac
  [[ $answer =~ 'flint-preflight id=([A-Za-z0-9-]{8,64})' ]] || refuse "Flint could not check the new Mac, so it sent nothing."
  their_id=$match[1]
  my_id="$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | /usr/bin/awk -F'"' '/IOPlatformUUID/ { print $4 }')"
  [[ $their_id != $my_id ]] || refuse "That is this Mac. Name the new Mac. Nothing was changed."

  unseal "$OFFSITE" "$KEY" "$work/bundle"
  repo_url="$(git -C "$REPO" remote get-url origin 2>/dev/null)" || repo_url=
  [[ $repo_url =~ '^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$' ]] || repo_url=https://github.com/wpf002/flint.git
  deployed_commits "$work/bundle/files.tar.gz"; commits=(${=REPLY})
  # A folder left there by an earlier try is this script's own, and goes first.
  ssh "${ssh_opts[@]}" -- "$target" 'rm -rf flint-rebuild-bundle flint-rebuild-toolchain.sh && mkdir -m 700 flint-rebuild-bundle' \
    || refuse "Flint could not make a folder for the backups on the new Mac. Nothing was sent."
  sent=1
  files=("$work/bundle"/*(DN))
  # ${target}, in braces: a bare $target:f... would be read by zsh as a modifier on the name.
  scp -q "${ssh_opts[@]}" -- "${files[@]}" "${target}:flint-rebuild-bundle/" || refuse "The backups did not reach the new Mac. Nothing there was changed."
  scp -q "${ssh_opts[@]}" -- "$SELF" "${target}:flint-rebuild-toolchain.sh" || refuse "The backups did not reach the new Mac. Nothing there was changed."
  say "The backups are on the new Mac. Flint is setting it up."
  toolchain_args=("$repo_url" "${commits[@]}")
  quoted_toolchain=(${(q-)toolchain_args})
  ssh -t "${ssh_opts[@]}" -- "$target" "/bin/zsh flint-rebuild-toolchain.sh --toolchain ${(j: :)quoted_toolchain}; st=\$?; rm -f flint-rebuild-toolchain.sh; exit \$st" \
    || refuse "The new Mac could not be set up. What it printed above says why. Running this command again starts it over."
  remote_args=(--from flint-rebuild-bundle --from-another-mac)
  [[ -n $MODEL ]] && remote_args+=(--model "$MODEL")
  (( REPLACE )) && remote_args+=(--replace-existing)
  (( WITHOUT_DB )) && remote_args+=(--without-database)
  # Each word quoted on its own, then joined: the new Mac's shell sees the same words this one does.
  quoted_args=(${(q-)remote_args})
  ssh -t "${ssh_opts[@]}" -- "$target" "/bin/zsh flint/apps/studio/rebuild.sh ${(j: :)quoted_args}" \
    || refuse "The rebuild stopped before it finished. What it printed above says why. Running this command again starts it over."
  finished=1
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
  # A rehearsal starts from an empty scratch folder, so there is nothing to rebuild over, unless it
  # was told to pretend there is (FLINT_REHEARSAL_EXISTING, which only the tests set).
  (( ! REPLACE )) || [[ -n ${FLINT_REHEARSAL_EXISTING:-} ]] || refuse "A rehearsal always starts from an empty scratch folder, so --replace-existing does not apply to it."
  for tool in node pnpm; do
    need_tool $tool "The program $tool is not installed, and the rehearsal needs it."
    typeset "TOOL_$tool=$REPLY"
  done
  need_tool initdb "Postgres 17 is not installed, and the rehearsal needs it. Install it with this command:" "  brew install postgresql@17"; pg_bin=${REPLY:h}
  [[ -n $OFFSITE ]] && { abs "$OFFSITE"; OFFSITE=$REPLY; }
  [[ -n $KEY ]] && { abs "$KEY"; KEY=$REPLY; }
  [[ -n $GIVEN_BUNDLE ]] && { abs "$GIVEN_BUNDLE"; GIVEN_BUNDLE=$REPLY; }
  [[ -n $OFFSITE || -n $GIVEN_BUNDLE ]] || { default_offsite; OFFSITE=$REPLY; }
  [[ -n $KEY || -n $GIVEN_BUNDLE ]] || { default_key; KEY=$REPLY; }
  mkdir -p -m 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/state" "$SCRATCH/log" || refuse "Flint could not make the rehearsal's folder."
  chmod 700 "$SCRATCH" "$SCRATCH/home" "$SCRATCH/state" "$SCRATCH/log"
  print -r -- "$SCRATCH" > "$SCRATCH/.flint-rehearsal"
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
  (( REPLACE )) && inner+=(--replace-existing)
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
    # The holder of the rehearsal's ports, if it is still there: told to stop, and stopped.
    [[ -n ${HOLD:-} && -d $HOLD ]] && : > "$HOLD/stop" 2>/dev/null
    [[ -n ${HOLDER:-} ]] && kill "$HOLDER" 2>/dev/null
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
  # Four free ports on this Mac's own address, each HELD until the moment it is needed. A port that is
  # picked and let go can be taken by anything else on this Mac before the rehearsal's own service binds
  # it (other checkouts' tests run here too), and the rehearsal would fail for no reason of its own. So a
  # small holder keeps all four bound, and lets one go when it is asked to (release_port, below), an
  # instant before the service that wants it starts. It ends when all four are let go, when it is told
  # to stop, or when this script is gone.
  HOLD="$SCRATCH/state/ports"
  mkdir -p -m 700 "$HOLD" || refuse "The rehearsal could not make a folder for its ports."
  node -e '
    const net = require("net"), fs = require("fs"), dir = process.argv[1], parent = process.ppid, born = Date.now();
    const servers = []; let left = 4, held = 4;
    const end = () => { for (const s of servers) { try { s.close(); } catch {} } process.exit(0); };
    for (let i = 0; i < 4; i++) {
      const s = net.createServer(); servers.push(s);
      s.on("error", () => process.exit(1));
      s.listen(0, "::1", () => { if (--left === 0) { fs.writeFileSync(dir + "/ports.new", servers.map((x) => x.address().port).join("\n") + "\n"); fs.renameSync(dir + "/ports.new", dir + "/ports"); } });
    }
    setInterval(() => {
      if (process.ppid !== parent || Date.now() - born > 30 * 60000 || fs.existsSync(dir + "/stop")) end();
      // Let go, then said: only once the port is really free, and the last one before this ends.
      servers.forEach((s, i) => { if (s.listening && fs.existsSync(dir + "/release-" + (i + 1))) s.close(() => { try { fs.writeFileSync(dir + "/released-" + (i + 1), ""); } catch {} if (--held === 0) end(); }); });
    }, 20);
  ' "$HOLD" >/dev/null 2>&1 &
  HOLDER=$!
  for i in {1..200}; do [[ -s $HOLD/ports ]] && break; sleep 0.025; done
  ports=(${(f)"$(<"$HOLD/ports")"}) 2>/dev/null
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
# Read on the MacBook's screen when --to started this: "this Mac" there would be the wrong one.
MAC="this Mac" MAC_CAP="This Mac"
(( VIA_TO )) && MAC="the new Mac" MAC_CAP="The new Mac"
# Working files of this run, removed however it ends. (The rehearsal has its own way out, above.)
typeset -a WORK_FILES
if (( ! REHEARSE )); then
  trap '(( ${#WORK_FILES} )) && rm -f -- "${WORK_FILES[@]}"' EXIT
  trap 'print -r -- "The rebuild was interrupted. Running the same command again starts it over."; exit 130' INT TERM HUP
fi

# ---- 1. before anything changes ----------------------------------------------------------
if (( ! REHEARSE )); then
  need_tool fdesetup "$MAC_CAP cannot say whether FileVault is on, so Flint stopped."
  "$REPLY" status 2>/dev/null | grep -q 'FileVault is On' || refuse "FileVault is off on $MAC, and a rebuild puts your memory and history on its disk. Turn FileVault on in System Settings, then run this again."
  [[ $REPO == ${${:-$HOME/flint}:A} ]] || refuse "On the new Mac, run the copy of this script that is in the flint folder of your home folder."
  [[ $HOME != *[\<\>\&\"\'\\]* ]] || refuse "$MAC_CAP's home folder has a character in its name that a LaunchAgent file cannot hold. Nothing was changed."
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
  need_tool ollama "Ollama is not installed. Install it with this command:" "  brew install ollama"; OLLAMA_BIN=$REPLY
  need_tool tailscaled "Tailscale is not installed. Install it with this command:" "  brew install tailscale"; TAILSCALED_BIN=$REPLY
  need_tool tailscale "Tailscale is not installed. Install it with this command:" "  brew install tailscale"; TAILSCALE_BIN=$REPLY
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
typeset -a SET_SECRETS SET_OVERRIDE SET_BACKUP SET_SERVER SET_OLLAMA NOT_RESTORED CONNECTORS PRESENT DEPLOYED MODELS_LEFT
RESTORED_PORT= RESTORED_MODEL= have_snapshot=0
# A limit: how much Flint may spend, and how far back it reads its history. They are put back like any
# other setting, and said apart from the rest, because a backup that was changed could have loosened them.
is_limit() { [[ $1 == (FLINT_BUDGET_*|*_BUDGET_USD|FLINT_HISTORY_MAX_AGE_HOURS) ]]; }
snapshot="$(mktemp "$TMP/flint-settings.XXXXXX")" || refuse "Flint could not make a working file."
WORK_FILES+=("$snapshot")
if /usr/bin/tar -xzOf "$BUNDLE/files.tar.gz" ./settings-snapshot.tsv > "$snapshot" 2>/dev/null && [[ -s $snapshot ]]; then
  have_snapshot=1
  while IFS=$'\t' read -r kind where name value extra; do
    case $kind in
      set)
        # A setting this Flint leaves to you, though the backup carries a value for it (one made before the
        # setting became yours to re-enter, or one that was changed): the value is not taken, and what the
        # rebuild does instead is said at the end, like anything else that needs you.
        if [[ -z $extra ]] && manifest_lookup "$where" "$name" && [[ $REPLY == reenter ]]; then PRESENT+=("$REPLY2"); continue; fi
        if [[ -n $extra ]] || ! manifest_lookup "$where" "$name" || [[ $REPLY != restore ]] || ! flint_value_ok "$REPLY2" "$value"; then
          [[ $name =~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' ]] && NOT_RESTORED+=("$name")
          continue
        fi
        shape=$REPLY2
        # A model's name with a slash in it is an address: it names whose model it is, somewhere on the internet.
        # The rebuild ends by telling you which models to download, so a name like that is never taken from a
        # backup: it is said, for you to check, and the setting is left for you.
        if [[ $shape == model && $value == */* ]]; then MODELS_LEFT+=("$name=$value"); continue; fi
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
            elif [[ $name == FLINT_RUNTIME_URL ]]; then :   # the rebuild writes its own
            else SET_SERVER+=("$name=$value"); fi ;;
          ollama.plist) SET_OLLAMA+=("$name=$value") ;;
          *) NOT_RESTORED+=("$name") ;;
        esac ;;
      skipped|unknown) [[ $where =~ '^[A-Za-z0-9._-]{1,60}$' && $name =~ '^[A-Za-z_][A-Za-z0-9_]{0,79}$' ]] && NOT_RESTORED+=("$name") ;;
      connector) [[ $where =~ '^[a-z0-9][a-z0-9_-]{0,39}$' ]] && CONNECTORS+=("$where") ;;
      deployed) [[ $where == (server|runtime) && $name =~ '^[0-9a-f]{40}$' && -z $value ]] && DEPLOYED+=("$name") ;;
      present) [[ $where =~ '^[A-Za-z0-9._-]{1,60}$' && $name =~ '^[A-Za-z0-9._-]{1,80}$' ]] && manifest_lookup "$where" "$name" && [[ $REPLY == reenter ]] && PRESENT+=("$REPLY2") ;;
    esac
  done < "$snapshot"
fi
rm -f "$snapshot"
(( ! REHEARSE )) && [[ -n $RESTORED_PORT ]] && SERVER_PORT=$RESTORED_PORT
model_restored=0
[[ -n $MODEL ]] || { MODEL=$RESTORED_MODEL; [[ -n $MODEL ]] && model_restored=1; }
if [[ -z $MODEL ]]; then
  if (( ! REHEARSE )); then
    if (( ${MODELS_LEFT[(I)OLLAMA_MODEL=*]} )); then
      refuse "The backup names a local model that is not from the usual model library, so Flint did not take it from there. Nothing was changed. Run this again and add --model with the model you use, like this:" "  --model muse-glimmer:30b"
    fi
    refuse "The backup does not say which local model Flint uses. Nothing was changed. Run this again and add --model with its name, like this:" "  --model muse-glimmer:30b"
  fi
  MODEL=rehearsal-model
fi
SET_SERVER+=("OLLAMA_MODEL=$MODEL")

# The Mac must be empty of Flint. Two things are allowed past that: a rebuild that stopped
# part-way and is being run again (its own marker says so), and the owner's explicit word.
# (The tests of all this: a rehearsal can be told to pretend things about its scratch Mac, one or more of
#   files            it already has Flint's files
#   database         its database server already has a Flint database
#   roles            its database server still has Flint's roles from an earlier install
#   resume           an earlier rebuild stopped part-way here, before it reached the database
#   resume-database  an earlier rebuild stopped after it had put a database in place
#   resume-old       the same as resume, two days ago
#   resume-used      the same as resume-database, and Flint has been used on that database since.)
PRETEND=(${(s:,:)${FLINT_REHEARSAL_EXISTING:-}})
(( REHEARSE )) || PRETEND=()
if (( ${PRETEND[(Ie)files]} )); then mkdir -p -m 700 "$DATA" && : > "$DATA/already-here"; fi
if (( ${PRETEND[(Ie)resume]} + ${PRETEND[(Ie)resume-database]} + ${PRETEND[(Ie)resume-old]} + ${PRETEND[(Ie)resume-used]} )); then
  marked_at=$(date +%s); (( ${PRETEND[(Ie)resume-old]} )) && marked_at=$(( marked_at - 2 * 86400 ))
  mkdir -p -m 700 "$DATA" && print -r -- "$marked_at flint-20261011-0230.tar.gz.age none" > "$MARKER" && : > "$DATA/left-by-the-first-try"
fi
# The mark a rebuild leaves in the data folder while it runs: when it began, and which backups it was
# putting back. With it there, this same command starts the rebuild over instead of refusing a Mac
# that "already has a Flint". That is right straight after a rebuild stopped, and wrong once the
# half-built Flint has been used: starting over sets its files aside and replaces its database. So
# a mark over a day old, or one whose database has been written to since it was restored, is acted
# on only when you say so at the keyboard (asked below, once the database can be read).
RESUME=0 RESUME_AT= RESUME_FILES=
if [[ -f $MARKER ]]; then
  RESUME=1
  resume_rest=
  { read -r RESUME_AT RESUME_FILES resume_rest < "$MARKER"; } 2>/dev/null
  [[ $RESUME_AT =~ '^[0-9]{9,11}$' ]] || RESUME_AT=
  [[ $RESUME_FILES =~ $FILES_NAME ]] || RESUME_FILES=
fi
if (( ! RESUME )); then
  existing=()
  empty_or_absent "$DATA" || existing+=("its data folder")
  [[ -z "$(print -l "$AGENTS"/com.flint.*.plist(N))" ]] || existing+=("its LaunchAgents")
  if (( ${#existing} )); then
    (( REPLACE )) || refuse "$MAC_CAP already has a Flint (${(j: and :)existing}). Nothing was changed. A rebuild is for a new Mac. To rebuild over what is here, add --replace-existing: the data folder is kept under another name."
  fi
  # Nothing of Flint's may be running here: a rebuild is not for a Mac in use, whatever option was given.
  if (( ! REHEARSE )) && launchctl list 2>/dev/null | grep -q 'com\.flint\.'; then
    refuse "Flint is running on $MAC, so it is not a new Mac. Nothing was changed."
  fi
fi
mkdir -p -m 700 "$LOG" && chmod 700 "$LOG" || refuse "Flint could not make a folder for the rebuild's logs."

# ---- the database server, and whether a Flint database is already in it --------------------
pg_conf() { # $MAC's own login by socket, every other connection by password on ::1, nothing off $MAC
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
# release_port <1: the database | 2: the server | 3: the runtime | 4: the server's own listener>: a rehearsal's
# port is let go now, because the service that binds it starts next. Anywhere else this does nothing.
release_port() {
  emulate -L zsh
  local i
  (( REHEARSE )) && [[ -n ${HOLD:-} && -d $HOLD && ! -e $HOLD/released-$1 ]] || return 0
  : > "$HOLD/release-$1"
  for i in {1..120}; do [[ -e $HOLD/released-$1 ]] && return 0; sleep 0.025; done
  return 0
}
pg_start() { # <start|restart>
  emulate -L zsh
  if (( REHEARSE )); then
    release_port 1
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
[[ "$(<"$PG_DATA/PG_VERSION")" == 17 ]] || refuse "The database server on $MAC is not Postgres 17, so Flint stopped. Nothing was changed."
if (( fresh_cluster )); then
  pg_conf || refuse "Flint could not write the database server's settings."
  pg_start start || refuse "The database server did not start. The details are in $LOG."
elif [[ -f $PG_DATA/flint.conf ]]; then
  # Set up by an earlier run of this script.
  pg_ready 4 || pg_start start || refuse "The database server did not start. The details are in $LOG."
else
  # A database server that was here first. Flint looks before it touches anything.
  pg_ready 4 || pg_start start || refuse "The database server on $MAC did not start, so Flint stopped. Nothing was changed."
  others="$(pg_admin -c "SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")" || refuse "Flint could not ask the database server on $MAC what it holds, so it stopped. Nothing was changed."
  if [[ $others == 0 ]]; then
    pg_conf || refuse "Flint could not write the database server's settings."
    pg_start restart || refuse "The database server did not start. The details are in $LOG."
  else
    # Flint's rules about who may write what rest on each role having to give its password. A server that lets
    # anyone in without one would make them words only, and its settings are not Flint's to change.
    open_doors="$(pg_admin -c "SELECT count(*) FROM pg_hba_file_rules WHERE auth_method = 'trust'")" || refuse "Flint could not ask the database server on $MAC how it lets programs sign in, so it stopped. Nothing was changed."
    [[ $open_doors == 0 ]] || refuse "The database server on $MAC holds other databases and lets programs sign in without a password, and Flint's safety rules depend on passwords. Flint left it alone and stopped. Nothing was changed."
    say "The database server on $MAC already holds other databases, so Flint left its settings alone."
  fi
fi
if (( ${PRETEND[(Ie)database]} )); then pg_admin -c 'CREATE DATABASE flint' >/dev/null; fi
if (( ${PRETEND[(Ie)resume-database]} + ${PRETEND[(Ie)resume-used]} )); then
  # What the first try did before it stopped: the roles and the databases, and then something in the database.
  ( cd "$REPO" && PGHOST="$PG_SOCKET" PGPORT="$PG_PORT" PGUSER="$ME" PGDATABASE=postgres pnpm --silent --filter @flint/runtime bootstrap-db --port "$PG_PORT" ) >/dev/null 2>&1 \
    && "$TOOL_psql" -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -U "$ME" -d flint -c 'CREATE TABLE left_by_the_first_try (id integer)' >/dev/null 2>&1 \
    || refuse "The rehearsal could not set up what an earlier rebuild would have left."
fi
if (( ${PRETEND[(Ie)resume-used]} )); then
  # And Flint was then used: its record holds the restore, and something written after it.
  "$TOOL_psql" -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -U "$ME" -d flint \
    -c 'CREATE TABLE "AuditEntry" (at timestamptz, action text, outcome text, inputs jsonb)' -c 'ALTER TABLE "AuditEntry" OWNER TO flint_owner' \
    -c "INSERT INTO \"AuditEntry\" VALUES (now() - interval '2 hours', 'restore.production', 'ok', '{\"mode\":\"rebuild\"}'), (now() - interval '1 hour', 'health.check', 'ok', '{}')" >/dev/null 2>&1 \
    || refuse "The rehearsal could not set up what an earlier rebuild would have left."
fi
if (( ${PRETEND[(Ie)roles]} )); then pg_admin -c 'CREATE ROLE flint_owner LOGIN CREATEDB' -c 'CREATE ROLE flint_app LOGIN' >/dev/null; fi
ROTATE=0
if (( ! RESUME )); then
  held="$(pg_admin -c "SELECT count(*) FROM pg_database WHERE datname = 'flint'")" || refuse "Flint could not ask the database server what it holds, so it stopped. Nothing was changed."
  [[ $held == 0 ]] || refuse "$MAC_CAP already has a Flint database. Nothing was changed. A rebuild never replaces a database: to put a backup back into it, see docs/RECOVERY.md."
  # Flint's database roles left by an earlier install, with no database: found here, before anything changes.
  roles="$(pg_admin -c "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'flint\_%'")" || refuse "Flint could not ask the database server what it holds, so it stopped. Nothing was changed."
  if [[ $roles != 0 ]]; then
    (( REPLACE )) || refuse "The database server on $MAC still has Flint's roles from an earlier install. Nothing was changed. To rebuild over what is here, add --replace-existing: each role gets a new password."
    ROTATE=1
  fi
else
  ROTATE=1
fi
timed database-server

# ---- starting a stopped rebuild over: only straight away, or when you say so -----------------------
if (( RESUME )); then
  doubts=()
  [[ -n $RESUME_AT ]] && (( $(date +%s) - RESUME_AT <= 86400 )) || doubts+=("that was more than a day ago")
  # Has Flint written to its database since the earlier rebuild restored it? Its own record says: anything
  # newer than the restore's entry (or anything at all, when no restore was recorded) is Flint having run.
  used=0
  if [[ "$(pg_admin -c "SELECT count(*) FROM pg_database WHERE datname = 'flint'")" == 1 ]]; then
    flint_sql() { "$TOOL_psql" -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -U "$ME" -d flint -c "$1" 2>>"$LOG/psql.err"; }
    if [[ "$(flint_sql "SELECT to_regclass('public.\"AuditEntry\"') IS NOT NULL")" == t ]]; then
      used="$(flint_sql "SELECT count(*) FROM public.\"AuditEntry\" a WHERE a.action <> 'restore.production' AND a.at > coalesce((SELECT max(r.at) FROM public.\"AuditEntry\" r WHERE r.action = 'restore.production' AND r.outcome = 'ok'), '-infinity')")" \
        || refuse "Flint could not read the database the earlier rebuild left on $MAC, so it stopped. Nothing was changed."
    fi
  fi
  [[ $used == 0 ]] || doubts+=("Flint has been running on $MAC since")
  if (( ${#doubts} )); then
    began="some time ago"; [[ -n $RESUME_AT ]] && began="on $(date -r "$RESUME_AT" '+%Y-%m-%d at %H:%M')"
    using=; if [[ -n $RESUME_FILES ]]; then when_of "$RESUME_FILES"; using=" It was putting back the backup from $REPLY."; fi
    say "An earlier rebuild stopped part-way on $MAC $began, and ${(j:, and :)doubts}.$using"
    say "Starting it over sets aside the Flint files that are on $MAC now and puts the backup in their place, and replaces its database."
    [[ -t 0 && -t 1 ]] || refuse "Flint will not start it over without being told to at the keyboard. Nothing was changed."
    print -n -- "Type START OVER to go on, or press Return to stop: "
    answer=; read -r answer || true
    [[ $answer == 'START OVER' ]] || refuse "Nothing was changed."
  fi
fi

# ---- 2. Flint's files --------------------------------------------------------------------
# From here the Mac changes. The marker lets this same command be run again if it stops part-way.
stamp="$(date +%Y%m%d-%H%M%S)"
if (( RESUME )); then
  say "An earlier rebuild stopped part-way on $MAC. Flint is starting it over."
  if (( ! REHEARSE )); then
    # Whatever the first try started is stopped first: nothing may hold the files or the database it left.
    for plist in "$AGENTS"/com.flint.*.plist(N); do launchctl bootout "gui/$UID/${plist:t:r}" >/dev/null 2>&1; done
  fi
  # What the first try left is set aside, not deleted, and removed when this one finishes.
  mv "$DATA" "$DATA.rebuild-stopped-$stamp" || refuse "Flint could not set aside what the earlier rebuild left, so it stopped."
elif ! empty_or_absent "$DATA"; then
  mv "$DATA" "$DATA.before-rebuild-$stamp" || refuse "Flint could not set the existing data folder aside, so it stopped."
  say "The Flint data that was here is kept in ${DATA:t}.before-rebuild-$stamp."
fi
mkdir -p -m 700 "$DATA" && chmod 700 "$DATA" && print -r -- "$(date +%s) $BUNDLE_FILES_NAME $BUNDLE_DB_NAME" > "$MARKER" || refuse "Flint could not make its data folder."

# What is unpacked, by name: the folders and files that hold your data, and nothing else. An archive
# is not trusted to hold only what a backup of Flint's holds (see the top of this file), so a
# settings file, a connector list, a token or a program in it is simply never unpacked, whatever
# case its name is written in. The names are matched exactly as written here.
UNPACK=(memory training eval spend notifications.json settings-snapshot.tsv)   # and the adapters folders under brain
# tar reads each name it is given as a pattern, so no name is ever taken from the archive as it is written
# there: the top-level names are the words above, and an adapters folder is asked for only when its name
# is `adapters` and at most forty more plain characters (a folder called `adapters*` would ask for every
# file beside it).
typeset -a wanted_members left_out
for name in $ARCHIVE_NAMES; do
  top=${name%%/*}
  if (( ${UNPACK[(Ie)$top]} )); then
    wanted_members+=("./$top")
  elif [[ $name == brain/*/* ]]; then
    part=${${name#brain/}%%/*}
    [[ $part =~ '^adapters[A-Za-z0-9._-]{0,40}$' ]] && wanted_members+=("./brain/$part")
  elif [[ $top != brain && $top =~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$' ]]; then
    left_out+=("$top")
  fi
done
wanted_members=(${(u)wanted_members})
left_out=(${(u)left_out})
# Said once more where it is used: nothing asked of tar holds a character it would read as a pattern.
for member in $wanted_members; do
  [[ $member =~ '^\./(brain/)?[A-Za-z0-9._-]{1,60}$' ]] || refuse "The files backup holds a name Flint will not ask for, so it stopped."
done
free_kb="$(/bin/df -k "$DATA" 2>/dev/null | awk 'NR == 2 { print $4 }')"
[[ $free_kb == <-> ]] && (( free_kb * 1024 > ARCHIVE_BYTES + 1024 * 1024 * 1024 )) || refuse "$MAC does not have room for what the backup holds. Free some space, then run this again."
if (( ${#wanted_members} )); then
  /usr/bin/tar -xzf "$BUNDLE/files.tar.gz" -C "$DATA" -- "${wanted_members[@]}" >/dev/null 2>"$LOG/unpack.err" \
    || refuse "The files backup did not unpack. The details are in $LOG/unpack.err."
fi
# Nothing from a backup is run, and nothing in it points outside its folder.
find "$DATA" -type l -delete 2>"$LOG/unpack.err" || refuse "Flint could not remove the links the backup held, so it stopped."
find "$DATA" -type f -perm +111 -exec chmod a-x {} + 2>"$LOG/unpack.err" || refuse "Flint could not make the backup's files plain files, so it stopped."
chmod -R go-rwx "$DATA" 2>"$LOG/unpack.err" || refuse "Flint could not make its data folder private, so it stopped."
# Checked again on the disk, which does not tell upper case from lower: nothing that came out of the
# archive may sit where a settings file, a token or a sign-in lives, and no settings file anywhere.
typeset -a forbidden
for key in ${(k)MF_CLASS}; do [[ $key == file/* ]] && forbidden+=("${${key#file/}:l}"); done
(( ${#forbidden} >= 10 )) || refuse "Flint could not read its own list of secret files, so it stopped."
for f in "$DATA"/*(DN); do
  [[ ${f:t} == .rebuild-in-progress ]] && continue
  if (( ${forbidden[(Ie)${${f:t}:l}]} )); then
    rm -rf "${DATA:?}"
    refuse "The files backup put a file where one of Flint's secret files lives, which a backup of Flint's never does. Flint removed what it had unpacked and stopped."
  fi
done
if [[ -n "$(find "$DATA" -iname '*.env' -o -iname '*.env.*' 2>/dev/null | head -1)" ]]; then
  rm -rf "${DATA:?}"
  refuse "The files backup holds a settings file, which a backup of Flint's never does. Flint removed what it had unpacked and stopped."
fi
# The key the nightly backups on this Mac are encrypted to: yours, as worked out from your key on the MacBook.
print -r -- "$BUNDLE_RECIPIENT" > "$DATA/backup-age-recipient" && chmod 600 "$DATA/backup-age-recipient" || refuse "Flint could not save the key your backups are encrypted to."
# Connectors are code, and are never unpacked. The ones the old Mac had that this repo has source for
# are rebuilt below; the rest are named.
restored_connectors=() dropped_connectors=() dropped_unnamed=0
for name in $ARCHIVE_NAMES; do
  [[ $name == connectors/*.mjs && $name != connectors/*/* ]] || continue
  name=${${name#connectors/}%.mjs}
  if [[ $name =~ '^[a-z0-9][a-z0-9-]{0,39}-server$' && -f $REPO/packages/mcp/connectors/$name.ts ]]; then restored_connectors+=("$name")
  elif [[ $name =~ '^[a-z0-9][a-z0-9_-]{0,39}$' ]]; then dropped_connectors+=("$name")
  else dropped_unnamed=$(( dropped_unnamed + 1 )); fi
done
say "Your memory, history and Flint's own files are back from the backup."
restored=$(( ${#SET_SECRETS} + ${#SET_OVERRIDE} + ${#SET_BACKUP} + ${#SET_SERVER} + ${#SET_OLLAMA} - 1 + model_restored ))
if (( have_snapshot )); then
  # Each one by name and value: they came from the backup, and none is a secret (settings.manifest says which may be saved).
  if (( restored > 0 )); then say "Flint put back $restored of your settings:"; else say "Flint put back none of your settings."; fi
  limits=()
  for kv in $SET_SECRETS $SET_OVERRIDE $SET_BACKUP $SET_SERVER $SET_OLLAMA; do
    [[ $kv == OLLAMA_MODEL=* ]] && (( ! model_restored )) && continue
    if is_limit "${kv%%=*}"; then limits+=("$kv"); continue; fi
    say "  ${kv%%=*} is ${kv#*=}."
  done
  if (( ${#limits} )); then
    say "These limits came from the backup. Check them:"
    for kv in $limits; do say "  ${kv%%=*} is ${kv#*=}."; done
  fi
  for kv in $MODELS_LEFT; do
    say "The backup names the model ${kv#*=} for ${kv%%=*}, which is not from the usual model library. Flint did not put that setting back. Set it yourself if that model is yours."
  done
else
  say "This backup was made before Flint saved your settings, so they start at their defaults."
fi
timed files

# ---- 3. new secrets ------------------------------------------------------------------------
(
  umask 077
  {
    print -r -- "# Written by apps/studio/rebuild.sh. Flint's own secrets here are new; none came from a backup."
    for kv in $SET_SECRETS; do [[ $kv == (FLINT_RUNTIME_URL|FLINT_INFERENCE_MODE)=* ]] || print -r -- "$kv"; done
    print -r -- "FLINT_RUNTIME_URL=http://[::1]:$RUNTIME_PORT"
    # The routing mode is never taken from a backup: not the setting, and not the file Settings keeps it in
    # (which is never unpacked). A backup that was changed could turn Local into Cloud, and the mode decides
    # where your words go. So the rebuilt Flint starts in Local mode, where every answer comes from this Mac,
    # whatever the old one was in. It is said at the end, and you choose another in Settings if you want one.
    print -r -- "FLINT_INFERENCE_MODE=local"
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
# Roles that are already there (a rebuild started over, or one over an earlier install) get new passwords.
(( ROTATE )) && bootstrap_args+=(--rotate)
( cd "$REPO" && PGHOST="$PG_SOCKET" PGPORT="$PG_PORT" PGUSER="$ME" PGDATABASE=postgres pnpm --silent --filter @flint/runtime bootstrap-db --from-rebuild "${bootstrap_args[@]}" ) 2>"$LOG/bootstrap-db.err" \
  || refuse "Flint could not set up its database. The details are in $LOG/bootstrap-db.err."
if (( ${#SET_BACKUP} )); then
  ( print -rl -- $SET_BACKUP >> "$DATA/backup.env" ) && chmod 600 "$DATA/backup.env" || refuse "Flint could not write your backup settings."
fi
if [[ -n $BUNDLE_DUMP ]]; then
  # The runtime's own restore, told that the rebuild is running it and what the dump's fingerprint was when
  # the MacBook opened it. It restores beside the empty database, checks the copy against a database built
  # from this repo, and only then puts it in place: a run that stops leaves the empty database as it was.
  # Run directly, not through pnpm: how it ends (3 means the database is not empty) must reach this script as it is.
  restore_db() { ( cd "$REPO/apps/runtime" && ./node_modules/.bin/tsx src/cli.ts restore-empty --from-rebuild --dump "$BUNDLE_DUMP" --sha256 "$BUNDLE_DUMP_SHA" ) 2>"$LOG/restore.err"; }
  restore_db; st=$?
  if (( st == 3 && RESUME )); then
    # The earlier try got as far as putting a database in place and stopped before it was checked and
    # recorded. The marker says this rebuild made that database, so it is made again, empty.
    pg_admin -c 'DROP DATABASE IF EXISTS flint' && pg_admin -c 'CREATE DATABASE flint OWNER flint_owner' \
      && "$TOOL_psql" -X -q -At -v ON_ERROR_STOP=1 -h "$PG_SOCKET" -p "$PG_PORT" -U "$ME" -d flint -c 'ALTER SCHEMA public OWNER TO flint_owner' >/dev/null 2>>"$LOG/psql.err" \
      || refuse "Flint could not clear the database the earlier rebuild left. The details are in $LOG/psql.err."
    restore_db; st=$?
  fi
  (( st == 0 )) || refuse "The database backup did not restore. What it printed above says why, and the details are in $LOG/restore.err."
else
  say "No database backup was restored, so Flint starts with an empty database."
fi
timed database

# ---- 5. the LaunchAgents the repo could not make before, from their templates ------------------
mkdir -p "$AGENTS" || refuse "Flint could not make the LaunchAgents folder."
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
  local i
  launchctl bootout "gui/$UID/$1" >/dev/null 2>&1
  # launchd lets go of a job a moment after it is told to; loading it again before then fails.
  for i in {1..40}; do launchctl print "gui/$UID/$1" >/dev/null 2>&1 || break; sleep 0.25; done
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
    say "Your phone and MacBook can reach Flint on $MAC again."
    # Who may use Flint over the tailnet is the account that just signed in, as Tailscale itself names it:
    # never a name read from a backup, which would hand the console to whoever wrote it there.
    status="$("$TAILSCALE_BIN" --socket "$DATA/tailscaled.sock" status --json 2>/dev/null)"
    uid="$(print -r -- "$status" | "$TOOL_plutil" -extract Self.UserID raw -o - - 2>/dev/null)"
    login=
    [[ $uid == <-> ]] && login="$(print -r -- "$status" | "$TOOL_plutil" -extract "User.$uid.LoginName" raw -o - - 2>/dev/null)"
    if flint_value_ok email "$login"; then
      print -r -- "FLINT_TAILNET_USER=${login:l}" >> "$DATA/secrets.env" && say "Only that Tailscale account may use Flint from another device."
    else
      say "Flint could not read which Tailscale account signed in, so other devices will ask for the access token."
    fi
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
# When the code here is the commit the old Mac was running (the backup names it, and the MacBook
# set this checkout to it), its gate (typecheck and tests) already passed there and is not run
# again. When the backup names none, this is main's newest commit, which nothing has vouched for:
# its gate runs before it is installed. (A rehearsal is itself run by the gate.)
install_env=("PORT=$SERVER_PORT" "RUNTIME_PORT=$RUNTIME_PORT")
head_commit="$("$TOOL_git" -C "$REPO" rev-parse HEAD 2>/dev/null)" || head_commit=
if (( REHEARSE )) || { [[ -n $head_commit ]] && (( ${DEPLOYED[(Ie)$head_commit]} )); }; then
  install_env+=(FLINT_SKIP_TESTS=1)
else
  say "Flint is testing its code before installing it, because it is not a version the old Mac was running. This takes several minutes."
fi
release_port 3
( cd "$REPO" && env "${install_env[@]}" ./apps/runtime/install-runtime.sh ) >"$LOG/install-runtime.log" 2>&1 \
  || refuse "The runtime did not come up. The details are in $LOG/install-runtime.log."
say "Flint's runtime is built and answering."
release_port 2; release_port 4
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
  private "$f" || refuse "A settings file in Flint's data folder can be read by others on $MAC: ${f:t}."
done
say "Flint answers on $MAC, and its database is up to date."
timed checks

# ---- 9. the approval key --------------------------------------------------------------------------
# The old Mac's key lived in its hardware and is gone with it. This code registers a new one and
# revokes every old one. It is shown once, to you; a rehearsal makes it and never shows it.
if (( REHEARSE )); then
  ( cd "$REPO" && pnpm --silent --filter @flint/runtime enroll --replace ) >/dev/null 2>"$LOG/enroll.err" || refuse "The rehearsal could not make an enrolment code."
  [[ -f $DATA/enroll-code ]] && private "$DATA/enroll-code" || refuse "The enrolment code was not saved safely."
else
  # The code is read from the file the command saves (0600), so that it is shown on a line of its own.
  if ( cd "$REPO" && pnpm --silent --filter @flint/runtime enroll --replace ) >/dev/null 2>"$LOG/enroll.err" && [[ "$(<"$DATA/enroll-code")" =~ '^([0-9a-f-]{20,40}) replace$' ]]; then
    say "Your approval key lived in the old Mac. Open Flint on $MAC, go to Settings and then Approval Key, and enter this code:"
    say "  $match[1]"
  else
    say "Flint could not make an enrolment code. Make one later with this command:"
    say "  cd ~/flint && pnpm --silent --filter @flint/runtime enroll --replace"
  fi
fi

# ---- 10. the rest of the agents (the real rebuild only), and what is left for you ------------------
if (( ! REHEARSE )); then
  /bin/zsh "$HERE/install_searxng.sh" >"$LOG/install-searxng.log" 2>&1 || say "Keyless web search did not install. Flint works without it."
  for label in $LOAD_NOW $LOAD_LAST; do load_agent "$label" || say "The agent $label did not load."; done
fi
# The rebuild is whole: the marker goes, and so do the opened copy of the backups, the rebuild's logs,
# and what an earlier try that stopped part-way had left.
rm -f "$MARKER"
for old in "$DATA".rebuild-stopped-*(N/); do rm -rf "${old:?}"; done
(( REHEARSE )) || rm -rf "${BUNDLE:?}" "${LOG:?}"

embed=nomic-embed-text
for kv in $SET_SECRETS; do [[ $kv == FLINT_EMBED_MODEL=* ]] && embed=${kv#*=}; done
say "Flint does not download models. Run these on $MAC, one at a time:"
say "  ollama pull $MODEL"
say "  ollama pull $embed"

typeset -A WHERE_TO
WHERE_TO=(
  Anthropic      "Anthropic: revoke the old key at console.anthropic.com under API Keys, and add a new one only if you still use it."
  OpenAI         "OpenAI: revoke the old key at platform.openai.com under API keys, and add a new one only if you still use it."
  Google-AI      "Google AI: revoke the old key at aistudio.google.com under API keys, and add a new one only if you still use it."
  Perplexity     "Perplexity: revoke the old key in Perplexity's settings under API, and add a new one only if you still use it."
  Tavily         "Tavily: revoke the old key at app.tavily.com under API Keys, and add a new one only if you still use it."
  Nexus          "Nexus: revoke the old Mac's tokens in Nexus, and give $MAC new ones."
  Phone-Pings    "Phone pings: choose a new topic name in the phone's notification app, and set the same name in Flint."
  GitHub-App     "GitHub: remove the old private key of the flint-observer app under Developer settings, and make a new one."
  Google         "Google Calendar: remove the old Mac under Third-party access at myaccount.google.com, then sign in again from Flint."
  Tailscale      "Tailscale: remove the old Mac under Machines in the Tailscale admin page."
  Approval-Key   "Approval key: the enrolment code registers the new Mac's key and revokes the old one."
  Connectors     "Connectors: the list of connectors holds keys, so it was never backed up. It needs writing again."
  Safety-Switch  "Safety switches: one you had turned off on the old Mac is back on. Turn it off again only if you still mean to."
  Allowed-Hosts  "Allowed hosts: the extra addresses Flint answered on were typed by hand. Set them again if you still use them."
  Health-Endpoints "Health checks of other sites: their addresses were typed by hand. Set them again if you still want them."
  Voice          "Voice: the speech program and its model are installed by hand. Install them again if you use voice."
  Backup-Key     "Backup key: the rebuilt Mac encrypts its backups to the key you rebuilt it with."
  Local-Model-Server "Local model server: its address and its key were typed by hand and are not put back, so Flint asks Ollama on this Mac. Set them again only if you still use another model server, and change the key if it was a real one."
  Routing-Mode   "Flint is in Local mode after a rebuild. Choose another mode in Settings if you want one."
)
# The mode, always, and on a line of its own: it was not left out of a backup, it is simply never taken from
# one. Whatever mode the old Mac was in, this one is in Local mode until you choose.
say "${WHERE_TO[Routing-Mode]}"
outside=()
if (( have_snapshot )); then outside=(${(u)PRESENT}); else outside=(Tailscale Approval-Key Connectors Google Nexus); fi
outside=(${outside:#Routing-Mode})
(( ${#outside} )) && say "These were never in a backup, because Flint does not back up a key or a sign-in. Each needs you once:"
for o in $outside; do [[ -n ${WHERE_TO[$o]:-} ]] && say "  ${WHERE_TO[$o]}"; done
(( ${#CONNECTORS} )) && say "The connectors that were set up on the old Mac: ${(j:, :)CONNECTORS}."
(( ${#dropped_connectors} + dropped_unnamed )) && say "Flint left out $(counted $(( ${#dropped_connectors} + dropped_unnamed )) connector) it has no source for${dropped_connectors:+: ${(j:, :)dropped_connectors}}."
(( ${#NOT_RESTORED} )) && say "Flint did not put back $(counted ${#${(u)NOT_RESTORED}} setting) it does not know or could not check: ${(j:, :)${(u)NOT_RESTORED}}."
# What else the backup held and a rebuild does not unpack (a rebuild takes your data, and nothing that is run or that holds a key).
left_out=(${(o)left_out})
(( ${#left_out} )) && say "The backup also held $(counted ${#left_out} "other thing") that a rebuild does not put back: ${(j:, :)left_out[1,40]}${${left_out[41]:+, and more}:-}."
if (( ! REHEARSE && ! REMOTE_DONE )); then
  say "To finish remote access, run these three on $MAC, one at a time:"
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
  say "Flint is rebuilt on $MAC."
fi
exit 0
