# trend-tree-catalog-sync image (CRMA-777, epic CRMA-772) — a Cloud Run JOB.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the job imports the
# shared services/lib/ modules (the catalog planner, the SQL builders, the
# storefront sweep):
#
#   docker build --platform linux/amd64 \
#     -f services/catalog-sync/Dockerfile \
#     -t trend-tree-catalog-sync .
#
# services/deploy.sh drives the real build (daemon-free, via crane) and must
# stage the same layout; services/deploy_layout.test.mjs checks the two agree.

FROM node:22-slim AS deps
WORKDIR /deps
COPY services/catalog-sync/package.json services/catalog-sync/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

COPY services/lib /app/services/lib
COPY services/catalog-sync /app/services/catalog-sync
COPY --from=deps /deps/node_modules /app/services/catalog-sync/node_modules

ENV NODE_ENV=production

USER node

WORKDIR /app/services/catalog-sync
CMD ["node", "sync.mjs"]
