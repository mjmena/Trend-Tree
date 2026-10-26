# trend-tree-editorial-ingest image. Build context is the REPO ROOT: the image
# also needs services/lib/tt_services_lib. Same layout as services/prediction.
# What actually ships is services/deploy.sh's daemon-free crane build
# (RUNTIME=python); services/deploy_layout.test.mjs checks the two agree.
#
#   docker build --platform linux/amd64 -f services/editorial-ingest/Dockerfile \
#     -t trend-tree-editorial-ingest .

FROM python:3.12-slim AS deps
WORKDIR /build
COPY services/editorial-ingest/pyproject.toml services/editorial-ingest/pyproject.toml
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --target /vendor ./services/editorial-ingest

FROM python:3.12-slim
WORKDIR /app
COPY --from=deps /vendor /app/vendor
COPY services/lib/tt_services_lib /app/tt_services_lib
COPY services/editorial-ingest/editorial_ingest /app/editorial_ingest

ENV PYTHONPATH=/app/vendor \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080
CMD ["python", "-m", "editorial_ingest.server"]
