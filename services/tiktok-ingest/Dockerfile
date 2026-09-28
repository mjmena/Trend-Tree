# trend-tree-tiktok-ingest image (CRMA-1337, epic CRMA-1336) — a Cloud Run JOB.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the job imports the
# shared services/lib/ modules (the ingest orchestration, the title filter,
# the SerpApi client):
#
#   docker build --platform linux/amd64 \
#     -f services/tiktok-ingest/Dockerfile \
#     -t trend-tree-tiktok-ingest .
#
# services/deploy.sh drives the real build (daemon-free, via crane) and must
# stage the same layout; services/deploy_layout.test.mjs checks the two agree.

FROM node:22-slim AS deps
WORKDIR /deps
COPY services/tiktok-ingest/package.json services/tiktok-ingest/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

COPY services/lib /app/services/lib
COPY services/tiktok-ingest /app/services/tiktok-ingest
COPY --from=deps /deps/node_modules /app/services/tiktok-ingest/node_modules

ENV NODE_ENV=production

USER node

WORKDIR /app/services/tiktok-ingest
CMD ["node", "ingest.mjs"]
