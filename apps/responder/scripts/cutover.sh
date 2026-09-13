#!/bin/bash
# Moves the responder from this Mac to Railway. Run it yourself, because it handles keys.
#
# 1. Copies the six secrets from apps/responder/.env into the nexus-responder service.
#    Each value goes over stdin, so none lands in shell history, the process list, or
#    this script's output.
# 2. Stops the local launchd agent and moves its plist to ~/.flint/retired, so two
#    responders never take the same turns. The plist is kept so the way back is one command.
set -euo pipefail

PROJECT="6fddc199-83e9-4fa5-8cb7-825163a9e361"
ENVIRONMENT="production"
SERVICE="nexus-responder"
KEYS=(NEXUS_TOKEN_CLAUDE_API NEXUS_TOKEN_GPT_API NEXUS_TOKEN_PERPLEXITY_API ANTHROPIC_API_KEY OPENAI_API_KEY PERPLEXITY_API_KEY)

cd "$(dirname "$0")/.."   # apps/responder, where .env and dotenv live

# Every key is checked before any is set, so a missing one can't leave Railway half-configured.
read_key() {
  node -e '
    const { parse } = require("dotenv");
    const value = parse(require("fs").readFileSync(".env"))[process.argv[1]];
    if (!value) process.exit(1);
    process.stdout.write(value);
  ' "$1"
}
for key in "${KEYS[@]}"; do
  read_key "$key" >/dev/null || { echo "missing $key in apps/responder/.env. Nothing was changed."; exit 1; }
done

for key in "${KEYS[@]}"; do
  read_key "$key" | railway variables --project "$PROJECT" --environment "$ENVIRONMENT" \
    --service "$SERVICE" --skip-deploys --set-from-stdin "$key" >/dev/null
  echo "set $key"
done

PLIST="$HOME/Library/LaunchAgents/com.nexus.responder.plist"
launchctl bootout "gui/$(id -u)/com.nexus.responder" 2>/dev/null || true
if [ -f "$PLIST" ]; then
  mkdir -p "$HOME/.flint/retired"
  mv "$PLIST" "$HOME/.flint/retired/"
fi
echo "local responder stopped"
echo "to bring it back: mv ~/.flint/retired/com.nexus.responder.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.nexus.responder.plist"
