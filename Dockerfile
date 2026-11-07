# syntax=docker/dockerfile:1
#
# est2 app image: the built frontend (dist/) + the Express backend on one port.
# Used by compose.yaml locally, on any Docker host, and by Coolify's Docker Compose build pack.
#
# The base tag tracks the newest Node 24 LTS patch, so every rebuild picks up Node security
# releases (pin an exact version, e.g. node:24.22.2-bookworm-slim, only for reproducibility).
ARG NODE_IMAGE=node:24-bookworm-slim

# --- frontend: vite build -------------------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- backend production dependencies ---------------------------------------------------
FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    # No Python in this image: Silero runs as its own service (compose profile "tts").
    SILERO_AUTOSTART=false
WORKDIR /app

COPY --from=backend-deps --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node backend ./backend
COPY --chown=node:node shared ./shared
COPY --from=frontend --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/byok/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Apply pending DB migrations (idempotent, tracked in schema_migrations), then serve.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node backend/migrate.js || exit 1; fi; exec node backend/server.js"]
