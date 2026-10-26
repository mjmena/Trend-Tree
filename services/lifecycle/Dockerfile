# trend-tree-lifecycle image — a Cloud Run JOB.
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the job imports the
# shared services/lib/ modules:
#
#   docker build --platform linux/amd64 \
#     -f services/lifecycle/Dockerfile \
#     -t trend-tree-lifecycle .
#
# services/deploy.sh drives the real build (daemon-free, via crane) and must
# stage the same layout; services/deploy_layout.test.mjs checks the two agree.

FROM node:22-slim AS deps
WORKDIR /deps
COPY services/lifecycle/package.json services/lifecycle/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

COPY services/lib /app/services/lib
COPY services/lifecycle /app/services/lifecycle
COPY --from=deps /deps/node_modules /app/services/lifecycle/node_modules

ENV NODE_ENV=production

USER node

WORKDIR /app/services/lifecycle
CMD ["node", "tick.mjs"]
