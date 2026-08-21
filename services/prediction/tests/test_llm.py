"""The Gemini seam (CRMA-763).

The adapter is the only part of the generation phase that knows a network
exists, so everything testable about it was pulled out as pure functions --
the request body, the response parse, the cost arithmetic. The transport is
injected, so even the adapter's own ``complete`` runs offline here.

Model choice: gemini-3.1-pro-preview, the same model agents/lib/gemini_loop.mjs
drives for the Pipedream agents. This fleet is on Gemini; there is no
Anthropic client in this service.
"""

from __future__ import annotations

import pytest

from prediction_service.generation.llm import (
    DEFAULT_MODEL,
    RATES_PER_M,
    GeminiPredictionLLM,
    LLMError,
    build_request_body,
    estimate_cost_usd,
    parse_response_body,
)


def _body(text: str, *, prompt_tokens: int = 1000, candidate_tokens: int = 200) -> dict:
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {
            "promptTokenCount": prompt_tokens,
            "candidatesTokenCount": candidate_tokens,
        },
    }


def test_the_model_is_the_fleet_standard_gemini():
    assert DEFAULT_MODEL == "gemini-3.1-pro-preview"


# --- the request body ------------------------------------------------------


def test_the_request_carries_the_system_instruction_and_the_user_turn():
    body = build_request_body(system="you are the agent", user="here is the corpus")

    assert body["systemInstruction"]["parts"][0]["text"] == "you are the agent"
    assert body["contents"][0]["role"] == "user"
    assert body["contents"][0]["parts"][0]["text"] == "here is the corpus"


def test_temperature_is_one_because_thinking_is_enabled():
    # Gemini requires temperature 1.0 while thinking is on -- the fleet's
    # gemini_loop.mjs carries the same constraint, learned there.
    config = build_request_body(system="s", user="u")["generationConfig"]

    assert config["temperature"] == 1.0
    assert config["thinkingConfig"] == {"thinkingLevel": "medium"}


def test_the_request_asks_for_json_and_declares_no_tools():
    # No tools declared, so the repo's grounding gotcha (never set
    # responseMimeType alongside the Google Search tool) does not apply --
    # and generation gets no second, ungoverned way to see the world.
    body = build_request_body(system="s", user="u")

    assert body["generationConfig"]["responseMimeType"] == "application/json"
    assert "tools" not in body


# --- the response ----------------------------------------------------------


def test_the_answer_text_and_usage_come_back():
    response = parse_response_body(_body('{"predictions": []}'), model="m")

    assert response.text == '{"predictions": []}'
    assert response.model == "m"
    assert response.input_tokens == 1000
    assert response.output_tokens == 200
    assert response.total_tokens == 1200


def test_thought_parts_are_not_mistaken_for_the_answer():
    body = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {"text": "let me consider the corpus", "thought": True},
                        {"text": '{"predictions": []}'},
                    ]
                }
            }
        ],
        "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1},
    }

    assert parse_response_body(body, model="m").text == '{"predictions": []}'


def test_a_blocked_reply_is_an_llm_error_naming_the_prompt_feedback():
    body = {"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}}

    with pytest.raises(LLMError, match="SAFETY"):
        parse_response_body(body, model="m")


def test_a_reply_with_no_answer_text_is_an_llm_error_naming_the_finish_reason():
    # The shape a MAX_TOKENS truncation takes when the model spent its whole
    # budget thinking: candidates present, answer empty.
    body = {"candidates": [{"content": {"parts": []}, "finishReason": "MAX_TOKENS"}]}

    with pytest.raises(LLMError, match="MAX_TOKENS"):
        parse_response_body(body, model="m")


def test_missing_usage_metadata_reports_zero_rather_than_crashing():
    body = {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}

    response = parse_response_body(body, model="m")

    assert (response.input_tokens, response.output_tokens, response.cost_usd) == (0, 0, 0.0)


# --- cost ------------------------------------------------------------------


def test_cost_uses_the_fleets_sub_200k_tier_rates():
    assert RATES_PER_M == {"input": 2.0, "output": 12.0}
    assert estimate_cost_usd(1_000_000, 0) == 2.0
    assert estimate_cost_usd(0, 1_000_000) == 12.0
    assert estimate_cost_usd(500_000, 100_000) == pytest.approx(2.2)


# --- the adapter, through an injected transport ----------------------------


def test_complete_posts_the_built_body_and_returns_the_parsed_answer():
    seen = {}

    def transport(*, url, api_key, payload):
        seen.update(url=url, api_key=api_key, payload=payload)
        return _body('{"predictions": []}')

    llm = GeminiPredictionLLM("key-123", model="gemini-test", transport=transport)

    response = llm.complete(system="sys", user="usr")

    assert response.text == '{"predictions": []}'
    assert response.model == "gemini-test"
    assert response.cost_usd == estimate_cost_usd(1000, 200)
    assert "gemini-test:generateContent" in seen["url"]
    assert seen["api_key"] == "key-123"
    assert seen["payload"]["contents"][0]["parts"][0]["text"] == "usr"


def test_an_empty_api_key_is_refused_at_construction():
    # Fail where it is diagnosable, not on the first live run.
    with pytest.raises(LLMError, match="API key"):
        GeminiPredictionLLM("   ")
