"""Fakes for the editorial-ingest route tests: no network, no Cloud Tasks,
no warehouse, no Gemini."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from tt_services_lib.gemini import LLMResponse

from editorial_ingest.tasks import EnqueueError


@dataclass
class FakeTaskQueue:
    """Holds tasks by name. Refuses a second task with a name it already
    holds, as Cloud Tasks does."""

    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail: bool = False

    def enqueue(self, name: str, payload: dict[str, Any]) -> bool:
        if self.fail:
            raise EnqueueError("queue unavailable")
        if name in self.tasks:
            return False
        self.tasks[name] = payload
        return True


def fake_fetch(statuses: dict[str, int | Exception]):
    """A URL fetcher answering from a table: url -> HTTP status, or an
    exception to raise (a network error / timeout). Unknown URLs answer 200."""

    def fetch(url: str) -> tuple[str, int, str | None]:
        answer = statuses.get(url, 200)
        if isinstance(answer, Exception):
            raise answer
        return url, answer, None

    return fetch


@dataclass
class RoutingFakeSnowflake:
    """Answers by which statement it was handed (prediction's matching_fakes
    pattern), so a test asserts on what reached Snowflake, not on call order.
    ``candidate`` is the STG_TREND_CANDIDATES row the handler finds, if any."""

    candidate: dict[str, Any] | None = None
    trend_id: str = "trend-new-1"
    calls: list[tuple[str, Mapping[str, Any] | None]] = field(default_factory=list)

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        self.calls.append((sql, params))
        upper = sql.upper()
        if "PROC_PROMOTION_APPLY" in upper:
            decision = json.loads(params["decisions"])[0]
            result = {
                "candidate_id": decision["candidate_id"],
                "decision": decision["decision"],
                "target_trend_id": self.trend_id,
                "status": "ok",
            }
            return [{"PROC_PROMOTION_APPLY": json.dumps({"results": [result]})}]
        if "MERGE_EXTERNAL_SIGNALS" in upper:
            return [{"MERGE_EXTERNAL_SIGNALS": json.dumps({"batches": 1, "signals": 1})}]
        if "DIM_LLM_PROMPT" in upper:
            return [{"TEMPLATE": "Write the trend topic.", "VERSION": 1}]
        if "FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES" in upper:
            return [dict(self.candidate)] if self.candidate else []
        raise AssertionError(f"unexpected query: {sql[:160]}")

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        self.calls.append((sql, params))
        return 1

    def statements(self, needle: str) -> list[str]:
        return [sql for sql, _ in self.calls if needle in sql.upper()]


@dataclass
class FakeLLM:
    reply: str = '{"topic": "Tinned fish boards replacing charcuterie at house parties"}'
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        return LLMResponse(
            text=self.reply, model="fake-model", input_tokens=10, output_tokens=5, cost_usd=0.0
        )
