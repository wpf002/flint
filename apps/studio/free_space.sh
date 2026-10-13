#!/bin/zsh
# free_space.sh: say what Flint keeps on this Mac and how much room each part takes, and remove
# the three kinds of thing nothing needs any more. Run it on the Studio, in Terminal.
#
#   free_space.sh                          Lists what Flint keeps, by size, and what could be removed.
#                                          It removes nothing.
#   free_space.sh --remove                 Removes the rotated logs, and the runtime versions beyond
#                                          the ones the installer keeps.
#   free_space.sh --remove-test-leftovers  Removes the temp folders Flint's own tests left behind
#                                          more than a day ago.
#
# What may ever be removed is narrow, and each thing is looked at again just before it goes:
#   - a rotated log: a plain file of yours directly in ~/.flint whose whole name is a log's name
#     and the number the nightly backup gave it when it rotated it (ollama.err.log.1.gz). The
#     log that is being written to is never one of them;
#   - an old runtime version: a folder of yours directly in ~/.flint/runtime/releases whose whole
#     name is a commit. The three newest stay, and so do the one that is running, the one that ran
#     before it (what rollback.sh goes back to) and any you pinned: the installer's own rule
#     (apps/runtime/install-runtime.sh), which leaves more than that only when a deploy stopped
#     before its last step. When the running version cannot be told, none is removed;
#   - a test leftover: a folder of yours directly in the temp folder, untouched for a day, whose
#     whole name is one of the names Flint's own tests gave their scratch folders
#     (test-support/temp-prefixes: every one starts with flint-) followed by the six characters
#     the system adds, at least one of them a digit or a capital, so a name that only reads like
#     one (flint-pg-backup) is never taken for one. It is left when anything inside it changed in
#     the last day, when it holds a socket (something may be listening there), or when part of it
#     cannot be looked into. Nothing else in the temp folder is touched, whatever it is called.
# No link is ever followed, and nothing outside those three folders is removed.
#
# Your backups, your memory, the database and the local models are listed and never removed here:
# the nightly jobs keep the backups to their own limits, and the models are yours to remove.
set -u
here=${0:A:h}
repo=${here:h:h}
source "$here/recovery_lib.sh"

DATA="$HOME/.flint"
RELEASES="$DATA/runtime/releases"
remove=0 leftovers=0
for a in "$@"; do
  case $a in
    --remove) remove=1 ;;
    --remove-test-leftovers) leftovers=1 ;;
    *) refuse "The only options are --remove and --remove-test-leftovers." ;;
  esac
done
me="$(id -u)"

# ---- sizes ------------------------------------------------------------------------

