# trend-tree-prediction image. Build context is the REPO ROOT (not this
# directory), because the image also needs the sibling services/lib source
# tree. Mirrors prism's api/Dockerfile pattern: a Docker-daemon environment
# (CI, once wired) builds from this file as the source of truth for image
# contents; local dev builds the same /app layout daemon-free via
# deploy/deploy.sh (crane) -- there is no Docker daemon on a dev Mac, and
# Cloud Build is blocked in mcc-crm-automations.
#
#   docker build --platform linux/amd64 -f services/prediction/Dockerfile \
#     -t trend-tree-prediction .

FROM python:3.12-slim AS deps
WORKDIR /build
# Dependencies only -- no service code yet -- so this layer caches across code
# changes. Only prediction/'s pyproject.toml is needed here: it declares every
# third-party runtime dependency directly (fastapi, snowflake-connector-python,
# tenacity, google-auth, ...); services/lib's own pyproject.toml exists for its
# standalone test suite; tt_services_lib itself is copied as source below, not
# pip-installed (see the note on the final COPY step).
COPY services/prediction/pyproject.toml services/prediction/pyproject.toml
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --target /vendor ./services/prediction

FROM python:3.12-slim
WORKDIR /app

COPY --from=deps /vendor /app/vendor
# First-party code is copied as source, not pip-installed -- matches prism's
# `COPY prism /app/prism`. Both packages sit directly under /app so `python -m
# prediction_service.server` (which adds the CWD to sys.path) resolves
# `import tt_services_lib...` and `import prediction_service...` without any
# extra packaging step for the shared lib.
COPY services/lib/tt_services_lib /app/tt_services_lib
COPY services/prediction/prediction_service /app/prediction_service

ENV PYTHONPATH=/app/vendor \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080
CMD ["python", "-m", "prediction_service.server"]
