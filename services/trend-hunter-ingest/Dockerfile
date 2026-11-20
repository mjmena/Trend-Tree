FROM node:22-slim AS deps
WORKDIR /deps
COPY services/trend-hunter-ingest/package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app/services/trend-hunter-ingest
COPY services/lib /app/services/lib
COPY services/trend-hunter-ingest ./
COPY --from=deps /deps/node_modules ./node_modules
ENV NODE_ENV=production
USER node
CMD ["node", "ingest.mjs"]
