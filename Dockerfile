FROM oven/bun:1 AS base

# --- Pruner stage ---
FROM base AS pruner
WORKDIR /app
RUN bun add -g turbo
COPY . .
RUN turbo prune @fake/server --docker
RUN turbo prune @fake/web --docker

# --- Installer & Builder stage for Server ---
FROM base AS server-builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock /app/bun.lock
RUN bun install
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=@fake/server

# --- Installer & Builder stage for Web ---
FROM base AS web-builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/bun.lock /app/bun.lock
RUN bun install
COPY --from=pruner /app/out/full/ .
RUN bun run build --filter=@fake/web

# --- Final Runner for Server ---
FROM base AS server
WORKDIR /app
COPY --from=server-builder /app .
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/server", "start"]

# --- Final Runner for Web (Nginx) ---
FROM nginx:alpine AS web
# Copy static files
COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
# SPA config for Nginx
RUN echo 'server { \
    listen 5173; \
    server_name localhost; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ /index.html; \
    } \
    location /v1 { proxy_pass http://server:3000; } \
    location /proxy { proxy_pass http://server:3000; } \
    location /events { \
        proxy_pass http://server:3000; \
        proxy_set_header Connection ""; \
        proxy_http_version 1.1; \
        proxy_buffering off; \
        proxy_cache off; \
    } \
    location /trpc { proxy_pass http://server:3000; } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
