# Build context: repository root (npm workspaces share one lockfile).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY demo-target/api/package.json demo-target/api/
COPY demo-target/web/package.json demo-target/web/
RUN npm ci -w demo-target/web --include-workspace-root=false
COPY demo-target/web demo-target/web
RUN npm run build -w demo-target/web

FROM nginx:1.27-alpine
COPY demo-target/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/demo-target/web/dist /usr/share/nginx/html
