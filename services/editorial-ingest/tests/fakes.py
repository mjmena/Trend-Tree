"""Fakes for the editorial-ingest route tests: no network, no Cloud Tasks,
no warehouse, no Gemini."""

from __future__ import annotations

import json
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from procedure_database import ProcedureDatabase
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
    # The sameness judgment's neighbor pool (the EMBED_TEXT_1024 query's rows).
    neighbors: list[dict[str, Any]] = field(default_factory=list)
    calls: list[tuple[str, Mapping[str, Any] | None]] = field(default_factory=list)

    def __post_init__(self):
        self._tempdir = tempfile.TemporaryDirectory()
        self.database = ProcedureDatabase(self._tempdir.name + "/receipts.db")
        if self.candidate:
            with self.database.connect() as conn:
                conn.execute(
                    """INSERT INTO STG_TREND_CANDIDATES
                             (CANDIDATE_ID, TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID)
                             VALUES (?, ?, ?, ?, ?)""",
                    (
                        "nom-123",
                        self.candidate["TOPIC"],
                        self.candidate.get("PROMOTED_AT"),
                        self.candidate.get("PROMOTED_TO"),
                        self.candidate.get("DEDUP_OF_TREND_ID"),
                    ),
                )

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        self.calls.append((sql, params))
        upper = sql.upper()
        if "PROC_EDITORIAL_NOMINATION" in upper:
            return self.database.query(sql, params)
        if "PROC_PROMOTION_APPLY" in upper:
            decision = json.loads(params["decisions"])[0]
            target = decision.get("target_trend_id") or self.trend_id
            with self.database.connect() as conn:
                conn.execute(
                    """UPDATE STG_TREND_CANDIDATES
                             SET PROMOTED_AT = CURRENT_TIMESTAMP, PROMOTED_TO = ?,
                                 DEDUP_OF_TREND_ID = ? WHERE CANDIDATE_ID = ?""",
                    (target, decision.get("target_trend_id"), decision["candidate_id"]),
                )
            result = {
                "candidate_id": decision["candidate_id"],
                "decision": decision["decision"],
                "target_trend_id": target,
                "status": "ok",
            }
            return [{"PROC_PROMOTION_APPLY": json.dumps({"results": [result]})}]
        if "EMBED_TEXT_1024" in upper:
            return [dict(n) for n in self.neighbors]
        if "MERGE_EXTERNAL_SIGNALS" in upper:
            return [{"MERGE_EXTERNAL_SIGNALS": json.dumps({"batches": 1, "signals": 1})}]
        if "DIM_LLM_PROMPT" in upper:
            return [{"TEMPLATE": "Write the trend topic.", "VERSION": 1}]
        if "FROM MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES" in upper:
            with self.database.connect() as conn:
                cursor = conn.execute(
                    """SELECT TOPIC, PROMOTED_AT, PROMOTED_TO, DEDUP_OF_TREND_ID
                                     FROM STG_TREND_CANDIDATES WHERE CANDIDATE_ID = ?""",
                    [params["id"]],
                )
                return [
                    dict(zip([c[0] for c in cursor.description], row, strict=True))
                    for row in cursor
                ]
        raise AssertionError(f"unexpected query: {sql[:160]}")

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        self.calls.append((sql, params))
        return 1

    def statements(self, needle: str) -> list[str]:
        return [sql for sql, _ in self.calls if needle in sql.upper()]


@dataclass
class FakeLLM:
    reply: str = '{"topic": "Tinned fish boards replacing charcuterie at house parties"}'
    fail_with: Exception | None = None
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        if self.fail_with is not None:
            raise self.fail_with
        return LLMResponse(
            text=self.reply, model="fake-model", input_tokens=10, output_tokens=5, cost_usd=0.0
        )
