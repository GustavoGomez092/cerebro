# Build from the repo root: docker build -f server/Dockerfile .
FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN bun install --production --frozen-lockfile
COPY shared shared
COPY server server
USER bun
EXPOSE 8790
CMD ["bun", "--no-install", "server/src/main.ts"]
