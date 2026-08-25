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
from prediction_service.generation.llm import DEFAULT_MODEL as DEFAULT_GEMINI_MODEL

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


def test_the_gemini_model_defaults_to_flash():
    assert settings_from_env({}).gemini.model == "gemini-3.7-flash"
    assert settings_from_env({}).gemini.model == DEFAULT_GEMINI_MODEL


def test_the_gemini_model_and_timeout_are_overridable_without_a_code_change():
    settings = settings_from_env(
        {"PREDICTION_GEMINI_MODEL": "gemini-4-preview", "PREDICTION_GEMINI_TIMEOUT_S": "45"}
    )

    assert settings.gemini.model == "gemini-4-preview"
    assert settings.gemini.timeout_s == 45.0


def test_the_previous_default_is_still_reachable_by_env_var():
    # The A/B this change exists to make cheap: back to Pro without a commit.
    settings = settings_from_env({"PREDICTION_GEMINI_MODEL": "gemini-3.1-pro-preview"})

    assert settings.gemini.model == "gemini-3.1-pro-preview"
    assert settings.gemini.is_priced()


def test_a_padded_model_name_is_trimmed_rather_than_sent_with_its_whitespace():
    # `--update-env-vars` copy-paste picks up spaces; a model id with one
    # would 404 per request, on /generate only.
    assert settings_from_env({"PREDICTION_GEMINI_MODEL": "  gemini-3.7-flash "}).gemini.model == (
        "gemini-3.7-flash"
    )


def test_an_empty_model_is_refused_at_startup_not_per_request():
    # An empty id builds `/v1beta/models/:generateContent`, which 404s on
    # every /generate while /health stays green -- the service looks fine and
    # writes no verdicts. A blank override is a typo, never an intent.
    env = dict(_SERVER_ENV, PREDICTION_GEMINI_MODEL="   ")

    with pytest.raises(ConfigError, match="PREDICTION_GEMINI_MODEL is empty"):
        settings_from_env(env).validate_for_server()


def test_an_unpriced_model_boots_and_only_reports_its_cost_as_unknown():
    # Deliberately NOT a startup failure: refusing to boot on an unknown id
    # would break the one case the knob exists for -- trying a model this
    # code has never seen. It runs; only the dollar figure is null.
    settings = settings_from_env(dict(_SERVER_ENV, PREDICTION_GEMINI_MODEL="gemini-9-preview"))

    settings.validate_for_server()
    assert not settings.gemini.is_priced()
    assert settings_from_env(_SERVER_ENV).gemini.is_priced()


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


# --- the saturation phase's settings (CRMA-765) ----------------------------


def test_the_saturation_defaults_are_the_documented_ones():
    saturation = settings_from_env({}).saturation

    assert saturation.exploding_topics_api_key == ""
    assert saturation.exploding_topics_timeout_s == 12.0
    assert saturation.gdelt_enabled is True
    assert saturation.gdelt_window_days == 7
    assert saturation.gdelt_timeout_s == 15.0
    # The phase-level ceiling the two per-call timeouts sit inside. Sized
    # against the Cloud Run request timeout -- see saturation/run.py.
    assert saturation.lookup_budget_s == 150.0
    assert saturation.min_observation_age_hours == 24.0
    assert saturation.min_evidence_chars == 120


def test_a_missing_exploding_topics_key_is_not_a_refuse_to_boot_condition():
    # ET is an oracle, not a gate: the PRD calls its access "an assumption
    # with an owner (a miss is never a penalty)", so a service without the
    # key still writes every verdict, each recording an explicit miss.
    settings_from_env(_SERVER_ENV).validate_for_server()


def test_the_gdelt_kill_switch_reads_the_usual_falsey_words():
    for value in ("0", "false", "FALSE", "no", "off", " Off "):
        assert settings_from_env({"PREDICTION_GDELT_ENABLED": value}).saturation.gdelt_enabled is (
            False
        )
    for value in ("1", "true", "yes", ""):
        assert settings_from_env(
            {"PREDICTION_GDELT_ENABLED": value or "1"}
        ).saturation.gdelt_enabled is True


def test_the_floor_thresholds_are_overridable_per_deploy():
    settings = settings_from_env(
        {
            "PREDICTION_FLOOR_MIN_OBSERVATION_AGE_HOURS": "48",
            "PREDICTION_FLOOR_MIN_EVIDENCE_CHARS": "200",
        }
    )

    assert settings.saturation.min_observation_age_hours == 48.0
    assert settings.saturation.min_evidence_chars == 200


def test_a_non_numeric_saturation_setting_names_itself():
    with pytest.raises(ConfigError, match="PREDICTION_GDELT_TIMEOUT_S"):
        settings_from_env({"PREDICTION_GDELT_TIMEOUT_S": "soon"})
