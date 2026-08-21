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

import http.client
import json
import ssl
import urllib.error
import urllib.request

import pytest

from prediction_service.generation import llm as llm_module
from prediction_service.generation.llm import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MODEL,
    LONG_CONTEXT_THRESHOLD_TOKENS,
    RATES_PER_M,
    RATES_PER_M_LONG_CONTEXT,
    GeminiPredictionLLM,
    LLMError,
    TransientLLMError,
    TruncatedResponse,
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


def test_the_output_budget_leaves_room_for_thinking_and_five_predictions():
    # Gemini 3 counts thinking tokens against maxOutputTokens, and this is a
    # single-shot emission of up to five full predictions -- not a tool-loop
    # turn. The fleet's per-turn 8192 is the wrong shape here: thinking alone
    # can consume it, leaving a candidate with no text parts, which is a 502
    # and zero rows rather than a shorter answer.
    config = build_request_body(system="s", user="u")["generationConfig"]

    assert config["maxOutputTokens"] == DEFAULT_MAX_OUTPUT_TOKENS
    assert DEFAULT_MAX_OUTPUT_TOKENS >= 32768


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


def test_a_truncated_answer_is_reported_as_the_token_cap_not_as_bad_json():
    # The other MAX_TOKENS shape: the model emitted some text, then ran out
    # mid-object. Left to the parser this reads as "malformed JSON in the
    # model reply", which sends the reader after the reply's shape instead of
    # the budget that actually caused it.
    body = {
        "candidates": [
            {
                "content": {"parts": [{"text": '{"predictions": [{"subject_desc'}]},
                "finishReason": "MAX_TOKENS",
            }
        ],
        "usageMetadata": {"promptTokenCount": 900, "candidatesTokenCount": 8192},
    }

    with pytest.raises(TruncatedResponse, match="maxOutputTokens"):
        parse_response_body(body, model="m")


def test_a_normal_finish_with_text_is_not_mistaken_for_truncation():
    response = parse_response_body(_body('{"predictions": []}'), model="m")

    assert response.text == '{"predictions": []}'


def test_missing_usage_metadata_reports_zero_rather_than_crashing():
    body = {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}

    response = parse_response_body(body, model="m")

    assert (response.input_tokens, response.output_tokens, response.cost_usd) == (0, 0, 0.0)


# --- cost ------------------------------------------------------------------


def test_cost_uses_the_fleets_sub_200k_tier_rates_under_the_threshold():
    assert RATES_PER_M == {"input": 2.0, "output": 12.0}
    assert estimate_cost_usd(100_000, 0) == pytest.approx(0.2)
    assert estimate_cost_usd(0, 1_000) == pytest.approx(0.012)
    assert estimate_cost_usd(LONG_CONTEXT_THRESHOLD_TOKENS, 0) == pytest.approx(0.4)


def test_cost_switches_to_the_long_context_tier_once_the_prompt_crosses_200k():
    # signal_limit goes to 2000 at the route, so this is reachable, and a
    # hardcoded sub-200k rate silently understates it by half.
    assert RATES_PER_M_LONG_CONTEXT == {"input": 4.0, "output": 18.0}
    over = LONG_CONTEXT_THRESHOLD_TOKENS + 1

    assert estimate_cost_usd(over, 0) == pytest.approx(over / 1_000_000 * 4.0)
    assert estimate_cost_usd(over, 1_000) == pytest.approx(over / 1_000_000 * 4.0 + 0.018)
    # Same token counts, materially different bill.
    assert estimate_cost_usd(over, 1_000) > estimate_cost_usd(
        LONG_CONTEXT_THRESHOLD_TOKENS, 1_000
    )


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


# --- the real urllib branch ------------------------------------------------
#
# Everything above injects `transport`, so until these the entire production
# wire path -- the one that actually runs on Cloud Run -- had no coverage at
# all. These stub `urlopen` instead, which is the only thing between this
# code and a socket.


class _FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stub_urlopen(monkeypatch, behavior):
    seen = {}

    def fake_urlopen(request, timeout=None):
        seen["url"] = request.full_url
        seen["timeout"] = timeout
        seen["body"] = json.loads(request.data.decode())
        return behavior()

    monkeypatch.setattr(llm_module.urllib.request, "urlopen", fake_urlopen)
    return seen


def test_the_real_urllib_path_posts_and_parses(monkeypatch):
    payload = json.dumps(_body('{"predictions": []}')).encode()
    seen = _stub_urlopen(monkeypatch, lambda: _FakeResponse(payload))
    client = GeminiPredictionLLM("key-123", model="gemini-test", timeout_s=12.0)

    response = client.complete(system="sys", user="usr")

    assert response.text == '{"predictions": []}'
    assert seen["timeout"] == 12.0
    assert "gemini-test:generateContent" in seen["url"]
    assert seen["body"]["contents"][0]["parts"][0]["text"] == "usr"


def _raiser(exc):
    def raise_it():
        raise exc

    return raise_it


@pytest.mark.parametrize(
    "exc",
    [
        # A *read* timeout. urlopen(timeout=) only wraps connect failures in
        # URLError; this comes out of resp.read() bare, and with a 180s
        # budget on a thinking model it is a likely path. (socket.timeout is
        # an alias of TimeoutError since 3.10, so this covers both spellings.)
        TimeoutError("timed out"),
        http.client.RemoteDisconnected("Remote end closed connection"),
        http.client.IncompleteRead(b"partial"),
        ssl.SSLError("decryption failed"),
        ConnectionResetError("connection reset by peer"),
        urllib.error.URLError("name resolution failed"),
    ],
)
def test_every_transport_failure_normalizes_to_an_llm_error(monkeypatch, exc):
    # If any of these escapes as its own type it bypasses the route's
    # `except (LLMError, UnparseableResponse)` and hits the catch-all, which
    # answers "generation failed reading the signal corpus" -- sending the
    # operator to debug Snowflake for a Gemini timeout.
    _stub_urlopen(monkeypatch, _raiser(exc))
    client = GeminiPredictionLLM("key-123", max_attempts=1)

    with pytest.raises(LLMError, match="Gemini request failed"):
        client.complete(system="s", user="u")


