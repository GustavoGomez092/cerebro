# Build from the repo root: docker build -f web/Dockerfile -t cerebro-web:<git sha7> .
# Same pinned Bun base as cerebro-server (multi-arch index: linux/amd64 for the Zima host, arm64 for local builds).
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/
RUN bun install --frozen-lockfile --filter @cerebro/web
COPY web web
RUN cd web && bun --bun x vite build

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
RUN groupadd --gid 10011 cerebroweb \
 && useradd --uid 10011 --gid 10011 --no-create-home --shell /usr/sbin/nologin cerebroweb
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/
RUN bun install --production --frozen-lockfile --filter @cerebro/web
COPY --from=build /app/web/dist web/dist
COPY web/server.ts web/
# The owner seed (docker exec … bun web/scripts/create-owner.ts) imports the server modules from source.
COPY web/scripts web/scripts
COPY web/src/server web/src/server

USER cerebroweb
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1))"
CMD ["bun", "--no-install", "web/server.ts"]
