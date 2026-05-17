# syntax=docker/dockerfile:1.7

FROM node:24-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/mcp/package.json packages/mcp/tsconfig.json packages/mcp/
COPY packages/cli/package.json packages/cli/tsconfig.json packages/cli/

RUN corepack pnpm install --frozen-lockfile

COPY packages/core/src ./packages/core/src
COPY packages/mcp/src ./packages/mcp/src
COPY packages/cli/src ./packages/cli/src

RUN corepack pnpm --filter codex-sidecar-core build \
 && corepack pnpm --filter codex-sidecar-mcp build


FROM node:24-slim AS runtime
# Pin codex CLI to the host-installed version. Update via CODEX_CLI_VERSION build arg.
ARG CODEX_CLI_VERSION=0.130.0
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
 && npm cache clean --force

WORKDIR /app
ENV NODE_ENV=production
ENV CODEX_SIDECAR_MCP_TRANSPORT=http
ENV CODEX_SIDECAR_MCP_HOST=0.0.0.0
ENV CODEX_SIDECAR_MCP_PORT=39201

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist

RUN corepack pnpm install --frozen-lockfile --prod \
 && corepack pnpm store prune

EXPOSE 39201

# Codex App Server reads ~/.codex; mount host ~/.codex to /root/.codex via compose.
CMD ["node", "packages/mcp/dist/server.js"]
