# Build from the repo root: docker build -f server/Dockerfile -t cerebro-server:<git sha7> .
# Base pinned by digest (multi-arch index: linux/amd64 for the Zima host, arm64 for local builds).
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

# Claude Code CLI, pinned to the version on the owner's Mac (summariser runs it headless).
ARG CLAUDE_CODE_VERSION=2.1.325
RUN BUN_INSTALL=/usr/local bun install -g --trust "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version

RUN groupadd --gid 10010 cerebro \
 && useradd --uid 10010 --gid 10010 --create-home --shell /usr/sbin/nologin cerebro \
 && mkdir -p /data/claude && chown -R cerebro:cerebro /data

WORKDIR /app
COPY package.json bun.lock ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN bun install --production --frozen-lockfile
COPY shared shared
COPY server server

USER cerebro
ENV CLAUDE_CONFIG_DIR=/data/claude SUMMARISER_CMD=claude
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1))"
CMD ["bun", "--no-install", "server/src/main.ts"]
