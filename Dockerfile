FROM oven/bun:1 AS base

# --- Pruner stage ---
FROM base AS pruner
WORKDIR /app
RUN bun add -g turbo
COPY . .
RUN turbo prune @fake/server --docker
RUN turbo prune @fake/web --docker

# --- Build all ---
FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock /app/bun.lock
RUN bun install
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=@fake/web
RUN bun run build --filter=@fake/server

# --- Final Runner ---
FROM base AS runner
WORKDIR /app
COPY --from=builder /app .
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/server", "start"]
