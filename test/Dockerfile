FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN install -d -o node -g node /preview
WORKDIR /preview
COPY --chown=node:node . .
RUN node scripts/prepare-runtime.mjs
USER node
RUN npm ci --ignore-scripts && npm test && node test/runtime-smoke.mjs
ARG OPENCLAW_VERSIONS="2026.11.7 2026.11.8 2026.11.9 2026.11.10"
RUN set -e; for version in $OPENCLAW_VERSIONS; do \
    npm install --prefix /tmp/stock --ignore-scripts --no-audit --no-fund "openclaw@$version"; \
    OPENCLAW_TEST_ROOT=/tmp/stock/node_modules/openclaw npm run test:package; \
    done
