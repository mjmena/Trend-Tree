"""The LLM seam for the generation phase (CRMA-763).

``PredictionLLM`` is a one-method Protocol, so every test in this service
runs offline against an injected fake and the local loop can replay a
recorded reply (see generation/fixtures.py, local_generate.py). The concrete
adapter is the only thing here that knows a network exists.

Model: **gemini-3.1-pro-preview**, matching the fleet's agent work
(``agents/lib/gemini_loop.mjs``, used by distillation, promotion, lifecycle,
enrichment) and the PRD's "the fleet-standard Gemini path". This fleet is on
Google Gemini; there is no Anthropic client in this service.

Two constraints carried over from the fleet's loop, both learned the hard
way there:

* ``temperature`` must be 1.0 when thinking is enabled.
* ``responseMimeType: application/json`` is safe *here* because this call
  declares no tools -- the repo's grounding gotcha (do not set
  responseMimeType alongside the Google Search tool) applies to the discovery
  agents, not to a toolless single-shot generation call.

A single generateContent call, not a tool loop: this phase reads one corpus
slice it was handed and returns claims. Live cultural grounding is the
enrichment agent's job, and giving generation a search tool would hand it a
second, ungoverned way to see the world.

**One shape the fleet's loop does NOT share with this call**: the fleet's
8192-token cap is per *turn* of a tool loop, where a turn usually emits a
function call and a sentence. This call is a single-shot structured emission
of up to five full predictions, and Gemini 3 bills thinking tokens against
the same ``maxOutputTokens`` budget -- see DEFAULT_MAX_OUTPUT_TOKENS.
"""

from __future__ import annotations

import http.client
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from tenacity import (
    Retrying,
    retry_if_exception_type,
    stop_after_attempt,
    stop_after_delay,
    wait_exponential_jitter,
)

log = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.1-pro-preview"
_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Gemini 3 Pro prices the whole request by its *prompt* size: at or below
#: 200k prompt tokens the sub-200k tier applies (the same rates the fleet's
#: gemini_loop.mjs bills against), above it the long-context tier does.
#: ``estimate_cost_usd`` picks between them rather than silently understating
#: a long run -- at signal_limit=2000 the prompt can cross the boundary.
LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
RATES_PER_M = {"input": 2.0, "output": 12.0}
RATES_PER_M_LONG_CONTEXT = {"input": 4.0, "output": 18.0}

#: **Shared with thinking.** Gemini 3 counts ``thinkingLevel`` tokens against
#: ``maxOutputTokens``, so this budget has to cover the reasoning *and* the
#: answer. The fleet's 8192 (agents/lib/gemini_loop.mjs) is a per-turn cap in
#: a tool loop where a turn emits a function call and a sentence; this is a
#: single-shot emission of up to five full predictions -- roughly 450 tokens
#: each once ``reasoning`` is counted, so ~2.5k of answer -- underneath
#: medium-level thinking over a 200-signal corpus, which routinely runs into
#: five figures. At 8192 the thinking alone can consume the budget, leaving a
#: candidate with no text parts: an LLMError, a 502, and zero rows. Total
#: failure, not degraded output.
#:
#: 32768 is a ceiling, not a reservation -- billing is on the tokens actually
#: produced (``candidatesTokenCount``), so a run that thinks briefly still
#: costs what it costs. It bounds the worst case at 32768/1e6 * $12 = $0.39
#: of output, inside the envelope the enrichment agent already runs in
#: ($0.15 median/run), and leaves headroom under the model's own 64k output
#: limit rather than asking for the maximum.
DEFAULT_MAX_OUTPUT_TOKENS = 32768
DEFAULT_THINKING_LEVEL = "medium"
DEFAULT_TIMEOUT_S = 180.0

#: A preview model answers 429/503 under load, and a 180-second read on a
#: thinking model is long enough for a transport to give out mid-response.
#: The Pipedream fleet gets workflow-level retry for free; a Cloud Run
#: request does not, so the adapter carries its own.
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_RETRY_WAIT_S = 1.0

#: ...and the retrying has to finish inside the *request*, not just inside
#: three attempts. The deployed revision runs with `--timeout 600`
#: (deploy/deploy.sh), and three 180-second attempts plus backoff would spend
#: essentially all of it -- the caller would get Cloud Run's own 504 instead
#: of this module's diagnosable error, and the verdict writes after
#: generation would never run. No new attempt starts past this mark, which
#: leaves the slowest possible in-flight attempt finishing around 510s and
#: the rest of the request room to complete.
DEFAULT_RETRY_DEADLINE_S = 330.0

