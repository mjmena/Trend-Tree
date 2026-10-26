# Build context is the repo root so the job can import services/lib/.
# services/deploy_layout.test.mjs checks deploy.sh stages the same layout.

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
