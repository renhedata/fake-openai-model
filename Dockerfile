FROM oven/bun:1 AS base

# --- Pruner stage ---
FROM base AS pruner
WORKDIR /app
RUN bun add -g turbo
COPY . .
RUN turbo prune @fake/server @fake/web --docker

# --- Build stage ---
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock /app/bun.lock
RUN bun install
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=@fake/web && bun run build --filter=@fake/server

# --- Runner stage (production only) ---
FROM base AS runner
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock /app/bun.lock
RUN bun install
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist
EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
