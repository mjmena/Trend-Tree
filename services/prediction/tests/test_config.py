"""Startup-time settings validation and auth-mode selection (CRMA-762).

The checks here exist because the failure each prevents is *silent*: an empty
audience 401s every request (indistinguishable from a healthy locked-down
service when probed from outside), an unrecognized auth mode would pick the
wrong credential, and missing key material sends the Snowflake client to
`externalbrowser`, which in a container blocks for ~120s per request waiting
for a browser that will never open.
"""

from __future__ import annotations

import pytest
from tt_services_lib.auth import AUTH_MODE_IAP, AUTH_MODE_OIDC

from prediction_service.config import ConfigError, settings_from_env

AUDIENCE = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
IAP_AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"
_SERVER_ENV = {
    "PREDICTION_SERVICE_AUDIENCE": AUDIENCE,
    "PREDICTION_SNOWFLAKE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
}


def test_valid_server_settings_pass():
    settings_from_env(_SERVER_ENV).validate_for_server()


def test_empty_audience_is_refused_at_startup():
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUDIENCE="")

    with pytest.raises(ConfigError, match="PREDICTION_SERVICE_AUDIENCE is empty"):
        settings_from_env(env).validate_for_server()


def test_whitespace_only_audience_is_refused():
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUDIENCE="   ")

    with pytest.raises(ConfigError, match="PREDICTION_SERVICE_AUDIENCE is empty"):
        settings_from_env(env).validate_for_server()


def test_missing_key_material_is_refused_at_startup():
    with pytest.raises(ConfigError, match="no Snowflake key material"):
        settings_from_env({"PREDICTION_SERVICE_AUDIENCE": AUDIENCE}).validate_for_server()


def test_a_key_path_counts_as_key_material():
    env = {
        "PREDICTION_SERVICE_AUDIENCE": AUDIENCE,
        "PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH": "/tmp/key.pem",
    }
    settings_from_env(env).validate_for_server()


def test_both_problems_are_reported_together():
    with pytest.raises(ConfigError) as exc_info:
        settings_from_env({}).validate_for_server()

    message = str(exc_info.value)
    assert "PREDICTION_SERVICE_AUDIENCE is empty" in message
    assert "no Snowflake key material" in message


def test_qualify_uses_the_configured_database_and_schema():
    settings = settings_from_env(_SERVER_ENV)
    assert (
        settings.qualify("FCT_PREDICTION_VERDICT_LEDGER")
        == "MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER"
    )


# --- auth-mode selection --------------------------------------------------


def test_auth_mode_defaults_to_cloud_run_iam_oidc():
    # How the service is actually deployed: Cloud Run IAM, invoker check on,
    # IAP off. A deploy that sets no mode must land here.
    assert settings_from_env({}).auth_mode == AUTH_MODE_OIDC


def test_a_blank_auth_mode_is_treated_as_unset():
    assert settings_from_env({"PREDICTION_SERVICE_AUTH_MODE": "  "}).auth_mode == AUTH_MODE_OIDC


def test_auth_mode_is_case_and_whitespace_insensitive():
    # IAP-shaped audience alongside the IAP mode -- the two travel together;
    # see test_an_audience_of_the_wrong_shape_for_the_mode_is_refused.
    env = dict(
        _SERVER_ENV,
        PREDICTION_SERVICE_AUTH_MODE=" IAP ",
        PREDICTION_SERVICE_AUDIENCE=IAP_AUDIENCE,
    )
    settings = settings_from_env(env)
    assert settings.auth_mode == AUTH_MODE_IAP
    settings.validate_for_server()


def test_iap_mode_is_selectable():
    env = dict(
        _SERVER_ENV,
        PREDICTION_SERVICE_AUTH_MODE=AUTH_MODE_IAP,
        PREDICTION_SERVICE_AUDIENCE=IAP_AUDIENCE,
    )
    settings = settings_from_env(env)
    assert settings.auth_mode == AUTH_MODE_IAP
    settings.validate_for_server()


def test_an_unknown_auth_mode_is_refused_at_startup():
    # Kept verbatim rather than silently defaulted, precisely so this fires.
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUTH_MODE="oid")

    with pytest.raises(ConfigError, match="PREDICTION_SERVICE_AUTH_MODE is 'oid'"):
        settings_from_env(env).validate_for_server()


