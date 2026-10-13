#!/bin/zsh
# Every FLINT_ setting the code reads is one the settings manifest lists.
# Static: it reads the source and the manifest, nothing on this Mac and nothing
# on the network. Run: zsh apps/studio/test/settings_names_static.test.sh
#
# The live check (test/live/settings_names.check.sh) compares the manifest with
# the names SET on the Studio. This one compares it with the names the CODE
# reads, so a setting added in a pull request is listed before it is set
# anywhere. A name the manifest does not list is treated as a secret: it is
# never saved, and a rebuild does not put it back.
#
# Where the names come from:
#  - the server, the runtime and the shared packages (apps/server/src,
#    apps/runtime/src, packages/*/src), in the forms a setting is read in:
#    process.env.FLINT_X, env.FLINT_X and any other <something>.FLINT_X;
#    ['FLINT_X']; a 'FLINT_X' string handed to a reader; a FLINT_X: key in a
#    settings schema or object; and { FLINT_X } = process.env;
#  - names built at run time (`FLINT_TIER_${tier}`): each shape is known below,
#    and is spelled out from the list in the source it is built from;
#  - the scripts that install, deploy, back up and recover Flint (every *.sh in
#    apps/server, apps/runtime and apps/studio, and every installer
#    agents.manifest names): every FLINT_X outside a comment line;
#  - the LaunchAgent files and templates kept in the repo: every name one sets
#    must be listed for that agent.
#
# A name the code reads that is NOT a setting kept in ~/.flint or in a
# LaunchAgent (a test's seam, a path a test points elsewhere, a word given on
# the command line) is named in `not_settings` below, one by one, with why.
# There are no patterns: a new name is a line in settings.manifest or a line
# here, and a line here that the code no longer reads fails the test too.
source "${0:A:h}/temp_root.zsh"   # one temp folder for this run, removed when the test ends
set -u
here=${0:A:h}
repo=${here:h:h:h}
source "$here/../recovery_lib.sh"
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

