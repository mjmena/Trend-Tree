"""Service configuration from env (PREDICTION_ prefix).

PREDICTION_SERVICE_AUTH_MODE picks the ingress-auth layer: ``oidc`` (Cloud Run
IAM -- the default, and how the service is actually deployed) or ``iap``.
PREDICTION_SERVICE_AUDIENCE has to match the mode; see Settings.audience.

``settings_from_env`` takes ``env`` as an argument rather than reading
os.environ directly, so tests can build settings without touching the
environment (matches prism's config.py).

On Cloud Run the private key arrives as PEM *content* in
PREDICTION_SNOWFLAKE_PRIVATE_KEY (bound from Secret Manager
``snowflake-private-key``, the same secret prism/helm/audience-builder use --
CRMBOT_SERVICE_USER's MARKETING_ENGINEER role already reaches both
MCC_RAW.MARKETING_DEV and MCC_PRESENTATION.TREND_AGENT per the existing
Pipedream connected-account queries in this repo's own workflows); locally you
either point PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH at a PEM file, or fall
through to externalbrowser SSO.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from tt_services_lib.auth import (
    AUTH_MODE_IAP,
    AUTH_MODE_OIDC,
    AUTH_MODES,
    DEFAULT_AUTH_MODE,
)

from .generation.llm import DEFAULT_MODEL as DEFAULT_GEMINI_MODEL
from .generation.llm import rates_for

# The prefix an audience must carry in each mode. The two shapes are not
# interchangeable: an OIDC token's `aud` is this service's URL, an IAP
# assertion's is the `/projects/{NUM}/locations/{REGION}/services/{SVC}`
# string. Pairing one mode with the other's audience produces a container
# that boots, answers the unauthenticated /health probe exactly like a
# healthy one, and 401s every real call -- see validate_for_server.
_AUDIENCE_PREFIXES: dict[str, str] = {
    AUTH_MODE_OIDC: "https://",
    AUTH_MODE_IAP: "/projects/",
}


class ConfigError(RuntimeError):
    """Settings that cannot serve traffic. Raised at startup, never per
    request -- a misconfigured deploy should refuse to come up, not serve
    401s or 500s that read as "locked down and healthy"."""


@dataclass(frozen=True)
class SnowflakeSettings:
    account: str
    user: str
    role: str
    warehouse: str
    # Qualifies every table reference -- see Settings.qualify(). Never rely on
    # the connection's default database/schema for a query.
    database: str
    schema: str
    # externalbrowser locally; keypair on Cloud Run
    authenticator: str
    private_key_path: str
    # PEM content -- how Cloud Run passes it (Secret Manager env), vs a path locally
    private_key: str


@dataclass(frozen=True)
class GeminiSettings:
    """The generation phase's LLM (CRMA-763). The fleet runs on Google
    Gemini; ``model`` comes from PREDICTION_GEMINI_MODEL and defaults to
    generation.llm.DEFAULT_MODEL (``gemini-3.7-flash``), so trying another
    model is one env var, not a redeploy of code. local_generate.py's
    ``--model`` is the same switch for the offline loop.

    An **unpriced** model is allowed on purpose -- refusing to boot on one
    would make the config knob useless for exactly the case it exists for,
    trying a model this code has never seen. What it costs is a null rather
    than a guess (llm.estimate_cost_usd), and ``is_priced`` lets the
    caller say so out loud at startup.

    ``api_key`` is deliberately NOT part of validate_for_server's refuse-to-
    boot set: without it the service still serves /health, /whoami (the
    deploy gate's probe) and /run, and only POST /generate fails -- as a 503
    that names the missing variable. A dead generation phase then surfaces
    the way the PRD asks for, as verdict-ledger staleness in the audit
    agent's view, rather than as a container that will not start.
    """

    api_key: str
    model: str
    timeout_s: float

    def is_priced(self) -> bool:
        """Whether llm.py knows this model's rates. False does not stop the
        service: the run works, its reported cost is null."""
        return rates_for(self.model, 0) is not None


@dataclass(frozen=True)
class SaturationSettings:
    """The saturation phase's two external oracles and the data-quality floor
    (CRMA-765).

    **No value here can refuse a boot.** The PRD lists Exploding Topics access
    as "an assumption with an owner (a miss is never a penalty)", so a missing
    key degrades that oracle to an explicit ``not_configured`` miss and the
    run carries on -- the same stance GeminiSettings takes on its key, with
    more force: an unavailable oracle must not stop the pillar writing
    verdicts, because saturation is evidence, not a gate.

    The floor's thresholds are settings for the same reason the strategy
    insists it is the *only* mechanical gate: re-tuning the pillar's one gate
    should be a visible, deliberate change. See saturation/floor.py for how
    the defaults were measured.
    """

    exploding_topics_api_key: str
    exploding_topics_timeout_s: float
    gdelt_enabled: bool
    gdelt_window_days: int
    gdelt_timeout_s: float
    min_observation_age_hours: float
    min_evidence_chars: int


@dataclass(frozen=True)
class Settings:
    snowflake: SnowflakeSettings
    gemini: GeminiSettings
    saturation: SaturationSettings
    port: int
    # Which ingress-auth layer fronts this service -- `oidc` (Cloud Run IAM,
    # the deployed posture) or `iap`. See tt_services_lib.auth for what each
    # one changes; it also decides what `audience` below has to be.
    auth_mode: str
    # The value an incoming token's `aud` claim must match. Under `oidc` that
    # is this service's URL (https://{SERVICE}-{HASH}-{REGION}.a.run.app);
    # under `iap` it is the IAP audience string
    # `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}`.
    # Set at deploy time (see deploy/deploy.sh); empty locally, where tests
    # inject a fake verifier instead of checking a real audience.
    audience: str

    def expected_audience_shape(self) -> str:
        """What `audience` should look like in this mode -- for error
        messages, so a misconfigured deploy says what to set, not just that
        something is unset."""
        if self.auth_mode == AUTH_MODE_IAP:
            return "/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE}"
        return "this service's URL, e.g. https://{SERVICE}-{HASH}-{REGION}.a.run.app"

    def qualify(self, table: str) -> str:
        """``<database>.<schema>.<table>`` -- see the note on
        SnowflakeSettings.database."""
        return f"{self.snowflake.database}.{self.snowflake.schema}.{table}"

    def validate_for_server(self) -> None:
        """Refuse to boot a server on settings that only *look* like they
        work. Both checks below otherwise fail late and misleadingly:

        * an empty ``audience`` fails closed -- every request 401s -- so a
          service that never received PREDICTION_SERVICE_AUDIENCE looks
          identical from the edge to one that is correctly locked down. An
          unrecognized ``auth_mode`` is the same class of problem, and is
          refused here rather than at the first request.
        * an ``audience`` of the wrong *shape* for the mode fails exactly the
          same way, and is the more likely accident: a half-applied deploy or
          a hand-run ``gcloud run services update --update-env-vars`` can pair
          ``auth_mode=oidc`` with an IAP-shaped audience. Nothing downstream
          notices -- the container boots, the unauthenticated health probe is
          rejected at the edge as usual, the authenticated one returns 200 --
          and every real call 401s while the service looks correctly locked
          down from outside.
        * with no key material the Snowflake client falls through to
          ``externalbrowser``, which in a container blocks for ~120s waiting
          for a browser that will never open, and then errors -- per request.
        * an empty ``PREDICTION_GEMINI_MODEL`` builds the request URL
          ``/v1beta/models/:generateContent``, which 404s -- per request, and
          only on /generate, so the service looks healthy while it writes no
          verdicts at all. A blank override is a deploy typo, never an intent.

        Called from server.py, not from ``settings_from_env``: tests and any
        non-server caller still build Settings freely.
        """
        problems: list[str] = []
        mode_known = self.auth_mode in AUTH_MODES
        if not mode_known:
            problems.append(
                f"PREDICTION_SERVICE_AUTH_MODE is {self.auth_mode!r}, not one of "
                f"{list(AUTH_MODES)}. Leave it unset for {DEFAULT_AUTH_MODE!r} (Cloud Run IAM)."
            )
        audience = self.audience.strip()
        if not audience:
            problems.append(
                "PREDICTION_SERVICE_AUDIENCE is empty -- every token would fail its audience "
                "check and every request would 401. Set it to "
                f"{self.expected_audience_shape()} (deploy/deploy.sh does this)."
            )
        elif mode_known and not audience.startswith(_AUDIENCE_PREFIXES[self.auth_mode]):
            # Shape only, not identity: whether the URL is *this* service's is
            # not knowable from inside the container. This catches the
            # mode/audience mismatch, which is the failure that hides.
            problems.append(
                f"PREDICTION_SERVICE_AUDIENCE is {self.audience!r}, which is not the shape "
                f"PREDICTION_SERVICE_AUTH_MODE={self.auth_mode!r} needs (expected it to start "
                f"with {_AUDIENCE_PREFIXES[self.auth_mode]!r} -- "
                f"{self.expected_audience_shape()}). Every request would 401 while the "
                "service looked locked down from outside."
            )
        if not self.gemini.model.strip():
            problems.append(
                "PREDICTION_GEMINI_MODEL is empty -- every /generate call would ask "
                "Gemini for a model with no name and 404. Leave it unset for "
                f"{DEFAULT_GEMINI_MODEL!r}."
            )
        if not (self.snowflake.private_key or self.snowflake.private_key_path):
            problems.append(
                "no Snowflake key material: neither PREDICTION_SNOWFLAKE_PRIVATE_KEY nor "
                f"PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH is set, so the client would fall back "
                f"to authenticator={self.snowflake.authenticator!r} -- interactive auth, which "
                "cannot succeed in a server process."
            )
        if problems:
            raise ConfigError("refusing to start: " + "; ".join(problems))


def _timeout(raw: str) -> float:
    try:
        return float(raw)
    except ValueError as err:
        raise ConfigError(
            f"PREDICTION_GEMINI_TIMEOUT_S is {raw!r}, which is not a number"
        ) from err


def _number(name: str, raw: str) -> float:
    """A numeric env var, or a ConfigError naming it. Same class of failure as
    _timeout, generalized because the saturation phase carries several."""
    try:
        return float(raw)
    except ValueError as err:
        raise ConfigError(f"{name} is {raw!r}, which is not a number") from err


def _port(raw: str) -> int:
    """A non-numeric PORT is a config problem like any other, so it surfaces
    as ConfigError rather than a bare ValueError from int()."""
    try:
        return int(raw)
    except ValueError as err:
        raise ConfigError(f"PORT is {raw!r}, which is not an integer") from err


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    e = os.environ if env is None else env
    return Settings(
        snowflake=SnowflakeSettings(
            account=e.get("PREDICTION_SNOWFLAKE_ACCOUNT", "WVB49304-MCCLATCHY_EVAL"),
            user=e.get("PREDICTION_SNOWFLAKE_USER", "CRMBOT_SERVICE_USER"),
            role=e.get("PREDICTION_SNOWFLAKE_ROLE", "MARKETING_ENGINEER"),
            warehouse=e.get("PREDICTION_SNOWFLAKE_WAREHOUSE", "MARKETING_WH"),
            database=e.get("PREDICTION_SNOWFLAKE_DATABASE", "MCC_PRESENTATION"),
            schema=e.get("PREDICTION_SNOWFLAKE_SCHEMA", "TREND_AGENT"),
            authenticator=e.get("PREDICTION_SNOWFLAKE_AUTHENTICATOR", "externalbrowser"),
            private_key_path=e.get("PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH", ""),
            private_key=e.get("PREDICTION_SNOWFLAKE_PRIVATE_KEY", ""),
        ),
        saturation=SaturationSettings(
            exploding_topics_api_key=e.get("PREDICTION_EXPLODING_TOPICS_API_KEY", ""),
            exploding_topics_timeout_s=_number(
                "PREDICTION_EXPLODING_TOPICS_TIMEOUT_S",
                e.get("PREDICTION_EXPLODING_TOPICS_TIMEOUT_S", "20"),
            ),
            # A kill switch, not a tuning knob: GDELT is unauthenticated and
            # rate-limits by IP, so a run that starts getting throttled can be
            # turned off without a code change. Off means "unavailable", which
            # the evidence renders as "we could not look" -- never as "nobody
            # is writing about this".
            gdelt_enabled=(e.get("PREDICTION_GDELT_ENABLED", "1").strip().lower()
                           not in ("0", "false", "no", "off")),
            gdelt_window_days=int(
                _number("PREDICTION_GDELT_WINDOW_DAYS", e.get("PREDICTION_GDELT_WINDOW_DAYS", "7"))
            ),
            gdelt_timeout_s=_number(
                "PREDICTION_GDELT_TIMEOUT_S", e.get("PREDICTION_GDELT_TIMEOUT_S", "25")
            ),
            min_observation_age_hours=_number(
                "PREDICTION_FLOOR_MIN_OBSERVATION_AGE_HOURS",
                e.get("PREDICTION_FLOOR_MIN_OBSERVATION_AGE_HOURS", "24"),
            ),
            min_evidence_chars=int(
                _number(
                    "PREDICTION_FLOOR_MIN_EVIDENCE_CHARS",
                    e.get("PREDICTION_FLOOR_MIN_EVIDENCE_CHARS", "120"),
                )
            ),
        ),
        gemini=GeminiSettings(
            api_key=e.get("PREDICTION_GEMINI_API_KEY", ""),
            # Kept verbatim apart from surrounding whitespace: an unknown
            # model is a legitimate override (it just bills as unknown), an
            # empty one is refused by validate_for_server.
            model=e.get("PREDICTION_GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip(),
            timeout_s=_timeout(e.get("PREDICTION_GEMINI_TIMEOUT_S", "180")),
        ),
        port=_port(e.get("PORT", "8080")),
        # Unset or blank means the deployed posture (Cloud Run IAM). A value
        # that is set but unrecognized is kept verbatim so validate_for_server
        # can refuse it -- a typo must not silently fall back to a default.
        auth_mode=(e.get("PREDICTION_SERVICE_AUTH_MODE") or "").strip().lower()
        or DEFAULT_AUTH_MODE,
        audience=e.get("PREDICTION_SERVICE_AUDIENCE", ""),
    )
