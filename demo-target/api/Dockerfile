# Build context: repository root (npm workspaces share one lockfile).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY demo-target/api/package.json demo-target/api/
COPY demo-target/web/package.json demo-target/web/
RUN npm ci --omit=dev -w demo-target/api --include-workspace-root=false
COPY demo-target/api/src demo-target/api/src
WORKDIR /app/demo-target/api
RUN mkdir -p /tmp/chaos
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=2s --retries=3 CMD wget -qO- http://127.0.0.1:3000/livez || exit 1
CMD ["node", "src/index.js"]
