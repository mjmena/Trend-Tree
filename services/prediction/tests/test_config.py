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
    env = dict(_SERVER_ENV, PREDICTION_SERVICE_AUTH_MODE=" IAP ")
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
