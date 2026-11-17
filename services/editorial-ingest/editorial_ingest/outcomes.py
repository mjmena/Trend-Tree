"""Durable nomination receipts and the Snowflake persistence boundary."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from tt_services_lib.snowflake_client import SnowflakeClient


class ThreadLocalSnowflakeClient:
    """Keep concurrent requests on separate connector transaction scopes."""

    def __init__(self, factory: Callable[[], SnowflakeClient]) -> None:
        self.factory = factory
        self.local = threading.local()

    def _client(self) -> SnowflakeClient:
        if not hasattr(self.local, "client"):
            self.local.client = self.factory()
        return self.local.client

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        return self._client().query(sql, params)

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        return self._client().execute(sql, params)


@dataclass(frozen=True)
class Receipt:
    nomination_id: str
    request: dict[str, Any]
    dropped_urls: list[dict[str, Any]]
    status: str
    trend_id: str | None
    error: dict[str, str] | None
    created_at: str
    updated_at: str
    owner: str | None = None
    lease_until: str | None = None
    queue_confirmed_at: str | None = None
    plan: dict[str, Any] | None = None

    @property
    def terminal(self) -> bool:
        return self.status != "pending"

    def snapshot(self) -> dict[str, Any]:
        return {
            "nomination_id": self.nomination_id,
            "status": self.status,
            "trend_id": self.trend_id,
            "dropped_urls": self.dropped_urls,
            "status_url": f"/nominations/{self.nomination_id}",
            "error": self.error,
        }


class SnowflakeNominationStore:
    def __init__(self, snowflake: SnowflakeClient) -> None:
        self.snowflake = snowflake

    def _call(self, operation: str, nid: str, **data: Any) -> Receipt | None:
        rows = self.snowflake.query(
            "CALL MCC_RAW.MARKETING_DEV.PROC_EDITORIAL_NOMINATION("
            "%(operation)s, %(id)s, PARSE_JSON(%(data)s))",
            {"operation": operation, "id": nid, "data": json.dumps(data)},
        )
        value = rows[0]["PROC_EDITORIAL_NOMINATION"]
        value = json.loads(value) if isinstance(value, str) else value
        return Receipt(**value) if value else None

    def accept(self, payload: dict[str, Any], dropped_urls: list[dict[str, Any]]) -> Receipt:
        return self._call(
            "accept", payload["nomination_id"], request=payload, dropped_urls=dropped_urls
        )

    def get(self, nomination_id: str) -> Receipt | None:
        return self._call("get", nomination_id)

    def claim(self, nomination_id: str, owner: str) -> Receipt | None:
        return self._call("claim", nomination_id, owner=owner)

    def save_plan(self, nomination_id: str, owner: str, plan: dict[str, Any]) -> Receipt:
        return self._call("plan", nomination_id, owner=owner, plan=plan)

    def attempt_failed(self, nomination_id: str, owner: str) -> Receipt:
        return self._call("attempt_failed", nomination_id, owner=owner)

    def mark_queued(self, nomination_id: str) -> Receipt:
        return self._call("queued", nomination_id)

    def reconcile_missing(self, nomination_id: str) -> Receipt:
        return self._call("reconcile", nomination_id)

    def complete(self, nomination_id: str, owner: str) -> Receipt:
        return self._call("complete", nomination_id, owner=owner)

    def prepare(self, nomination_id: str, owner: str, signals: list[dict[str, Any]]) -> Receipt:
        return self._call("prepare", nomination_id, owner=owner, signals=signals)