#: HTTP statuses worth trying again. Everything else -- 400, 401, 403, 404,
#: 422 -- is a request this code will keep getting wrong, and retrying it
#: only burns the backoff.
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})


class LLMError(RuntimeError):
    """The model call failed, or answered with something unusable."""


class TransientLLMError(LLMError):
    """A failure that a later attempt could plausibly survive: a retryable
    HTTP status, or a transport that went away. Kept a subclass of LLMError
    so callers that only care about "the model call failed" (the route's
    502 branch) need no change."""


class TruncatedResponse(LLMError):
    """The model hit ``maxOutputTokens`` mid-answer. Its own category because
    the remedy is a bigger budget or a smaller corpus, and reporting it as a
    parse failure sends the reader after the reply's shape instead."""


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class PredictionLLM(Protocol):
    def complete(self, *, system: str, user: str) -> LLMResponse: ...


def rates_for(input_tokens: int) -> dict[str, float]:
    """Which price tier a request with this prompt size bills at."""
    if input_tokens > LONG_CONTEXT_THRESHOLD_TOKENS:
        return RATES_PER_M_LONG_CONTEXT
    return RATES_PER_M


def estimate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Pure -- unit-tested, and the same arithmetic the Pipedream fleet uses
    so per-run costs stay comparable across platforms, plus the long-context
    tier the fleet's tool-loop turns never reach."""
    rates = rates_for(input_tokens)
    cost = (input_tokens / 1_000_000) * rates["input"] + (output_tokens / 1_000_000) * rates[
        "output"
    ]
    return round(cost, 6)


def build_request_body(
    *,
    system: str,
    user: str,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    thinking_level: str = DEFAULT_THINKING_LEVEL,
) -> dict[str, Any]:
    """The generateContent payload. Pure, so the wire shape is assertable
    without a network."""
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            # Required to be 1.0 while thinking is on -- see the module note.
            "temperature": 1.0,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingLevel": thinking_level},
        },
    }


def parse_response_body(body: Any, *, model: str) -> LLMResponse:
    """Pull the text and usage out of a generateContent response. Pure, so
    the awkward cases (blocked, truncated, thought-only) are unit-testable."""
    if not isinstance(body, dict):
        raise LLMError(f"expected a JSON object from Gemini, got {type(body).__name__}")

    usage = body.get("usageMetadata") or {}
    input_tokens = int(usage.get("promptTokenCount") or 0)
    # candidatesTokenCount already includes thinking tokens -- do NOT add
    # thoughtsTokenCount (same note as the fleet's gemini_loop.mjs).
    output_tokens = int(usage.get("candidatesTokenCount") or 0)

    candidates = body.get("candidates") or []
    if not candidates:
        feedback = body.get("promptFeedback") or {}
        raise LLMError(f"Gemini returned no candidates (promptFeedback={feedback})")
    candidate = candidates[0] or {}
    finish_reason = candidate.get("finishReason")
    parts = ((candidate.get("content") or {}).get("parts")) or []
    # A part flagged `thought` is the model's scratchpad, not its answer.
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    if not text.strip():
        raise LLMError(f"Gemini returned no answer text (finishReason={finish_reason!r})")
    if finish_reason == "MAX_TOKENS":
        # Non-empty *and* truncated: the JSON is cut off mid-object. Left to
        # the parser this surfaces as "malformed JSON in the model reply",
        # which blames the reply's shape for what is really the token cap.
        raise TruncatedResponse(
            "Gemini stopped at maxOutputTokens with the answer unfinished "
            f"({output_tokens} output tokens, thinking included). Raise "
            "max_output_tokens or lower signal_limit / max_predictions."
        )
    return LLMResponse(
        text=text,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=estimate_cost_usd(input_tokens, output_tokens),
    )


