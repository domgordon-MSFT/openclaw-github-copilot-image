FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN install -d -o node -g node /preview
WORKDIR /preview
COPY --chown=node:node . .
RUN sh scripts/prepare-linux-runtime.sh
USER node
RUN npm ci --ignore-scripts && npm test
RUN npm install --prefix /tmp/stock --ignore-scripts --no-audit --no-fund openclaw@2026.11.7 \
    && OPENCLAW_TEST_ROOT=/tmp/stock/node_modules/openclaw npm run test:package
