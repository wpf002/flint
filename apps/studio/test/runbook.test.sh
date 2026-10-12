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
# The database's command is one script, so no package manager's banner is printed between Flint's sentences.
check "the runbook gives the restore command, as one script" 'grep -q "~/flint/apps/studio/restore_database.sh$" "$doc" && ! grep -q "pnpm" "$doc"'
check "that script runs the runtime's own restore command" 'grep -q "src/cli.ts restore-production" "$repo/apps/studio/restore_database.sh" && grep -q "\"restore-production\": " "$repo/apps/runtime/package.json"'
# The options it mentions are ones the scripts take.
check "--to is an option of rebuild.sh" 'grep -q -- "--to|--unseal|--from|--rehearse|--stop" "$repo/apps/studio/rebuild.sh"'
for opt in --without-copy --check --repair --dump; do
  check "$opt is an option of restore-production, and the runbook gives it" 'grep -q -- "a === .$opt." "$repo/apps/runtime/src/backup/restore-cli.ts" && grep -q -- "restore_database.sh $opt" "$doc"'
done
check "--list is the script's own, and the runbook gives it" 'grep -q -- "== --list" "$repo/apps/studio/restore_database.sh" && grep -q -- "restore_database.sh --list" "$doc"'
check "--unseal is an option of rebuild.sh, and the runbook has the owner prove the key with it" 'grep -q -- "rebuild.sh --unseal ~/flint-proof" "$doc" && grep -q "rm -rf ~/flint-proof" "$doc"'
check "restore_file.sh takes a day, and the runbook says so" 'grep -q "restore_file.sh memory 2026-10-10" "$doc" && grep -q "year-month-day" "$repo/apps/studio/restore_file.sh"'
check "the address the runbook gives for the new Mac is the one the server answers on" 'grep -q "http://localhost:8080" "$doc" && grep -q "SERVER_PORT=8080" "$repo/apps/studio/rebuild.sh"'
for word in memory history notifications; do
  check "restore_file.sh takes $word" 'grep -qE "^  $word\)" "$repo/apps/studio/restore_file.sh"'
done
check "the hold file it names is the one the deploy job honours" 'grep -q "deploy-hold" "$repo/apps/server/auto_deploy.sh" && grep -q "rm ~/.flint/deploy-hold" "$doc"'
check "the key's place is where rebuild.sh looks by default" 'grep -q "\.flint-standby/backup-key.txt" "$repo/apps/studio/rebuild.sh" && grep -q "~/.flint-standby/backup-key.txt" "$doc"'
# Every test it names as proof is there.
for t in ${(u)${(f)"$(grep -oE 'apps/[A-Za-z0-9_./-]+\.test\.(sh|ts)' "$doc")"}}; do
  check "the proof $t exists" '[ -f "$repo/$t" ]'
done
# The proofs are for whoever maintains the page, in a section of their own: nothing Will reads names a test.
check "each of the four entries names its proof, in the maintainers' section" '[ "$(sed -n "/^## For whoever maintains this page/,\$p" "$doc" | grep -c "^- Entry [1-4]: ")" = 4 ]'
check "nothing before that section names a test or a source file" '! sed "/^## For whoever maintains this page/,\$d" "$doc" | grep -nE "\.test\.(sh|ts)|\.ts\b|Proved"'
# No entry asks for more than seven numbered steps.
awk '/^## /{ if (max > 7) bad = 1; max = 0 } /^[0-9]+\. /{ n = $1 + 0; if (n > max) max = n } END { if (max > 7) bad = 1; exit bad }' "$doc"
check "no entry has more than seven steps" '[ $? = 0 ]'
# The repo is public: the runbook names no real machine, tailnet, address or key.
check "no tailnet name, address or key in the runbook" '! grep -nE "\.ts\.net|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|age1[0-9a-z]{20}|AGE-SECRET-KEY|sk-[A-Za-z0-9]{8}" "$doc"'
check "Flint may not edit the runbook" 'grep -q "recover|runbook" "$repo/packages/policy/src/selfmod-paths.ts"'
# The README's short form gives the same four commands.
for cmd in "~/flint/apps/studio/rollback.sh" "~/flint/apps/studio/restore_database.sh" "~/flint/apps/studio/restore_file.sh memory" "./apps/studio/rebuild.sh --to NAME@NEWMAC.local"; do
  check "the README and the runbook both give: $cmd" 'grep -qF -- "$cmd" "$repo/README.md" && grep -qF -- "$cmd" "$doc"'
done

(( fail )) && exit 1
print "ok: every command and proof in the recovery runbook exists, and no entry has more than seven steps"