def test_the_empty_audience_message_names_the_shape_the_mode_needs():
    oidc = dict(_SERVER_ENV, PREDICTION_SERVICE_AUDIENCE="")
    with pytest.raises(ConfigError) as exc_info:
        settings_from_env(oidc).validate_for_server()
    assert "a.run.app" in str(exc_info.value)

    iap = dict(oidc, PREDICTION_SERVICE_AUTH_MODE=AUTH_MODE_IAP)
    with pytest.raises(ConfigError) as exc_info:
        settings_from_env(iap).validate_for_server()
    assert "/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE}" in str(
        exc_info.value
    )


# --- audience shape vs. mode ----------------------------------------------
#
# The pairing is the point: the two audience shapes are not interchangeable,
# and getting them crossed is *invisible* from outside. The container boots,
# the edge still rejects unauthenticated callers exactly as it should, an
# authenticated probe of the unauthenticated /health still returns 200 -- and
# every real call 401s. A half-applied deploy or a hand-run
# `gcloud run services update --update-env-vars` produces precisely this.


def test_an_iap_shaped_audience_under_oidc_mode_is_refused():
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUDIENCE=IAP_AUDIENCE)  # mode defaults to oidc

    with pytest.raises(ConfigError) as exc_info:
        settings_from_env(env).validate_for_server()

    message = str(exc_info.value)
    assert "not the shape" in message
    assert "'https://'" in message


def test_a_url_shaped_audience_under_iap_mode_is_refused():
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUTH_MODE=AUTH_MODE_IAP)  # audience is the URL

    with pytest.raises(ConfigError) as exc_info:
        settings_from_env(env).validate_for_server()

    message = str(exc_info.value)
    assert "not the shape" in message
    assert "'/projects/'" in message


def test_a_matching_shape_passes_in_both_modes():
    settings_from_env(_SERVER_ENV).validate_for_server()
    settings_from_env(
        dict(
            _SERVER_ENV,
            PREDICTION_SERVICE_AUTH_MODE=AUTH_MODE_IAP,
            PREDICTION_SERVICE_AUDIENCE=IAP_AUDIENCE,
        )
    ).validate_for_server()


def test_an_http_only_audience_is_refused_under_oidc():
    # Cloud Run URLs are https; an http:// audience is a typo, and one that
    # would make every token's `aud` comparison fail.
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUDIENCE="http://trend-tree-prediction.a.run.app")

    with pytest.raises(ConfigError, match="not the shape"):
        settings_from_env(env).validate_for_server()


def test_an_unknown_mode_does_not_also_report_a_shape_problem():
    # One actionable error, not two: with the mode itself unrecognized there
    # is no shape to check the audience against.
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUTH_MODE="oid")

    with pytest.raises(ConfigError) as exc_info:
        settings_from_env(env).validate_for_server()

    message = str(exc_info.value)
    assert "PREDICTION_SERVICE_AUTH_MODE is 'oid'" in message
    assert "not the shape" not in message


# --- PORT ------------------------------------------------------------------


def test_a_non_numeric_port_is_a_config_error():
    # Not a bare ValueError: every other bad setting in this module surfaces
    # as ConfigError, and server.py's startup path reports that shape.
    with pytest.raises(ConfigError, match="PORT is 'eighty-eighty'"):
        settings_from_env(dict(_SERVER_ENV, PORT="eighty-eighty"))


def test_a_numeric_port_is_parsed():
    assert settings_from_env(dict(_SERVER_ENV, PORT="9090")).port == 9090


# --- the generation phase's model (CRMA-763) -------------------------------


def test_the_gemini_model_defaults_to_the_fleet_standard():
    assert settings_from_env({}).gemini.model == "gemini-3.1-pro-preview"


def test_the_gemini_model_and_timeout_are_overridable_without_a_code_change():
    settings = settings_from_env(
        {"PREDICTION_GEMINI_MODEL": "gemini-4-preview", "PREDICTION_GEMINI_TIMEOUT_S": "45"}
    )

    assert settings.gemini.model == "gemini-4-preview"
    assert settings.gemini.timeout_s == 45.0


def test_a_non_numeric_gemini_timeout_is_a_config_error():
    with pytest.raises(ConfigError, match="PREDICTION_GEMINI_TIMEOUT_S is 'soon'"):
        settings_from_env({"PREDICTION_GEMINI_TIMEOUT_S": "soon"})


def test_a_missing_gemini_key_does_not_stop_the_service_booting():
    # Deliberate: without it the service still serves /health, /whoami (the
    # deploy gate's probe) and /run -- only POST /generate answers 503. A dead
    # generation phase then surfaces as verdict-ledger staleness in the audit
    # agent's view, which is where the PRD wants it, rather than as a
    # container that will not start.
    settings = settings_from_env(_SERVER_ENV)

    assert settings.gemini.api_key == ""
    settings.validate_for_server()