# ---- names the code reads that are not settings ------------------------------------------------
not_settings=(
  # Set for one command by a test or by the deploy gate, never kept anywhere.
  FLINT_REQUIRE_DB          # install-runtime.sh, for its own test run: the database tests must not be skipped
  FLINT_DEPLOY_GATE         # install-runtime.sh, for its own test run: only the gate's tests may read this Mac's database settings
  FLINT_REQUIRE_SWIFT       # install-server.sh, for its own test run: whether the Swift checks must run
  FLINT_REQUIRE_REHEARSAL   # install-server.sh and run_rehearsal.sh, for one run: the rehearsal must run, never be skipped
  FLINT_REHEARSE            # typed by hand before install-server.sh: run the rebuild rehearsal in this deploy's gate
  FLINT_SKIP_TESTS          # the emergency bypass of the gate, typed by hand; auto_deploy.sh clears it
  FLINT_TEST_FAULT          # the runtime's tests stop it at a named point (read only when NODE_ENV is test)
  # The rebuild rehearsal (rebuild.sh --rehearse) and its tests.
  FLINT_REHEARSAL_EXISTING  # the rehearsal pretends the scratch Mac already holds Flint's files
  FLINT_REHEARSAL_INNER     # set by the rehearsal itself when it starts over inside its scratch home folder
  FLINT_REHEARSAL_STATE     # where the launchctl stand-in keeps what is "loaded"
  FLINT_ICLOUD_WAIT         # how long rebuild.sh waits for iCloud to bring a backup down; the tests shorten it
  FLINT_TOOL_PATHS          # where need_tool looks after PATH; the tests use it to hide a tool
  # Where a script or the runtime looks, so a test can point it at a fixture. Each
  # has a default under the home folder, and no LaunchAgent file in the repo sets
  # one (checked below).
  FLINT_STATE_DIR           # auto_deploy.sh and rollback.sh: the folder the deploy hold file is in
  FLINT_DATA                # settings_manifest.sh: the data folder
  FLINT_AGENTS              # settings_manifest.sh: the LaunchAgents folder
  FLINT_SETTINGS_MANIFEST   # recovery_lib.sh: this manifest, or a test's broken one
  FLINT_AGENTS_MANIFEST     # recovery_lib.sh: the agents manifest
  FLINT_SECRETS_FILE        # the runtime's restore command: where secrets.env is, or a test's own
  FLINT_TS_SOCKET           # install-server.sh: Tailscale's socket
  # The backup job's own defaults (backup_flint.sh, backup-nightly.sh) and
  # restore_file.sh. The repo's LaunchAgent for the job sets none of them (checked
  # below), and a rebuild writes that file from the repo.
  FLINT_BACKUP_DIR          # where the local snapshots go (~/FlintBackups)
  FLINT_BACKUP_OFFSITE      # where the encrypted copy goes (iCloud Drive)
  FLINT_BACKUP_KEEP         # how many local snapshots are kept
  FLINT_BACKUP_KEEP_OFFSITE # how many offsite ones
  FLINT_BACKUP_MANIFEST     # the list of offsite snapshots
  FLINT_BACKUP_TS           # the snapshot's timestamp; the tests set it rather than wait a minute
  FLINT_BACKUP_FREE_KB      # a test's stand-in for a full disk: how much room the backup is told there is
  FLINT_BACKUP_DEFINE_ONLY  # sourcing backup_flint.sh for its lists alone
  FLINT_AGE_BIN             # the age program; the tests use it to take age away
  FLINT_DOW                 # the day of the week, for the weekly restore drill; the tests set it
  FLINT_RESTORE_STOP_WAIT   # restore_file.sh: how long the server gets to stop; the tests shorten it
  # Given on the command line when a script is run by hand, and kept nowhere.
  FLINT_BRANCH              # studio_bootstrap.sh: the branch to check out on a new Studio
  FLINT_CALENDAR_DEST       # install_calendar.sh: where the app is installed
  FLINT_CALENDAR_REPIN      # install_calendar.sh: replace an app that is signed differently
  FLINT_KEYCHAIN            # install_calendar.sh: the keychain holding the signing identity
  FLINT_SIGN_IDENTITY       # install_calendar.sh: the signing identity
  # Not read from the environment at all: a table inside recovery_lib.sh.
  FLINT_PATTERNS
)
typeset -A allowed
for n in $not_settings; do allowed[$n]=1; done
check "no name is given twice in the list of names that are not settings" '(( ${#allowed} == ${#not_settings} ))'

# ---- the manifest ------------------------------------------------------------------------------------
check "the manifest loads" 'manifest_load'

# ---- what the runtime's installer writes into runtime.env is listed for that file -------------------
# By name alone is not enough there: the nightly snapshot and the live check (settings_manifest.sh) look a setting
# up under the file it was found in, so one the installer copies from the server's settings (the standby model's
# name) needs its own runtime.env line beside the server's.
written=("${(@f)$(sed -n '/^ENVF="\$DATA\/runtime\.env"$/,/^} > "\$ENVF\.new"$/p' "$repo/apps/runtime/install-runtime.sh" | grep -oE 'echo "[A-Z][A-Z0-9_]*=' | sed -E 's/^echo "//; s/=$//' | sort -u)}")
unlisted=()
for n in $written; do [[ -n ${MF_CLASS[runtime.env/$n]:-} ]] || unlisted+=("$n"); done
check "the installer's own block was read: it writes ten settings or more into runtime.env" '(( ${#written} >= 10 ))'
check "the standby model's name is one of them" '(( ${written[(Ie)FLINT_LOCAL_FALLBACK_MODEL]} ))'
check "every setting the installer writes into runtime.env is listed for runtime.env (not listed: ${unlisted[*]:-none})" '(( ${#unlisted} == 0 ))'
typeset -A listed
for key in ${(k)MF_CLASS}; do [[ $key == file/* ]] || listed[${key#*/}]=1; done
check "the manifest lists a real number of setting names" '(( ${#listed} > 100 ))'
for n in $not_settings; do
  check "$n is either a setting in the manifest or a name that is not a setting, never both" '[[ -z ${listed[$n]:-} ]]'
