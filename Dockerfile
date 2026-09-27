# Chaos: API + CLI + built UI, with Chromium for browser faults.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY demo-target/api/package.json demo-target/api/
COPY demo-target/web/package.json demo-target/web/
RUN npm ci -w web --include-workspace-root=false
COPY web web
RUN npm run build -w web

# Same Playwright version as playwright-core in server/package.json.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY demo-target/api/package.json demo-target/api/
COPY demo-target/web/package.json demo-target/web/
RUN npm ci --omit=dev -w server --include-workspace-root=false && npm cache clean --force
COPY server/src server/src
COPY server/bin server/bin
COPY --from=build /app/web/dist web/dist
RUN ln -s /app/server/bin/chaos.js /usr/local/bin/chaos
ENV NODE_ENV=production \
    CHAOS_HOST=127.0.0.1 \
    CHAOS_PORT=8090 \
    CHAOS_WEB_DIR=/app/web/dist \
    CHAOS_DATA_DIR=/data \
    CHAOS_TARGETS_FILE=/config/chaos.targets.yaml \
    CHAOS_SCENARIOS_DIR=/config/scenarios
# SIGTERM aborts the active run and reverts every fault before exiting.
STOPSIGNAL SIGTERM
CMD ["node", "server/src/index.js"]
