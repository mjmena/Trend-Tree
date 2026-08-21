# trend-tree-ecomm-agent image (CRMA-776, epic CRMA-772).
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the image needs the
# sibling services/lib/ tree (CRMA-439's shared-module home), which the service
# imports directly now that Cloud Run bundles real cross-file imports:
#
#   docker build --platform linux/amd64 \
#     -f services/ecomm-agent/Dockerfile \
#     -t trend-tree-ecomm-agent .
#
# services/deploy.sh drives this; see it for the full dark-deploy flow.
#
# The in-image layout mirrors the repo's so relative imports resolve unchanged
# (services/ecomm-agent/*.mjs -> ../lib/*.mjs). Only the two services/
# subtrees are copied — no agents/, no sql/, no docs/.

FROM node:22-slim AS deps
WORKDIR /deps
# Manifests only, so this layer caches across code changes. `npm ci` (not
# `npm install`) so the image is built from the committed lockfile.
COPY services/ecomm-agent/package.json services/ecomm-agent/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

# First-party code first, dependencies after: COPY merges directories, and
# copying the service tree over an already-populated node_modules would be a
# needless ordering hazard.
COPY services/lib /app/services/lib
COPY services/ecomm-agent /app/services/ecomm-agent
COPY --from=deps /deps/node_modules /app/services/ecomm-agent/node_modules

ENV NODE_ENV=production \
    PORT=8080

# Drop root: nothing in this image writes to disk, and the node base image
# ships an unprivileged `node` user for exactly this.
USER node

WORKDIR /app/services/ecomm-agent
EXPOSE 8080
CMD ["node", "server.mjs"]
