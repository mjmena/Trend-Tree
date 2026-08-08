# PROTOTYPE (CRMA-438) — containerized local enrichment loop. Throwaway.
# Build:  docker build -t enrich-proto .
# Run:    docker run --rm -e GEMINI_API_KEY \
#           enrich-proto <trend_id> --fixture
# Fixtures are baked into the image (capture them first); live Snowflake
# mode would need snow CLI + auth mounted, which is out of scope for the
# ergonomics question this prototype answers.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY fixtures ./fixtures
ENTRYPOINT ["node", "src/run.mjs"]
