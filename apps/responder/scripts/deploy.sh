#!/bin/bash
# Deploys the responder to Railway as nexus-responder.
#
# Uploads a `git archive HEAD` copy, not this checkout. Only committed code ships, and
# untracked files can't ride along: apps/responder/.env holds real keys and the root
# .dockerignore doesn't exclude it.
set -euo pipefail

PROJECT="6fddc199-83e9-4fa5-8cb7-825163a9e361"
ENVIRONMENT="production"
SERVICE="nexus-responder"

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" archive HEAD | tar -x -C "$STAGE"
# The root railway.toml is apps/server's. Railway reads the one at the upload root.
cp "$STAGE/apps/responder/railway.toml" "$STAGE/railway.toml"

echo "deploying $(git -C "$REPO" rev-parse --short HEAD) to $SERVICE"
cd "$STAGE"
railway up --ci --project "$PROJECT" --environment "$ENVIRONMENT" --service "$SERVICE"