def test_a_non_json_body_from_the_real_path_is_an_llm_error(monkeypatch):
    _stub_urlopen(monkeypatch, lambda: _FakeResponse(b"<html>502 Bad Gateway</html>"))
    client = GeminiPredictionLLM("key-123", max_attempts=1)

    with pytest.raises(LLMError, match="non-JSON body"):
        client.complete(system="s", user="u")


def _http_error(code: int, body: bytes = b"quota exceeded"):
    import io

    return urllib.error.HTTPError(
        url="https://example.invalid", code=code, msg="err", hdrs=None, fp=io.BytesIO(body)
    )


def test_an_http_error_never_echoes_the_url_that_carries_the_key(monkeypatch):
    _stub_urlopen(monkeypatch, _raiser(_http_error(400, b"bad request")))
    client = GeminiPredictionLLM("sk-secret-123", max_attempts=1)

    with pytest.raises(LLMError) as err:
        client.complete(system="s", user="u")

    assert "sk-secret-123" not in str(err.value)


# --- retry -----------------------------------------------------------------


class _Sequence:
    """Answers with each item in turn; raises the ones that are exceptions."""

    def __init__(self, items):
        self._items = list(items)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_a_transient_status_is_retried_and_can_succeed(monkeypatch, status):
    # One 429 from a preview model used to kill the whole run: the Pipedream
    # fleet gets workflow-level retry, a Cloud Run request gets none.
    payload = json.dumps(_body('{"predictions": []}')).encode()
    behavior = _Sequence([_http_error(status), _FakeResponse(payload)])
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM("key-123", max_attempts=3, retry_wait_s=0)

    response = client.complete(system="s", user="u")

    assert response.text == '{"predictions": []}'
    assert behavior.calls == 2


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_a_client_error_is_never_retried(monkeypatch, status):
    # A request this code will keep getting wrong. Retrying it only burns the
    # backoff and, on a paid endpoint, the operator's patience.
    behavior = _Sequence([_http_error(status)] * 3)
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM("key-123", max_attempts=3, retry_wait_s=0)

    with pytest.raises(LLMError):
        client.complete(system="s", user="u")

    assert behavior.calls == 1


def test_a_transport_failure_is_retried_then_reraised_as_an_llm_error(monkeypatch):
    behavior = _Sequence([TimeoutError("timed out")] * 3)
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM("key-123", max_attempts=3, retry_wait_s=0)

    with pytest.raises(TransientLLMError, match="Gemini request failed"):
        client.complete(system="s", user="u")

    assert behavior.calls == 3


def test_a_successful_call_is_never_re_issued(monkeypatch):
    # The double-charge guard: only _post is retried, and only when it
    # raised. A body that came back is never asked for twice.
    payload = json.dumps(_body('{"predictions": []}')).encode()
    behavior = _Sequence([_FakeResponse(payload)])
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM("key-123", max_attempts=3, retry_wait_s=0)

    client.complete(system="s", user="u")

    assert behavior.calls == 1


def test_a_truncated_answer_is_not_retried(monkeypatch):
    # It is not transient: the same prompt with the same budget truncates
    # again. Retrying would triple the bill for the same failure.
    body = {
        "candidates": [
            {"content": {"parts": [{"text": '{"pred'}]}, "finishReason": "MAX_TOKENS"}
        ],
        "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 10},
    }
    behavior = _Sequence([_FakeResponse(json.dumps(body).encode())] * 3)
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM("key-123", max_attempts=3, retry_wait_s=0)

    with pytest.raises(TruncatedResponse):
        client.complete(system="s", user="u")

    assert behavior.calls == 1


def test_the_retry_budget_stops_at_a_wall_clock_deadline_too(monkeypatch):
    # The deployed revision runs with `--timeout 600` (deploy/deploy.sh).
    # Three 180-second attempts plus backoff would spend the whole request,
    # so the caller would get Cloud Run's 504 rather than a diagnosable error
    # -- and the verdict writes after generation would never run.
    behavior = _Sequence([TimeoutError("timed out")] * 5)
    _stub_urlopen(monkeypatch, behavior)
    client = GeminiPredictionLLM(
        "key-123", max_attempts=99, retry_wait_s=0, retry_deadline_s=0
    )

    with pytest.raises(TransientLLMError):
        client.complete(system="s", user="u")

    # The deadline had already passed, so no second attempt was started.
    assert behavior.calls == 1


def test_the_default_retry_budget_fits_inside_the_cloud_run_request_timeout():
    from prediction_service.generation.llm import (
        DEFAULT_MAX_ATTEMPTS,
        DEFAULT_RETRY_DEADLINE_S,
        DEFAULT_TIMEOUT_S,
    )

    # No attempt starts past the deadline, so the worst case is the deadline
    # plus one full per-attempt timeout. deploy.sh runs `--timeout 600`.
    assert DEFAULT_RETRY_DEADLINE_S + DEFAULT_TIMEOUT_S < 600
    assert DEFAULT_MAX_ATTEMPTS >= 2
