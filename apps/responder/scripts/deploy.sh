#!/bin/bash
# Deploys the responder to Railway as nexus-responder.
#
# Pushing to main deploys the responder on its own when apps/responder, packages/core,
# packages/mcp or pnpm-lock.yaml change. This script is for deploying without a push.
#
# Uploads a `git archive HEAD` copy, not this checkout. Only committed code ships, and
# untracked files can't ride along: apps/responder/.env holds real keys and the root
# .dockerignore doesn't exclude it.
#
# Build and restart settings live on the service, not in a railway.toml: Config as Code
# is deprecated, and a railway.toml at the upload root overrides the service's settings.
set -euo pipefail

PROJECT="6fddc199-83e9-4fa5-8cb7-825163a9e361"
ENVIRONMENT="production"
SERVICE="nexus-responder"

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO" archive HEAD | tar -x -C "$STAGE"
# Nothing at the upload root may override the service's own build settings.
rm -f "$STAGE/railway.toml" "$STAGE/railway.json"

echo "deploying $(git -C "$REPO" rev-parse --short HEAD) to $SERVICE"
cd "$STAGE"
railway up --ci --project "$PROJECT" --environment "$ENVIRONMENT" --service "$SERVICE"
