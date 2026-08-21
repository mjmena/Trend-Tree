"""In-memory Snowflake stand-in for route tests -- no warehouse, no network.
Mirrors prism's tests/fakes.py FakeSnowflake shape."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass
class RecordedCall:
    sql: str
    params: Mapping[str, Any] | None


@dataclass
class FakeSnowflake:
    calls: list[RecordedCall] = field(default_factory=list)
    #: Set to make the next execute() raise, to exercise a write-failure path.
    fail_with: Exception | None = None
    #: What execute() reports as affected rows. 0 models a MERGE that matched
    #: an existing PREDICTION_EVAL_ID (a deduplicated retry).
    rowcount: int = 1

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        self.calls.append(RecordedCall(sql, params))
        return []

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        self.calls.append(RecordedCall(sql, params))
        if self.fail_with:
            raise self.fail_with
        return self.rowcount

    @property
    def last(self) -> RecordedCall:
        return self.calls[-1]
