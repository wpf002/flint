# The Nexus responder: takes turns for the API participants, holds the daily standup, and
# reports the heartbeat. It's a worker. It serves nothing, so there's no port.
#
# Build context is the REPO ROOT, because it imports workspace packages. Railway builds it
# on push to main. Settings (this Dockerfile's path, restart ALWAYS, 300s drain, watch
# patterns) are on the nexus-responder service, not in a railway.toml.
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile
# Only the packages the responder imports, so an unrelated package can't break this build.
RUN pnpm --filter "responder^..." build

WORKDIR /app/apps/responder
# node is PID 1, not pnpm. The loop finishes its current round on SIGTERM, and pnpm
# doesn't reliably forward the signal, so a redeploy could kill a paid turn mid-call.
CMD ["node", "--import", "tsx", "src/index.ts", "run"]
