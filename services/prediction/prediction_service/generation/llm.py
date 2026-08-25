"""The LLM seam for the generation phase (CRMA-763).

``PredictionLLM`` is a one-method Protocol, so every test in this service
runs offline against an injected fake and the local loop can replay a
recorded reply (see generation/fixtures.py, local_generate.py). The concrete
adapter is the only thing here that knows a network exists.

Model: **``gemini-3.7-flash``**, and configurable -- set
``PREDICTION_GEMINI_MODEL`` (config.GeminiSettings) or pass ``--model`` to
local_generate.py, so comparing two models is an env var rather than a code
edit. This fleet is on Google Gemini; there is no Anthropic client in this
service.

Why Flash is the default *here* when it is not viable everywhere in the
fleet: 3.7 Flash silently drops the head of its answer -- the reply begins
mid-object -- but only on **grounded** calls, at ~41-45% of them
(docs/wayfinder/gemini-3-7-flash-model-allocation.md, from CRMA-757 and
CRMA-730). The same crossed measurement found the ungrounded side clean --
9 whole / 0 truncated, "no ungrounded run has ever truncated". This call
declares no tools, so it sits on the clean side of that line: 5/5 whole
replies measured live through this module's own parse path, at ~9s median
against ~19-21s for gemini-3.1-pro-preview, with equivalent claim quality
and ~3x lower rates. ``assert_head_intact`` below is insurance against that
defect turning up in a shape nobody measured, not a fix for anything seen on
this call.

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
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol

from tenacity import (
    Retrying,
    retry_if_exception_type,
    stop_after_attempt,
    stop_after_delay,
    wait_exponential_jitter,
)

log = logging.getLogger(__name__)

MODEL_GEMINI_3_1_PRO = "gemini-3.1-pro-preview"
MODEL_GEMINI_3_7_FLASH = "gemini-3.7-flash"

#: Overridable per deploy via PREDICTION_GEMINI_MODEL -- see the module note
#: for why the toolless shape of this call is what makes Flash safe here.
DEFAULT_MODEL = MODEL_GEMINI_3_7_FLASH

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

#: Rates are **per model**. The repo carries thirteen hardcoded rate tables
#: and no shared constant, and one of them bills a Pro-pinned lane at another
#: model's rates and under-reports it ~40% (daily-digest, per the model map).
#: The defence against joining that list is that an id this table does not
#: know bills as *unknown* (``rates_for`` -> None) rather than inheriting
#: whatever the last model happened to cost.
#:
#: gemini-3.1-pro-preview prices the whole request by its *prompt* size: at or
#: below 200k prompt tokens the sub-200k tier applies, above it the
#: long-context tier does. ``rates_for`` picks between them rather than
#: silently understating a long run -- at signal_limit=2000 the prompt can
#: cross the boundary. 3.7 Flash publishes no long-prompt tier.
#:
#: Sources: https://openrouter.ai/google/gemini-3.7-flash and
#: https://www.morphllm.com/gemini-api-pricing, corroborated by
#: ai.google.dev/gemini-api/docs/pricing as recorded in
#: docs/wayfinder/gemini-3-7-flash-model-allocation.md.
LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
PRO_RATES_PER_M = {"input": 2.0, "output": 12.0}
PRO_RATES_PER_M_LONG_CONTEXT = {"input": 4.0, "output": 18.0}

#: 3.7 Flash's launch price is **introductory and scheduled to double** on
#: this date -- a published change, not a rumour. Hardcoding the introductory
#: rate would silently halve every reported cost from January onwards, which
#: is exactly the kind of quiet understatement the audit agent's per-model
#: rollups cannot see. Encoded as a date so ``rates_for`` switches on its own
#: rather than needing a code change on New Year's Day.
FLASH_INTRODUCTORY_PRICING_ENDS = date(2027, 1, 1)
FLASH_RATES_PER_M_INTRODUCTORY = {"input": 0.75, "output": 3.75}
FLASH_RATES_PER_M_STANDARD = {"input": 1.5, "output": 7.5}

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
#: produced (answer *plus* thinking; see parse_response_body), so a run that
#: thinks briefly still costs what it costs. The reasoning above is about
#: tokens, not dollars, so it survives the default moving to 3.7 Flash: both
#: models cap output at ~64k (3.7 Flash 65,536), and neither lets thinking be
#: turned off, so the budget still has to cover reasoning plus five
#: predictions either way.
#:
#: The **dollar** bound is per model, and is no longer the $0.39 this comment
#: used to quote for Pro alone: 32768/1e6 output tokens costs $0.39 on
#: gemini-3.1-pro-preview, $0.12 on gemini-3.7-flash at the introductory rate
#: and $0.25 once that rate doubles in 2027. Every one of those is inside the
#: envelope the enrichment agent already runs in ($0.15 median/run), so the
#: cheaper default widens the margin rather than needing a smaller ceiling.
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


class HeadTruncatedResponse(LLMError):
    """The answer arrived with its *opening* missing -- it starts partway
    into the JSON rather than at ``{`` or ``[``. The opposite end of the
    reply from TruncatedResponse, and a different remedy: nothing about the
    budget or the corpus fixes it, the model has to be changed or the call
    re-shaped."""


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    input_tokens: int
    #: Answer tokens **plus** thinking tokens -- what the model bills for.
    output_tokens: int
    #: None when the model is not in llm.py's rate table: unknown, not zero
    #: and not another model's price. See estimate_cost_usd.
    cost_usd: float | None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class PredictionLLM(Protocol):
    def complete(self, *, system: str, user: str) -> LLMResponse: ...


def rates_for(
    model: str, input_tokens: int, *, on: date | None = None
) -> dict[str, float] | None:
    """The per-million rates ``model`` bills at, or **None if it is not priced
    here**.

    ``on`` is the date the call is billed on -- a parameter, not a read of the
    clock, so the 2027 Flash changeover is testable both sides of the line.
    """
    if model == MODEL_GEMINI_3_1_PRO:
        if input_tokens > LONG_CONTEXT_THRESHOLD_TOKENS:
            return PRO_RATES_PER_M_LONG_CONTEXT
        return PRO_RATES_PER_M
    if model == MODEL_GEMINI_3_7_FLASH:
        today = on or datetime.now(UTC).date()
        if today < FLASH_INTRODUCTORY_PRICING_ENDS:
            return FLASH_RATES_PER_M_INTRODUCTORY
        return FLASH_RATES_PER_M_STANDARD
    return None


def estimate_cost_usd(
    input_tokens: int, output_tokens: int, *, model: str, on: date | None = None
) -> float | None:
    """Pure -- unit-tested. ``output_tokens`` is expected to already include
    thinking (see parse_response_body).

    **None means "this model is not priced here"**, and is deliberately not a
    fallback to some other model's rates: a run on an id nobody has priced
    should report its cost as unknown, because a confidently wrong number
    survives into the audit agent's per-model rollups and is summed there
    without complaint, while a null is visible as a gap.
    """
    rates = rates_for(model, input_tokens, on=on)
    if rates is None:
        return None
    cost = (input_tokens / 1_000_000) * rates["input"] + (output_tokens / 1_000_000) * rates[
        "output"
    ]
    return round(cost, 6)


#: The parser tolerates a fence; so does this guard, for the same reason --
#: a model that ignores "no code fence" is still answering the question. Kept
#: local rather than imported from parse.py: this is a check on the *model's*
#: behaviour at the transport seam, and parse.py stays a pure text->claims
#: module with no notion of who produced the text.
_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


def assert_head_intact(text: str) -> None:
    """Refuse a reply whose opening ``{`` or ``[`` is missing.

    **Cheap insurance, not a fix for an observed failure on this call.** The
    grounded-call defect that motivates it (module note; ~41-45% of grounded
    3.7 Flash calls lose the head of the answer) has never been seen on an
    ungrounded call, and this call declares no tools. What it buys is that if
    it ever does happen here, the error names the model's defect instead of
    arriving as "no JSON object in the model reply", which reads as a prompt
    problem and sends the reader to rewrite a prompt that is fine.

    Note what is *not* consulted: ``finishReason``. The fleet's real-world
    symptom is a ``STOP`` finish on a reply that begins mid-object, so a
    normal finish reason is no evidence of a complete answer.

    This is stricter than parse.py, which tolerates prose around the object.
    Deliberate, and only here: the request sets
    ``responseMimeType: application/json``, so a reply that opens with prose
    is already off-contract, and reading "does not start with {" as the
    defect is the more useful diagnosis of the two.
    """
    body = text.strip()
    fenced = _FENCE.match(body)
    if fenced:
        body = fenced.group(1).strip()
    if body[:1] not in ("{", "["):
        raise HeadTruncatedResponse(
            "the model's answer does not begin with a JSON object or array -- its "
            f"opening is missing (the reply starts {body[:80]!r}). This is the signature "
            "of the head-truncation defect measured on grounded gemini-3.7-flash calls: "
            "not a prompt problem and not the token cap, so the remedy is the model or "
            "the call shape, not max_output_tokens."
        )


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
    # Billed output is the answer *plus* the thinking. ``candidatesTokenCount``
    # EXCLUDES thoughts, measured live on both gemini-3.1-pro-preview and
    # gemini-3.7-flash: on every one of ~10 calls across the two models,
    # `promptTokenCount + candidatesTokenCount + thoughtsTokenCount` reconciled
    # to `totalTokenCount` exactly (e.g. 9 + 4 + 68 == 81), and it reconciles
    # *only* when thoughts are added. The inherited comment here -- copied from
    # agents/lib/gemini_loop.mjs:150, which says the opposite -- is wrong at all
    # five fleet call sites that repeat it, and the error is not marginal:
    # real generation calls book ~800 answer tokens against 1,300-2,700
    # thinking tokens, so billing candidates alone understates output ~3x.
    output_tokens = int(usage.get("candidatesTokenCount") or 0) + int(
        usage.get("thoughtsTokenCount") or 0
    )

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
    # After the MAX_TOKENS branch, which is the API telling us about the tail;
    # this one is about the head, and no finish reason reports it.
    assert_head_intact(text)
    return LLMResponse(
        text=text,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=estimate_cost_usd(input_tokens, output_tokens, model=model),
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