# kb_of <path>...: what they take on disk together, in kilobytes (0 when there is none, or none can be read).
kb_of() {
  emulate -L zsh
  local total=0 kb rest
  (( $# )) || { print -r -- 0; return 0; }
  # In batches: a temp folder can hold tens of thousands of leftovers.
  while (( $# )); do
    while read -r kb rest; do [[ $kb == <-> ]] && (( total += kb )); done < <(/usr/bin/du -sk -- "${(@)argv[1,400]}" 2>/dev/null)
    shift $(( $# < 400 ? $# : 400 ))
  done
  print -r -- $total
}
# size_of <kilobytes>: "less than 1 MB", "340 MB", "2.1 GB".
size_of() {
  emulate -L zsh
  if (( $1 < 1024 )); then print -rn -- "less than 1 MB"
  elif (( $1 < 1024 * 1000 )); then print -rn -- "$(( ($1 + 512) / 1024 )) MB"
  else printf '%.1f GB' $(( $1 / 1048576.0 )); fi
}

# ---- what could go ----------------------------------------------------------------

# Rotated logs: <name>.log.<n> and <name>.log.<n>.gz, plain files of this user's, directly in the data folder.
rotated=()
for f in "$DATA"/*.log.[0-9]*(N.U); do
  [[ ${f:t} =~ '^[A-Za-z0-9._-]+\.log\.[0-9](\.gz)?$' ]] && rotated+=("$f")
done

# Runtime versions beyond the ones the installer keeps.
old_releases=()
releases_held=0
all_releases=()
for d in "$RELEASES"/*(N/Uom); do [[ ${d:t} =~ '^[0-9a-f]{40}$' ]] && all_releases+=("$d"); done
if (( ${#all_releases} > 3 )); then
  current="$(readlink "$DATA/runtime/current" 2>/dev/null)"; current=${current:t}
  if [[ $current =~ '^[0-9a-f]{40}$' && -d $RELEASES/$current ]]; then
    typeset -A keep
    keep[$current]=1
    for d in "${(@)all_releases[1,3]}"; do keep[${d:t}]=1; done
    for line in "$DATA/runtime/version" "$DATA/runtime/version.prev"; do
      sha=; [[ -r $line ]] && read -r sha rest < "$line" 2>/dev/null
      [[ ${sha:-} =~ '^[0-9a-f]{40}$' ]] && keep[$sha]=1
    done
    if [[ -r $DATA/runtime/pinned ]]; then
      while read -r sha rest; do [[ ${sha:-} =~ '^[0-9a-f]{40}$' ]] && keep[$sha]=1; done < "$DATA/runtime/pinned"
    fi
    for d in $all_releases; do [[ -n ${keep[${d:t}]:-} ]] || old_releases+=("$d"); done
  else
    releases_held=1
  fi
fi

# What the tests left in the temp folder.
tmp="${${TMPDIR:-}%/}"
[[ -n $tmp && -d $tmp ]] || tmp="${$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)%/}"
typeset -A prefixes
if [[ -r $repo/test-support/temp-prefixes ]]; then
  while read -r p rest; do [[ $p =~ '^[A-Za-z0-9][A-Za-z0-9._-]*[-.]$' ]] && prefixes[$p]=1; done < "$repo/test-support/temp-prefixes"
fi
# is_test_name <name>: its whole name is one of the tests' own, followed by exactly six letters or digits, at
# least one of them a digit or a capital. The system's six are random: all six being small letters happens once
# in two hundred, and reads like a word another program chose (flint-pg-backup). Those few are left.
is_test_name() {
  emulate -L zsh
  [[ $1 =~ '^(.+)([A-Za-z0-9]{6})$' && -n ${prefixes[$match[1]]:-} && $match[2] == *[0-9A-Z]* ]]
}
# in_use <folder>...: of these folders in the temp folder, one line for each that should be left as it is: it
# holds a socket, something inside it changed in the last day, or part of it cannot be looked into.
in_use() {
  emulate -L zsh
  (( $# )) || return 0
  local p
  /usr/bin/find "$@" \( -type s -o -mmin -1440 -o \( -type d ! -perm -u+rx \) \) -print0 2>/dev/null | while IFS= read -r -d '' p; do
    p=${p#$tmp/}; print -r -- "$tmp/${p%%/*}"
  done | LC_ALL=C sort -u
}
test_left=()
test_busy=0
other_flint=0
if [[ -n $tmp && -d $tmp ]] && (( ${#prefixes} )); then
  # A folder (never a link to one) of this user's, last changed more than 24 hours ago.
  named=()
  for d in "$tmp"/*(N/Umh+24); do
    name=${d:t}
    if is_test_name "$name"; then named+=("$d")
    elif [[ $name == flint-* ]]; then (( other_flint += 1 )); fi
  done
  # In batches: a temp folder can hold tens of thousands of leftovers.
  while (( ${#named} )); do
    batch=("${(@)named[1,200]}"); shift $(( ${#named} < 200 ? ${#named} : 200 )) named
    busy=("${(@f)$(in_use $batch)}")
    for d in $batch; do
      if (( ${busy[(Ie)$d]} )); then (( test_busy += 1 )); else test_left+=("$d"); fi
    done
  done
fi

# ---- what Flint keeps, by size -------------------------------------------------------

free_kb="$(/bin/df -k "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
[[ $free_kb == <-> ]] && say "This Mac has $(size_of $free_kb) free."
part() { # <path> <what it is, for the start of a sentence> [<a sentence more>]
  [[ -e $1 ]] || return 0
  say "$2 $(size_of $(kb_of "$1")).${3:+ $3}"
}
part "$DATA" "Flint's own files and its runtime take"
part "$HOME/FlintBackups" "Its backups on this Mac take"
part "$HOME/Library/Mobile Documents/com~apple~CloudDocs/FlintBackups" "Its encrypted copies in iCloud Drive take"
part "$HOME/.ollama/models" "The local models take" "Flint never removes a model."

rotated_kb=$(kb_of $rotated)
releases_kb=$(kb_of $old_releases)
left_kb=$(kb_of $test_left)
(( ${#rotated} )) && say "There $( (( ${#rotated} == 1 )) && print -n is || print -n are ) $(counted ${#rotated} "rotated log"), $(size_of $rotated_kb) in all."
(( ${#old_releases} )) && say "There $( (( ${#old_releases} == 1 )) && print -n is || print -n are ) $(counted ${#old_releases} "runtime version") beyond the ones Flint keeps, $(size_of $releases_kb) in all."
(( releases_held )) && say "Flint could not tell which runtime version is running, so it leaves every one of them."
if (( ${#test_left} )); then
  say "Flint's own tests left $(counted ${#test_left} "temp folder") more than a day ago, $(size_of $left_kb) in all."
  # By name, so it can be seen what would go: the first twenty, and how many more there are.
  if (( ${#test_left} > 20 )); then say "The first 20 are these:"; elif (( ${#test_left} == 1 )); then say "It is this one:"; else say "They are these:"; fi
  for d in "${(@)test_left[1,20]}"; do say "  ${d:t}"; done
  (( ${#test_left} > 20 )) && say "There $( (( ${#test_left} == 21 )) && print -n "is 1" || print -n "are $(( ${#test_left} - 20 ))" ) more."
fi
(( test_busy )) && say "Flint leaves $(counted $test_busy "temp folder") of its tests that $( (( test_busy == 1 )) && print -n "is in use or changed" || print -n "are in use or changed" ) in the last day."
(( other_flint )) && say "Flint leaves $(counted $other_flint "other old temp folder") that $( (( other_flint == 1 )) && print -n "has its name and is" || print -n "have its name and are" ) not from a test it knows."

# ---- removing ------------------------------------------------------------------------

# gone <file|folder> <the one folder it must be directly in> <path>: remove it only if it is still what it was
# when it was listed: directly in that folder, this user's, a plain file or a real folder, never a link.
removed_n=0 removed_kb=0 kept_back=0
gone() {
  emulate -L zsh
  local kind=$1 parent=$2 p=$3 kb
  [[ $p == /* && ${p:h} == $parent && ! -L $p ]] || { (( kept_back += 1 )); return 0; }
  if [[ $kind == file ]]; then [[ -f $p ]] || { (( kept_back += 1 )); return 0; }
  else [[ -d $p ]] || { (( kept_back += 1 )); return 0; }; fi
  [[ "$(/usr/bin/stat -f %u "$p" 2>/dev/null)" == $me ]] || { (( kept_back += 1 )); return 0; }
  kb=$(kb_of "$p")
  if [[ $kind == file ]]; then /bin/rm -f -- "$p" 2>/dev/null; else /bin/rm -rf -- "$p" 2>/dev/null; fi
  if [[ -e $p ]]; then (( kept_back += 1 )); else (( removed_n += 1 )); (( removed_kb += kb )); fi
  return 0
}

did=0
if (( remove )); then
  did=1
  if (( ${#rotated} + ${#old_releases} == 0 )); then
    say "There are no rotated logs and no old runtime versions to remove."
  else
    say "Flint is removing $(counted ${#rotated} "rotated log") and $(counted ${#old_releases} "old runtime version")."
    for f in $rotated; do [[ ${f:t} =~ '^[A-Za-z0-9._-]+\.log\.[0-9](\.gz)?$' ]] && gone file "$DATA" "$f"; done
    for d in $old_releases; do [[ ${d:t} =~ '^[0-9a-f]{40}$' ]] && gone folder "$RELEASES" "$d"; done
    say "Flint removed $(counted $removed_n thing) and freed $(size_of $removed_kb)."
    (( kept_back )) && say "It left $(counted $kept_back thing) that had changed or would not go."
  fi
fi
if (( leftovers )); then
  did=1
  removed_n=0 removed_kb=0 kept_back=0
  if (( ${#test_left} == 0 )); then
    say "There are no test leftovers to remove."
  else
    say "Flint is removing $(counted ${#test_left} "temp folder") its own tests left."
    while (( ${#test_left} )); do
      batch=("${(@)test_left[1,200]}"); shift $(( ${#test_left} < 200 ? ${#test_left} : 200 )) test_left
      # Looked at again, a moment before they go: nothing in them changed since, and nothing listens there.
      busy=("${(@f)$(in_use $batch)}")
      for d in $batch; do
        name=${d:t}
        # Checked again, as it was listed: a test's name, the six characters, and nothing changed in it for a day.
        is_test_name "$name" || { (( kept_back += 1 )); continue; }
        [[ -n "$(print -rn -- "$d"(N/Umh+24))" ]] || { (( kept_back += 1 )); continue; }
        (( ${busy[(Ie)$d]} )) && { (( kept_back += 1 )); continue; }
        gone folder "$tmp" "$d"
      done
    done
    say "Flint removed $(counted $removed_n "temp folder") and freed $(size_of $removed_kb)."
    (( kept_back )) && say "It left $(counted $kept_back "temp folder") that had changed or would not go."
  fi
fi
if (( ! did )); then
  if (( ${#rotated} + ${#old_releases} )); then
    say "To remove the rotated logs and the old runtime versions, run this:"
    say "  ~/flint/apps/studio/free_space.sh --remove"
  fi
  if (( ${#test_left} )); then
    say "To remove what the tests left, run this:"
    say "  ~/flint/apps/studio/free_space.sh --remove-test-leftovers"
  fi
  (( ${#rotated} + ${#old_releases} + ${#test_left} )) || say "There is nothing here for Flint to remove."
  say "Nothing was removed."
fi
exit 0
