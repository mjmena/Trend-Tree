"""Production wiring: the real retrying Snowflake client, real Google token
verification for the configured auth mode (both defaults on create_app /
RetryingSnowflakeClient).

Run with `python -m prediction_service.server`, or point uvicorn at
`prediction_service.server:app`.
"""

from __future__ import annotations

import logging

import uvicorn
from tt_services_lib.snowflake_client import RetryingSnowflakeClient

from .app import create_app
from .config import Settings, settings_from_env
from .generation.llm import GeminiPredictionLLM, PredictionLLM
from .saturation import build_saturation_phase

logging.basicConfig(level=logging.INFO)

log = logging.getLogger(__name__)


def build_llm(settings: Settings) -> PredictionLLM | None:
    """The generation phase's model, or None when no key is configured.

    None is a degraded service, not a dead one: /health, /whoami (the deploy
    gate's probe) and /run all still work, and only POST /generate answers
    503. The dead-generation case then surfaces where the PRD wants it --
    as verdict-ledger staleness in the audit agent's view -- rather than as a
    container that will not start.
    """
    if not settings.gemini.api_key.strip():
        log.warning(
            "PREDICTION_GEMINI_API_KEY is not set: POST /generate will answer 503 and this "
            "service will write no verdicts. Every other route is unaffected."
        )
        return None
    if not settings.gemini.is_priced():
        # Not a failure -- an unlisted model runs fine, it just cannot be
        # costed. Said out loud here so a null LLM_COST_ESTIMATE later reads
        # as "nobody priced this model" rather than "the cost code broke".
        log.warning(
            "PREDICTION_GEMINI_MODEL=%r is not in generation/llm.py's rate table: this "
            "service will report its cost as null rather than guess at another model's "
            "rates. Add it to the table to get costs back.",
            settings.gemini.model,
        )
    return GeminiPredictionLLM(
        settings.gemini.api_key,
        model=settings.gemini.model,
        timeout_s=settings.gemini.timeout_s,
    )


settings = settings_from_env()
# Raises ConfigError on settings that cannot serve traffic (empty audience,
# unknown auth mode, no Snowflake key material) -- the container fails to
# start rather than coming up and 401-ing or hanging on every request.
settings.validate_for_server()
app = create_app(
    settings=settings,
    snowflake=RetryingSnowflakeClient(settings.snowflake),
    llm=build_llm(settings),
    # The saturation phase's real Exploding Topics and GDELT adapters
    # (CRMA-765). Built here rather than inside create_app so that the only
    # process which reaches the network is the deployed one; every other
    # caller gets SaturationPhase.offline(), whose misses are explicit.
    saturation=build_saturation_phase(settings),
)


def main() -> None:
    # timeout_graceful_shutdown lets an in-flight verdict write finish when
    # Cloud Run sends SIGTERM ahead of reclaiming a scaled-to-zero instance.
    uvicorn.run(
        app,
        host="0.0.0.0",  # noqa: S104 - Cloud Run routes to the container's port
        port=settings.port,
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__":
    main()