done
typeset -A seen   # every name the scan found, for the last check
where_read() { # <NAME> <files...>: up to two of the files that read it, for a failure line
  local name=$1; shift
  REPLY="${(j:, :)${(@)${(f)"$(grep -lE "(^|[^A-Z0-9_])$name([^A-Z0-9_]|\$)" "$@" 2>/dev/null | head -2)"}#$repo/}}"
}
known() { [[ -n ${listed[$1]:-} || -n ${allowed[$1]:-} ]]; }
listed_beginning() { local -a m; m=(${(M)${(k)listed}:#${1}*}); (( ${#m} > 0 )); }

# ---- 1. the server, the runtime and the shared packages ---------------------------------------------
ts=("$repo"/apps/server/src/**/*.ts(N.) "$repo"/apps/runtime/src/**/*.ts(N.) "$repo"/packages/*/src/**/*.ts(N.))
ts=(${ts:#*.test.ts}); ts=(${ts:#*.d.ts})
check "the source is where this test looks for it" '(( ${#ts} > 100 ))'
N='FLINT_[A-Z0-9_]*[A-Z0-9]'
ts_names=(${(u)${(f)"$(
  {
    grep -hoE "[])A-Za-z0-9_]\.${N}|\[['\"]${N}['\"]\]|['\"\`]${N}['\"\`]|(^|[{,])[[:space:]]*${N}[[:space:]]*:" $ts
    grep -hE "\}[[:space:]]*=[[:space:]]*(process\.)?env([^A-Za-z0-9_]|\$)" $ts
  } 2>/dev/null | grep -oE "${N}"
)"}})
check "the scan finds the settings the source reads" '(( ${#ts_names} > 40 ))'
for must in FLINT_TOKEN FLINT_RUNTIME_TRIAGE FLINT_PLANNER FLINT_HISTORY_TURNS FLINT_TZ; do
  check "the scan sees $must, in one of the forms a setting is read in" '(( ${ts_names[(Ie)$must]} ))'
done
for n in ${(o)ts_names}; do
  seen[$n]=1
  known "$n" && continue
  where_read "$n" $ts
  check "the code reads $n ($REPLY), and settings.manifest does not list it" 'false'
done

# Names built at run time. Each shape (what is left when every ${...} is taken out) is
# known here, with the list in the source its names are built from. The periods and
# endings are the ones written beside each template in the source.
list_of() { # <CONST> <file under the repo>: the words in `export const CONST ... = ['a', 'b']`, upper case, in reply
  reply=(${(U)${(f)"$(sed -nE "s/^export const $1[^=]*= \[([^]]*)\].*/\1/p" "$repo/$2" 2>/dev/null | grep -oE "'[a-z_-]+'" | tr -d "'")"}})
}
list_of PAID_VENDORS packages/core/src/pricing.ts; vendors=($reply)
list_of SPEND_KINDS packages/policy/src/wire.ts; kinds=($reply)
list_of TIERS packages/core/src/tiers.ts; tiers=($reply)
check "the paid vendors can be read from the source" '(( ${#vendors} >= 4 ))'
check "the background spend kinds can be read from the source" '(( ${#kinds} >= 4 ))'
check "the tiers can be read from the source" '(( ${#tiers} >= 4 ))'
shapes=(${(u)${(f)"$(grep -hoE 'FLINT_[A-Z0-9_]*(\$\{[^}]*\}[A-Z0-9_]*)+' $ts 2>/dev/null | sed -E 's/\$\{[^}]*\}/<>/g')"}})
built=()
for shape in $shapes; do
  case $shape in
    'FLINT_BUDGET_<>_<>_USD') for v in $vendors; do built+=(FLINT_BUDGET_${v}_DAILY_USD FLINT_BUDGET_${v}_MONTHLY_USD); done ;;
    'FLINT_BUDGET_<>_')       for v in $vendors; do built+=(FLINT_BUDGET_${v}_DAILY_USD FLINT_BUDGET_${v}_MONTHLY_USD); done ;;   # in a message: FLINT_BUDGET_<VENDOR>_*
    'FLINT_BUDGET_KIND_<>_<>_USD') for k in $kinds; do built+=(FLINT_BUDGET_KIND_${k}_DAILY_USD FLINT_BUDGET_KIND_${k}_MONTHLY_USD); done ;;
    'FLINT_BUDGET_KIND_<>_DAILY_USD') for k in $kinds; do built+=(FLINT_BUDGET_KIND_${k}_DAILY_USD); done ;;
    'FLINT_BUDGET_KIND_<>_DAILY_CALLS') for k in $kinds; do built+=(FLINT_BUDGET_KIND_${k}_DAILY_CALLS); done ;;
    'FLINT_TIER_<>') for t in $tiers; do built+=(FLINT_TIER_${t}); done ;;
    *) check "the code builds a setting name at run time ($shape), and this test does not know how to spell its names out" 'false' ;;
  esac
done
check "the scan finds the names built at run time" '(( ${#shapes} >= 3 && ${#built} >= 12 ))'
for n in ${(ou)built}; do
  check "the code builds $n at run time, and settings.manifest does not list it" '[[ -n ${listed[$n]:-} ]]'
done

# ---- 2. the scripts that install, deploy, back up and recover Flint ---------------------------------
sh=("$repo"/apps/server/*.sh(N.) "$repo"/apps/runtime/*.sh(N.) "$repo"/apps/studio/*.sh(N.))
while read -r label how source load rest; do
  [[ -z $label || $label == \#* ]] && continue
  [[ $how == installer && -f $repo/$source ]] && sh+=("$repo/$source")
done < "$AGENTS_MANIFEST"
sh=(${(u)sh})
check "the scripts are where this test looks for them" '(( ${#sh} >= 15 ))'
sh_names=(${(u)${(f)"$(grep -hvE '^[[:space:]]*#' $sh 2>/dev/null | grep -oE 'FLINT_[A-Z0-9_]+')"}})
check "the scan finds the names the scripts read" '(( ${#sh_names} > 15 ))'
for n in ${(o)sh_names}; do
  if [[ $n == *_ ]]; then
    # A pattern over several names (FLINT_BUDGET_[A-Z]+_...): the manifest must list names that begin so.
    check "a script reads the settings that begin $n, and settings.manifest lists none" 'listed_beginning "$n"'
    continue
  fi
  seen[$n]=1
  known "$n" && continue
  where_read "$n" $sh
  check "a script reads $n ($REPLY), and settings.manifest does not list it" 'false'
done

# ---- 3. the LaunchAgent files and templates in the repo ----------------------------------------------
plists=("$repo"/apps/*/com.flint.*.plist(N.) "$repo"/apps/*/*/com.flint.*.plist(N.) "$repo"/apps/studio/templates/com.flint.*.plist.tmpl(N.))
check "the LaunchAgent files are where this test looks for them" '(( ${#plists} >= 8 ))'
set_by_agents=0
for f in $plists; do
  label=${${f:t}%.tmpl}; label=${label%.plist}
  case $label in
    com.flint.server) where=server.plist ;;
    com.flint.ollama) where=ollama.plist ;;
    *) where="$label.plist" ;;
  esac
  for name in ${(f)"$(plist_env_names "$f")"}; do
    [[ -n $name ]] || continue
    set_by_agents=$(( set_by_agents + 1 ))
    [[ $name == FLINT_* ]] && seen[$name]=1
    check "${f#$repo/} sets $name, and settings.manifest does not list it for $where" 'manifest_lookup "$where" "$name"'
    check "${f#$repo/} sets $name, which this test names as not a setting" '[[ -z ${allowed[$name]:-} ]]'
  done
done
check "the scan finds the names the LaunchAgent files set" '(( set_by_agents >= 15 ))'

# ---- 4. the list of names that are not settings stays true ---------------------------------------------
for n in $not_settings; do
  check "$n is named here as read by the code, and the code no longer reads it" '[[ -n ${seen[$n]:-} ]]'
done

(( fail )) && exit 1
built=(${(u)built})
print "ok: of the ${#seen} FLINT_ names the source and the scripts read, the ${#built} built at run time and the $set_by_agents names the repo's LaunchAgent files set, the manifest lists every setting; the ${#not_settings} that are not settings are named one by one"
