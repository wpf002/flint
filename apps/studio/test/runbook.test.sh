#!/bin/zsh
# The recovery runbook (docs/RECOVERY.md) stays true to the code: every command
# it tells the owner to type exists, every test it names as proof exists, no
# entry asks for more than seven steps, and nothing in it names a real machine.
# Run: zsh apps/studio/test/runbook.test.sh
set -u
here=${0:A:h}
repo=${here:h:h:h}
doc="$repo/docs/RECOVERY.md"
fail=0
check() { if eval "$2"; then :; else print -r -- "FAIL $1"; fail=1; fi }

check "the runbook exists" '[ -s "$doc" ]'
# Every script it names is in the repo and can be run.
n=0
for script_path in ${(u)${(f)"$(grep -oE '(~/flint|\.)/apps/[A-Za-z0-9_./-]+\.sh' "$doc")"}}; do
  rel=${${script_path#\~/flint/}#./}
  n=$(( n + 1 ))
  check "the runbook's $rel exists and is executable" '[ -x "$repo/$rel" ]'
done
check "the runbook names its scripts" '(( n >= 3 ))'
# Every pnpm command it gives is a script the runtime really has.
for name in ${(u)${(f)"$(grep -oE 'pnpm --filter @flint/runtime [a-z-]+' "$doc" | awk '{ print $4 }')"}}; do
  check "pnpm --filter @flint/runtime $name is a real command" 'grep -q "\"$name\": " "$repo/apps/runtime/package.json"'
done
check "the runbook gives the restore command" 'grep -q "pnpm --filter @flint/runtime restore-production" "$doc"'
# The options it mentions are ones the scripts take.
check "--to is an option of rebuild.sh" 'grep -q -- "--to|--unseal|--from|--rehearse|--stop" "$repo/apps/studio/rebuild.sh"'
check "--without-copy and --check are options of restore-production" 'grep -q -- "a === .--without-copy." "$repo/apps/runtime/src/backup/restore-cli.ts" && grep -q -- "a === .--check." "$repo/apps/runtime/src/backup/restore-cli.ts" && grep -q -- "restore-production --check" "$doc"'
for word in memory history notifications; do
  check "restore_file.sh takes $word" 'grep -qE "^  $word\)" "$repo/apps/studio/restore_file.sh"'
done
check "the hold file it names is the one the deploy job honours" 'grep -q "deploy-hold" "$repo/apps/server/auto_deploy.sh" && grep -q "rm ~/.flint/deploy-hold" "$doc"'
check "the key's place is where rebuild.sh looks by default" 'grep -q "\.flint-standby/backup-key.txt" "$repo/apps/studio/rebuild.sh" && grep -q "~/.flint-standby/backup-key.txt" "$doc"'
# Every test it names as proof is there.
for t in ${(u)${(f)"$(grep -oE 'apps/[A-Za-z0-9_./-]+\.test\.(sh|ts)' "$doc")"}}; do
  check "the proof $t exists" '[ -f "$repo/$t" ]'
done
check "each of the four entries names its proof" '[ "$(grep -c "^- Proved" "$doc")" -ge 4 ]'
# No entry asks for more than seven numbered steps.
awk '/^## /{ if (max > 7) bad = 1; max = 0 } /^[0-9]+\. /{ n = $1 + 0; if (n > max) max = n } END { if (max > 7) bad = 1; exit bad }' "$doc"
check "no entry has more than seven steps" '[ $? = 0 ]'
# The repo is public: the runbook names no real machine, tailnet, address or key.
check "no tailnet name, address or key in the runbook" '! grep -nE "\.ts\.net|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|age1[0-9a-z]{20}|AGE-SECRET-KEY|sk-[A-Za-z0-9]{8}" "$doc"'
check "Flint may not edit the runbook" 'grep -q "recover|runbook" "$repo/packages/policy/src/selfmod-paths.ts"'
# The README's short form gives the same four commands.
for cmd in "~/flint/apps/studio/rollback.sh" "pnpm --filter @flint/runtime restore-production" "~/flint/apps/studio/restore_file.sh memory" "./apps/studio/rebuild.sh --to NAME@NEWMAC.local"; do
  check "the README and the runbook both give: $cmd" 'grep -qF -- "$cmd" "$repo/README.md" && grep -qF -- "$cmd" "$doc"'
done

(( fail )) && exit 1
print "ok: every command and proof in the recovery runbook exists, and no entry has more than seven steps"
