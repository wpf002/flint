#!/bin/zsh
# What the nightly backup keeps, locally and offsite, on a fixture shaped like
# ~/.flint, with the real bsdtar. Run: zsh apps/studio/test/backup_excludes.test.sh
#
# On 2026-09-30 every offsite (iCloud) archive held secrets.env.bak*, plist
# backups carrying FLINT_TOKEN, mcp.json with the search key and the Nexus
# bearer token, nexus-responder.json and legion/*.sh with inline credentials.
set -eu
here=${0:A:h}
FLINT_BACKUP_DEFINE_ONLY=1 source "$here/../backup_flint.sh"

fx=$(mktemp -d); trap 'rm -rf "$fx"' EXIT
mkdir -p "$fx/src"/{memory,training,legion,tokens,brain/adapters,eval,spend,evolve}
cd "$fx/src"
secret=(
  secrets.env secrets.env.bak secrets.env.bak-tier secrets.env.bak-20260930-0919
  com.flint.server.plist.bak-20260925-0743 mcp.json mcp.json.all42 mcp.json.bak-20260925-1152
  nexus-responder.json nexus-responder.sh nexus-responder.env legion/crossbar.sh
  token nexus-admin-token.txt tokens/voice.token memory/knowledge.json.bak-20260925
)
keep=(
  memory/conversations.json memory/knowledge.json training/corpus.jsonl notifications.json
  actions.jsonl autonomy.json triggers.json mcp-computer.json eval/parity_prompts.jsonl
  spend/spend-2026-09.jsonl evolve/daily.csv brain/adapters/tokenizer.json brain/adapters/adapter_config.json
)
for f in $secret $keep; do print -r -- x > "$f"; done

members() { tar -czf - -C "$fx/src" "$@" . | tar -tzf - | sed 's#^\./##'; }
offsite=$(members "${EXCLUDES[@]}" "${SECRETS[@]}")
local_=$(members "${EXCLUDES[@]}")

fail=0
for f in $secret; do
  if print -r -- "$offsite" | grep -qxF "$f"; then print -r -- "FAIL offsite keeps a secret: $f"; fail=1; fi
done
for f in $keep; do
  print -r -- "$offsite" | grep -qxF "$f" || { print -r -- "FAIL offsite dropped: $f"; fail=1; }
done
for f in $secret $keep; do # local snapshots (dir 700) keep everything
  print -r -- "$local_" | grep -qxF "$f" || { print -r -- "FAIL local dropped: $f"; fail=1; }
done
(( fail )) && exit 1
print "ok: offsite drops ${#secret} secret-bearing files and keeps ${#keep} others; local keeps all"
