# Browser version must match the playwright package version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    # The container runs as an arbitrary UID (see deploy/docker-compose.yml); give Chromium a writable home.
    HOME=/tmp \
    RUNNER_DATA=/data \
    RUNNER_PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/runner/server.ts"]