class GeminiPredictionLLM:
    """The production adapter. stdlib ``urllib`` on purpose: the service's
    only outbound HTTP call, and not worth a runtime dependency the deployed
    image would otherwise not need."""

    def __init__(
        self,
        api_key: str,
        *,
        model: str = DEFAULT_MODEL,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
        thinking_level: str = DEFAULT_THINKING_LEVEL,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        retry_wait_s: float = DEFAULT_RETRY_WAIT_S,
        retry_deadline_s: float = DEFAULT_RETRY_DEADLINE_S,
        transport: Any = None,
    ) -> None:
        if not api_key.strip():
            raise LLMError("a Gemini API key is required")
        self._api_key = api_key
        self._model = model
        self._timeout_s = timeout_s
        self._max_output_tokens = max_output_tokens
        self._thinking_level = thinking_level
        self._max_attempts = max_attempts
        self._retry_wait_s = retry_wait_s
        self._retry_deadline_s = retry_deadline_s
        # Injected in tests so the wire handling is exercised without a
        # network; None means real urllib.
        self._transport = transport

    @property
    def model(self) -> str:
        return self._model

    def _post(self, payload: dict[str, Any]) -> Any:
        url = _ENDPOINT.format(model=self._model)
        data = json.dumps(payload).encode()
        if self._transport is not None:
            return self._transport(url=url, api_key=self._api_key, payload=payload)
        request = urllib.request.Request(  # noqa: S310 - fixed https endpoint above
            f"{url}?key={self._api_key}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as resp:  # noqa: S310
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            # The key rides in the query string; never echo the URL back.
            detail = err.read().decode(errors="replace")[:600]
            message = f"Gemini HTTP {err.code}: {detail}"
            if err.code in _RETRYABLE_STATUSES:
                raise TransientLLMError(message) from err
            raise LLMError(message) from err
        except json.JSONDecodeError as err:
            raise LLMError(f"Gemini returned a non-JSON body: {err}") from err
        except (OSError, http.client.HTTPException) as err:
            # Everything transport-shaped, normalized into one type.
            #
            # ``urlopen(timeout=)`` only wraps *connect* failures in
            # URLError. A read timeout surfaces as a bare TimeoutError from
            # resp.read(), and a truncated response as
            # http.client.IncompleteRead / RemoteDisconnected; TLS failures
            # come through as ssl.SSLError. Left un-normalized these escape
            # the route's `except (LLMError, UnparseableResponse)` and land
            # in its catch-all, which answers "generation failed reading the
            # signal corpus" -- sending the operator to debug Snowflake for a
            # Gemini timeout. URLError, ssl.SSLError, socket.timeout and
            # TimeoutError are all OSError subclasses, so this one clause
            # covers them; http.client.HTTPException is the one family that
            # is not.
            reason = getattr(err, "reason", None) or err
            raise TransientLLMError(f"Gemini request failed: {reason}") from err

    def _log_retry(self, retry_state: Any) -> None:
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        log.warning(
            "gemini generation call failed (attempt %s/%s), retrying: %s",
            retry_state.attempt_number,
            self._max_attempts,
            exc,
        )

    def complete(self, *, system: str, user: str) -> LLMResponse:
        payload = build_request_body(
            system=system,
            user=user,
            max_output_tokens=self._max_output_tokens,
            thinking_level=self._thinking_level,
        )
        # Only _post is retried, and only on TransientLLMError. A call that
        # returned a body is never re-issued, so a successful generation is
        # never billed twice by this loop. (A read timeout is the one
        # ambiguous case -- the far side may have finished and we lost the
        # answer. Retrying it is still right: an answer we cannot read is
        # worth nothing, and the exposure is bounded by max_attempts.)
        retrying = Retrying(
            retry=retry_if_exception_type(TransientLLMError),
            # Whichever comes first: the attempt count, or the wall-clock
            # budget the surrounding HTTP request can actually afford.
            stop=stop_after_attempt(self._max_attempts) | stop_after_delay(
                self._retry_deadline_s
            ),
            wait=wait_exponential_jitter(initial=self._retry_wait_s, max=8),
            reraise=True,
            before_sleep=self._log_retry,
        )
        body = retrying(self._post, payload)
        response = parse_response_body(body, model=self._model)
        log.info(
            "gemini generation call",
            extra={
                "model": response.model,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "cost_usd": response.cost_usd,
            },
        )
        return response


class ReplayLLM:
    """Returns a canned reply. The local loop's default so a fixture-driven
    run costs nothing and needs no key; also what tests inject."""

    def __init__(self, text: str, *, model: str = "replay") -> None:
        self._text = text
        self._model = model
        self.calls: list[tuple[str, str]] = []

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        return LLMResponse(
            text=self._text, model=self._model, input_tokens=0, output_tokens=0, cost_usd=0.0
        )
