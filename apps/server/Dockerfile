# Hosted Flint — build context is the REPO ROOT (monorepo).
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# Install workspace deps (lockfile-pinned), then build the library packages.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @flint/core build \
 && pnpm --filter @flint/persona build \
 && pnpm --filter @flint/mcp build

# Railway injects PORT; the server reads it. FLINT_TOKEN + a provider are
# required at runtime (set them in the Railway service variables).
ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "--filter", "server", "start"]
