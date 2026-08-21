"""Startup-time settings validation (CRMA-762).

Both checks here exist because the failure they prevent is *silent*: an empty
IAP audience 401s every request (indistinguishable from a healthy locked-down
service when probed from outside), and missing key material sends the
Snowflake client to `externalbrowser`, which in a container blocks for ~120s
per request waiting for a browser that will never open.
"""

from __future__ import annotations

import pytest

from prediction_service.config import ConfigError, settings_from_env

AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"
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
