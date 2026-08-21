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
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

log = logging.getLogger(__name__)

DEFAULT_MODEL = "gemini-3.1-pro-preview"
_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Sub-200k context tier, USD per million tokens -- same rates the fleet's
#: gemini_loop.mjs bills against.
RATES_PER_M = {"input": 2.0, "output": 12.0}

DEFAULT_MAX_OUTPUT_TOKENS = 8192
DEFAULT_THINKING_LEVEL = "medium"
DEFAULT_TIMEOUT_S = 180.0


class LLMError(RuntimeError):
    """The model call failed, or answered with something unusable."""


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


def estimate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Pure -- unit-tested, and the same arithmetic the Pipedream fleet uses
    so per-run costs stay comparable across platforms."""
    cost = (input_tokens / 1_000_000) * RATES_PER_M["input"] + (
        output_tokens / 1_000_000
    ) * RATES_PER_M["output"]
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
    parts = ((candidate.get("content") or {}).get("parts")) or []
    # A part flagged `thought` is the model's scratchpad, not its answer.
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    if not text.strip():
        raise LLMError(
            f"Gemini returned no answer text (finishReason={candidate.get('finishReason')!r})"
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
        transport: Any = None,
    ) -> None:
        if not api_key.strip():
            raise LLMError("a Gemini API key is required")
        self._api_key = api_key
        self._model = model
        self._timeout_s = timeout_s
        self._max_output_tokens = max_output_tokens
        self._thinking_level = thinking_level
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
            raise LLMError(f"Gemini HTTP {err.code}: {detail}") from err
        except urllib.error.URLError as err:
            raise LLMError(f"Gemini request failed: {err.reason}") from err
        except json.JSONDecodeError as err:
            raise LLMError(f"Gemini returned a non-JSON body: {err}") from err

    def complete(self, *, system: str, user: str) -> LLMResponse:
        body = self._post(
            build_request_body(
                system=system,
                user=user,
                max_output_tokens=self._max_output_tokens,
                thinking_level=self._thinking_level,
            )
        )
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
