FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN install -d -o node -g node /preview
WORKDIR /preview
COPY --chown=node:node . .
RUN node scripts/prepare-runtime.mjs
USER node
RUN npm ci --ignore-scripts && npm test && node test/runtime-smoke.mjs
ARG OPENCLAW_VERSION=2026.11.7
RUN npm install --prefix /tmp/stock --ignore-scripts --no-audit --no-fund "openclaw@$OPENCLAW_VERSION" \
    && OPENCLAW_TEST_ROOT=/tmp/stock/node_modules/openclaw npm run test:package
