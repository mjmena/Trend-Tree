# trend-tree-scrape-gateway image (CRMA-986, map CRMA-977).
#
# BUILD CONTEXT IS THE REPO ROOT, not this directory — the image needs the
# sibling services/lib/ tree (CRMA-439's shared-module home), which this
# service imports directly, including services/lib/normalize/:
#
#   docker build --platform linux/amd64 \
#     -f services/scrape-gateway/Dockerfile \
#     -t trend-tree-scrape-gateway .
#
# services/deploy.sh drives this; see it for the full dark-deploy flow.
#
# The in-image layout mirrors the repo's so relative imports resolve unchanged
# (services/scrape-gateway/*.mjs -> ../lib/*.mjs). Only the two services/
# subtrees are copied — no agents/, no sql/, no docs/.

FROM node:22-slim AS deps
WORKDIR /deps
# Manifests only, so this layer caches across code changes. `npm ci` (not
# `npm install`) so the image is built from the committed lockfile.
#
# This service currently declares NO dependencies — Node 22 supplies global
# fetch, which is all the vendor client needs. The stage is kept anyway: it
# costs one cached layer, it keeps this Dockerfile identical in shape to
# services/ecomm-agent/Dockerfile, and it means adding a first dependency is a
# one-line package.json change rather than a Dockerfile restructure.
COPY services/scrape-gateway/package.json services/scrape-gateway/package-lock.json ./
# `mkdir -p` is load-bearing, not defensive. With zero dependencies `npm ci`
# succeeds but creates NO node_modules directory at all, and the runtime
# stage's `COPY --from=deps /deps/node_modules` then fails the build on a
# missing source path. Verified against this lockfile on 2026-09-07.
# It is a no-op the moment this service gains its first dependency.
RUN npm ci --omit=dev && mkdir -p /deps/node_modules

FROM node:22-slim
WORKDIR /app

# First-party code first, dependencies after: COPY merges directories, and
# copying the service tree over an already-populated node_modules would be a
# needless ordering hazard.
COPY services/lib /app/services/lib
COPY services/scrape-gateway /app/services/scrape-gateway
COPY --from=deps /deps/node_modules /app/services/scrape-gateway/node_modules

ENV NODE_ENV=production \
    PORT=8080

# Drop root: nothing in this image writes to disk, and the node base image
# ships an unprivileged `node` user for exactly this.
USER node

WORKDIR /app/services/scrape-gateway
EXPOSE 8080
CMD ["node", "server.mjs"]
