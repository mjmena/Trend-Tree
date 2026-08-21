"""In-memory Snowflake stand-in for route tests -- no warehouse, no network.
Mirrors prism's tests/fakes.py FakeSnowflake shape."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from prediction_service.generation.llm import DEFAULT_MODEL, LLMResponse, estimate_cost_usd


@dataclass
class RecordedCall:
    sql: str
    params: Mapping[str, Any] | None
    #: "query" (a read) or "execute" (DML). The blindness tests key off this:
    #: the generation phase may only ever produce reads, and only of the
    #: signal corpus (tests/test_blindness.py).
    kind: str = "execute"


@dataclass
class FakeSnowflake:
    calls: list[RecordedCall] = field(default_factory=list)
    #: Set to make the next execute() raise, to exercise a write-failure path.
    fail_with: Exception | None = None
    #: What execute() reports as affected rows. 0 models a MERGE that matched
    #: an existing PREDICTION_EVAL_ID (a deduplicated retry).
    rowcount: int = 1

    #: Rows the next query() returns. The generation phase reads FCT_SIGNALS
    #: through this.
    rows: list[dict[str, Any]] = field(default_factory=list)

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        self.calls.append(RecordedCall(sql, params, kind="query"))
        return list(self.rows)

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        self.calls.append(RecordedCall(sql, params, kind="execute"))
        if self.fail_with:
            raise self.fail_with
        return self.rowcount

    @property
    def last(self) -> RecordedCall:
        return self.calls[-1]


@dataclass
class FakePredictionLLM:
    """The generation phase's LLM seam, filled in (CRMA-763). Returns a canned
    reply so every generation test runs offline; records what it was asked so
    a test can assert the corpus reached the prompt."""

    reply: str = "{\"predictions\": []}"
    #: Set to make complete() raise -- exercises the failure path.
    fail_with: Exception | None = None
    model: str = "fake-model"
    input_tokens: int = 1200
    output_tokens: int = 300
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        if self.fail_with:
            raise self.fail_with
        return LLMResponse(
            text=self.reply,
            model=self.model,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            # Billed at the real default model, not at `self.model`: these
            # fakes answer to an id no rate table knows, and the point of
            # these tests is that the cost *reaches* the caller. The
            # unpriced-model path has its own coverage in test_llm.py.
            cost_usd=estimate_cost_usd(
                self.input_tokens, self.output_tokens, model=DEFAULT_MODEL
            ),
        )

    @property
    def last_user_prompt(self) -> str:
        return self.calls[-1][1]

    @property
    def last_system_prompt(self) -> str:
        return self.calls[-1][0]


@dataclass
class ShufflingPredictionLLM:
    """A fake that behaves the way the real one does: **differently every
    call**.

    Generation calls Gemini at temperature 1.0, so a re-fire does not
    reproduce the previous run's claims or their order. A deterministic fake
    cannot show whether idempotency survives that -- it pins a property the
    real system does not have. This one rotates the order of its replies and
    swaps in a fresh claim each call, so a test can assert what re-firing the
    same chain_id actually does.

    ``replies`` is a list of the prediction dicts, in "first call" order.
    """

    replies: list[dict[str, Any]] = field(default_factory=list)
    #: Appended (one per call, in order) so each call also emits something
    #: the previous call did not.
    novel: list[dict[str, Any]] = field(default_factory=list)
    model: str = "fake-model"
    input_tokens: int = 1200
    output_tokens: int = 300
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        import json as _json

        turn = len(self.calls)
        self.calls.append((system, user))
        rotated = self.replies[turn % len(self.replies) :] + self.replies[
            : turn % len(self.replies)
        ]
        predictions = list(rotated)
        if turn < len(self.novel):
            predictions.insert(0, self.novel[turn])
        return LLMResponse(
            text=_json.dumps({"predictions": predictions}),
            model=self.model,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            # Billed at the real default model, not at `self.model`: these
            # fakes answer to an id no rate table knows, and the point of
            # these tests is that the cost *reaches* the caller. The
            # unpriced-model path has its own coverage in test_llm.py.
            cost_usd=estimate_cost_usd(
                self.input_tokens, self.output_tokens, model=DEFAULT_MODEL
            ),
        )

    @property
    def last_user_prompt(self) -> str:
        return self.calls[-1][1]

    @property
    def last_system_prompt(self) -> str:
        return self.calls[-1][0]
